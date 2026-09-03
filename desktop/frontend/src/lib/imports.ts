/**
 * Source-import orchestration for the task-7 Import screen.
 *
 * Contract honored (task-2 daemon mapping, internal/entry/desktop/dispatch.go
 * + internal/host/imp):
 * - `import.start {source_path, options?}` — the source is a single text FILE
 *   (the engine reads and decodes it: UTF-8 / BOM / GB18030; a directory is
 *   rejected engine-side). Returns ACCEPTANCE `{accepted, source_path}`;
 *   progress arrives as `import.progress` events `{stage, completed, total,
 *   detail, level?, retry_at?, error?, continued?}`.
 * - Terminal signals are structural, never message text: payload `stage ===
 *   "done"` (with `continued`) completes; a payload `error` string fails (an
 *   engine.error event follows separately).
 * - Desktop has NO interactive confirm channel (the TUI answers the
 *   awaiting_confirmation stage), so the meaningful path is
 *   `options.auto_confirm: true`; when the engine holds a confirmation for
 *   manual review the awaiting stage's detail is displayed as-is.
 * - `import.resume` (no payload) re-enters the active workspace engine-side;
 *   `import.cancel` answers synchronously `{cancelled}` — `cancelled:false`
 *   with a reason means nothing was running.
 * - On completion the engine published foundation + chapters: the snapshot is
 *   re-read (coalesced) so durable project facts refresh engine-authoritatively.
 *
 * The picked path is a native dialog string forwarded verbatim; the frontend
 * never touches the filesystem.
 */

import { get, writable, type Writable } from 'svelte/store';

import {
  importCancel,
  importResume,
  importStart,
  type ImportAcceptance,
  type ImportOptions,
} from '$lib/api/desktop';
import { pickFile } from '$lib/api/dialogs';
import {
  importProgressEvents,
  onEngineSessionChange,
  projectSnapshot,
  reportError,
  scheduleResync,
} from '$lib/stores/desktop';
import type { ConnectionState, ImportProgressFact, ProjectSnapshot, StructuredError } from '$lib/types/protocol';

export type { ImportOptions };

// ---------------------------------------------------------------------------
// Projection state
// ---------------------------------------------------------------------------

export type ImportStatus =
  | 'idle' // no import observed
  | 'picking' // native source picker open (no request yet)
  | 'starting' // import.start in flight
  | 'resuming' // import.resume in flight
  | 'running' // accepted; progress events arriving
  | 'completed' // terminal stage:"done" observed
  | 'failed' // terminal payload.error observed
  | 'cancelled' // engine answered a cancel with cancelled:true
  | 'interrupted'; // engine session changed mid-run (no terminal event)

export interface ImportProgressLine {
  stage?: string;
  completed?: number;
  total?: number;
  detail?: string;
  level?: string;
  retryAt?: string;
  at: number;
}

export interface ImportState {
  status: ImportStatus;
  /** Source path echoed by the engine acceptance ("" on resume = workspace). */
  sourcePath: string | null;
  /** Latest progress facts (structural fields only). */
  progress: ImportProgressLine | null;
  /** Recent progress lines (bounded) for the activity list. */
  recent: ImportProgressLine[];
  /** Terminal "done" outcome; `continued` = the engine auto-started a run. */
  result: { at: number; continued: boolean; detail?: string } | null;
  error: StructuredError | null;
  /** Informational line (cancel-with-nothing-running reasons, etc.). */
  message: string | null;
  pendingCancel: boolean;
}

const RECENT_LIMIT = 40;

function initialImportState(): ImportState {
  return {
    status: 'idle',
    sourcePath: null,
    progress: null,
    recent: [],
    result: null,
    error: null,
    message: null,
    pendingCancel: false,
  };
}

export const importState: Writable<ImportState> = writable(initialImportState());

// ---------------------------------------------------------------------------
// Availability projection (pure)
// ---------------------------------------------------------------------------

export interface ImportControlAvailability {
  projectOpen: boolean;
  engineReady: boolean;
  /** Pick a source file and start an import. */
  canStart: boolean;
  /** Re-enter the engine's active import workspace. */
  canResume: boolean;
  /** Cancel an in-flight import. */
  canCancel: boolean;
}

export function deriveImportControls(
  state: ImportState,
  snapshot: ProjectSnapshot | null,
  connection: ConnectionState,
): ImportControlAvailability {
  const projectOpen = snapshot !== null;
  const engineReady = connection === 'ready' || connection === 'degraded';
  return {
    projectOpen,
    engineReady,
    canStart: projectOpen && engineReady && !isFlowBusy(state),
    canResume: projectOpen && engineReady && !isFlowBusy(state),
    canCancel: state.status === 'running' && !state.pendingCancel,
  };
}

function isFlowBusy(state: ImportState): boolean {
  return state.status === 'picking' || state.status === 'starting' || state.status === 'resuming';
}

// ---------------------------------------------------------------------------
// Actions — one protocol request each (the picker sends nothing)
// ---------------------------------------------------------------------------

function busy(): boolean {
  return isFlowBusy(get(importState));
}

/**
 * Native source-file picker + `import.start`. A cancelled picker sends
 * nothing and returns to idle (never an error).
 */
export async function startImportFromUi(options: ImportOptions): Promise<boolean> {
  if (busy()) return false;
  importState.update((s) => ({ ...s, status: 'picking', error: null, message: null }));
  let source: string | null;
  try {
    source = await pickFile({
      title: 'Choose the source text file to import',
    });
  } catch (raw) {
    const structured = reportError(raw, 'import source picker');
    importState.update((s) => ({ ...s, status: 'idle', error: structured }));
    return false;
  }
  if (source === null) {
    importState.update((s) => ({ ...s, status: 'idle' }));
    return false;
  }

  importState.update((s) => ({ ...s, status: 'starting', sourcePath: null, result: null, recent: [] }));
  try {
    const acceptance = await importStart(source, options);
    noteAcceptance(acceptance, source);
    return true;
  } catch (raw) {
    const structured = reportError(raw, 'import.start');
    importState.update((s) => ({ ...s, status: 'idle', error: structured }));
    return false;
  }
}

/** Continue the engine's active import workspace (no source argument). */
export async function resumeImportFromUi(): Promise<boolean> {
  if (busy()) return false;
  importState.update((s) => ({ ...s, status: 'resuming', error: null, message: null }));
  try {
    const acceptance = await importResume();
    noteAcceptance(acceptance, null);
    return true;
  } catch (raw) {
    const structured = reportError(raw, 'import.resume');
    importState.update((s) => ({ ...s, status: 'idle', error: structured }));
    return false;
  }
}

/** Terminal statuses an event may have produced while the acceptance
 * response was still in flight (the daemon spawns the drain goroutine
 * before answering): the acceptance must not reopen the flow. */
function isTerminalStatus(status: ImportStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
  );
}

function noteAcceptance(acceptance: ImportAcceptance, picked: string | null): void {
  importState.update((s) => {
    const terminalBeat = isTerminalStatus(s.status);
    return {
      ...s,
      status: terminalBeat ? s.status : 'running',
      sourcePath: acceptance.source_path ?? picked ?? s.sourcePath,
      progress: terminalBeat ? s.progress : null,
      result: terminalBeat ? s.result : null,
      error: terminalBeat ? s.error : null,
    };
  });
}

/**
 * Cancel the in-flight import. `cancelled:false` keeps the current status
 * and surfaces the engine's reason (typically "no import in progress").
 */
export async function cancelImportFromUi(): Promise<boolean> {
  const s = get(importState);
  if (s.pendingCancel || s.status !== 'running') return false;
  importState.update((st) => ({ ...st, pendingCancel: true, error: null, message: null }));
  try {
    const result = await importCancel();
    if (result.cancelled === true) {
      importState.update((st) => ({
        ...st,
        pendingCancel: false,
        status: 'cancelled',
        message: 'import cancelled',
      }));
    } else {
      importState.update((st) => ({
        ...st,
        pendingCancel: false,
        message: result.reason ?? 'no import in progress',
      }));
    }
    return true;
  } catch (raw) {
    const structured = reportError(raw, 'import.cancel');
    importState.update((st) => ({ ...st, pendingCancel: false, error: structured }));
    return false;
  }
}

/** Dismiss the last terminal result/error and return to idle. */
export function dismissImportResult(): void {
  importState.set(initialImportState());
}

/** Reset all module state (tests / disposal). */
export function resetImportState(): void {
  // Project close / engine session change reset the projection but do NOT
  // clear the shared fact store (only disposeDesktop does). Svelte
  // subscribers receive the full array on every append, so a cursor of 0
  // would replay the previous flow's facts onto the fresh projection (e.g.
  // an old stage:"done" completing — and resyncing — the next import).
  // Advance the cursor past everything already recorded instead.
  const facts = get(importProgressEvents);
  lastFactId = facts.length > 0 ? facts[facts.length - 1]!.id : 0;
  importState.set(initialImportState());
}

// ---------------------------------------------------------------------------
// Engine-driven updates (observed facts only)
// ---------------------------------------------------------------------------

let lastFactId = 0;

function isLiveImportStatus(status: ImportStatus): boolean {
  return status === 'starting' || status === 'resuming' || status === 'running' || status === 'cancelled';
}

function noteImportFact(fact: ImportProgressFact): void {
  const s = get(importState);
  // Facts are live while a start/resume is pending (an event may beat the
  // acceptance response — the daemon spawns the drain goroutine first), the
  // run is accepted, or a just-cancelled run may still be corrected by its
  // in-flight terminal. Anything else (idle replays, dismissed results,
  // already-terminal flows) is history, not this flow.
  if (!isLiveImportStatus(s.status)) return;

  const line: ImportProgressLine = {
    stage: fact.stage,
    completed: fact.completed,
    total: fact.total,
    detail: fact.detail,
    level: fact.level,
    retryAt: fact.retryAt,
    at: fact.at,
  };

  if (fact.error !== undefined) {
    // Structural failure signal: the stage errored (engine.error follows).
    importState.update((st) => ({
      ...st,
      status: 'failed',
      progress: line,
      error: {
        code: 'operation_failed',
        message: fact.error ?? 'import failed',
      },
      recent: [...st.recent, line].slice(-RECENT_LIMIT),
    }));
    return;
  }

  if (fact.stage === 'done') {
    importState.update((st) => ({
      ...st,
      status: 'completed',
      progress: line,
      result: { at: fact.at, continued: fact.continued === true, detail: fact.detail },
      recent: [...st.recent, line].slice(-RECENT_LIMIT),
    }));
    // Foundation and chapters were published engine-side: re-read the
    // authoritative snapshot (coalesced) — durable facts must not lag.
    void scheduleResync();
    return;
  }

  importState.update((st) => ({
    ...st,
    progress: line,
    recent: [...st.recent, line].slice(-RECENT_LIMIT),
  }));
}

// Subscriptions live for the module's lifetime (the stores are app-global).
importProgressEvents.subscribe((facts) => {
  for (const fact of facts) {
    if (fact.id > lastFactId) {
      lastFactId = fact.id;
      noteImportFact(fact);
    }
  }
});

// Project closed: the import workspace is gone with it.
projectSnapshot.subscribe((snapshot) => {
  if (snapshot === null && get(importState).status !== 'idle') resetImportState();
});

// Engine restart mid-run: no terminal event will ever arrive for this run.
onEngineSessionChange(() => {
  const s = get(importState);
  if (s.status === 'running') {
    importState.update((st) => ({
      ...st,
      status: 'interrupted',
      message: 'engine session changed mid-import — use resume to re-enter the workspace',
    }));
  }
});
