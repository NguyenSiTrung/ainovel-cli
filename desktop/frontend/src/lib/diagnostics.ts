/**
 * Diagnostics orchestration for the task-8 Diagnostics screen.
 *
 * OBSERVER-ONLY by contract: this module issues exactly four read/export
 * methods — `diagnostics.snapshot`, `diagnostics.export`, `logs.replay`,
 * `runtime.queue` — and never repairs, resumes, aborts, or otherwise mutates
 * engine state. Repairs and resume are explicit user actions on other
 * screens; diagnostics observes and reports.
 *
 * Contract honored (task-2 adapter mapping + README §6/§8):
 * - `diagnostics.export` writes a SANITIZED bundle engine-side (the sanitizer
 *   is part of the binding contract). The UI only contributes a destination
 *   path STRING from the native save dialog, forwarded verbatim. The `include`
 *   filter has no engine support, so it is never sent (default = every
 *   sanitized section). The response `{output_path, sanitized, findings}` and
 *   the `diagnostics.completed` event are the observed outcomes.
 * - `logs.replay {after_sequence?, limit?, level?}` replays the daemon's
 *   buffered structured logs; `level` is a MINIMUM severity filter; records
 *   are already redacted engine-side and are rendered verbatim, never
 *   re-derived. A pull-based full view (after_sequence 0) is used so the
 *   filter re-runs server-side on every refresh.
 * - `runtime.queue` is the persisted ReplayQueue projection (log replay's
 *   companion view).
 * - All four require an open project; `project_unavailable` resets silently.
 */

import { get, writable, type Writable } from 'svelte/store';

import {
  diagnosticsExport,
  diagnosticsSnapshot,
  logsReplay,
  runtimeQueue,
  type DiagnosticsSnapshotResult,
  type LogRecord,
  type RuntimeQueueItem,
} from '$lib/api/desktop';
import { pickSaveTarget } from '$lib/api/dialogs';
import {
  onEngineSessionChange,
  projectSnapshot,
  reportError,
} from '$lib/stores/desktop';
import type { StructuredError } from '$lib/types/protocol';

/** Sanitized diagnostics bundles are JSON (diag.Export's fixed product). */
export const DIAGNOSTICS_EXPORT_FILTERS = [{ name: 'Diagnostics bundle', extensions: ['json'] }];

/** Severity choices offered for the log view ("" = everything). */
export const LOG_LEVEL_FILTERS = ['', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevelFilter = (typeof LOG_LEVEL_FILTERS)[number];

// ---------------------------------------------------------------------------
// Projection state
// ---------------------------------------------------------------------------

export interface DiagnosticsExportState {
  status: 'idle' | 'picking' | 'exporting';
  /** Last completed export (engine facts only). */
  result: {
    path: string | null;
    sanitized: boolean;
    findings: number | undefined;
    at: number;
  } | null;
  error: StructuredError | null;
}

export interface DiagnosticsState {
  status: 'idle' | 'loading' | 'ready';
  snapshot: DiagnosticsSnapshotResult | null;
  error: StructuredError | null;
  fetchedAt: number | null;
  exportFlow: DiagnosticsExportState;
  queue: {
    status: 'idle' | 'loading' | 'ready';
    items: RuntimeQueueItem[];
    count: number | undefined;
    error: StructuredError | null;
    fetchedAt: number | null;
  };
  logs: {
    status: 'idle' | 'loading' | 'ready';
    records: LogRecord[];
    count: number | undefined;
    lastSequence: number | undefined;
    level: LogLevelFilter;
    error: StructuredError | null;
    fetchedAt: number | null;
  };
}

function initialDiagnosticsState(): DiagnosticsState {
  return {
    status: 'idle',
    snapshot: null,
    error: null,
    fetchedAt: null,
    exportFlow: { status: 'idle', result: null, error: null },
    queue: { status: 'idle', items: [], count: undefined, error: null, fetchedAt: null },
    logs: {
      status: 'idle',
      records: [],
      count: undefined,
      lastSequence: undefined,
      level: '',
      error: null,
      fetchedAt: null,
    },
  };
}

export const diagnosticsState: Writable<DiagnosticsState> = writable(initialDiagnosticsState());

// ---------------------------------------------------------------------------
// Actions — one read/export protocol request each; never a mutation
// ---------------------------------------------------------------------------

function readError(raw: unknown, context: string): StructuredError {
  return reportError(raw, context);
}

/** True when a rejection simply means "no project open" (silent reset). */
function isProjectUnavailable(structured: StructuredError): boolean {
  return structured.code === 'project_unavailable';
}

/** Fetch the diagnostics snapshot (findings, stats, runtime view). */
export async function refreshDiagnostics(): Promise<boolean> {
  diagnosticsState.update((s) => ({ ...s, status: 'loading', error: null }));
  try {
    const snapshot = await diagnosticsSnapshot();
    diagnosticsState.update((s) => ({
      ...s,
      status: 'ready',
      snapshot,
      fetchedAt: Date.now(),
      error: null,
    }));
    return true;
  } catch (raw) {
    const structured = readError(raw, 'diagnostics.snapshot');
    if (isProjectUnavailable(structured)) {
      diagnosticsState.set(initialDiagnosticsState());
      return false;
    }
    diagnosticsState.update((s) => ({ ...s, status: 'idle', error: structured }));
    return false;
  }
}

/** Fetch the persisted runtime event-queue projection. */
export async function refreshRuntimeQueue(): Promise<boolean> {
  diagnosticsState.update((s) => ({ ...s, queue: { ...s.queue, status: 'loading', error: null } }));
  try {
    const result = await runtimeQueue();
    diagnosticsState.update((s) => ({
      ...s,
      queue: {
        status: 'ready',
        items: result.items ?? [],
        count: result.count,
        error: null,
        fetchedAt: Date.now(),
      },
    }));
    return true;
  } catch (raw) {
    const structured = readError(raw, 'runtime.queue');
    if (isProjectUnavailable(structured)) {
      diagnosticsState.update((s) => ({ ...s, queue: initialDiagnosticsState().queue }));
      return false;
    }
    diagnosticsState.update((s) => ({ ...s, queue: { ...s.queue, status: 'idle', error: structured } }));
    return false;
  }
}

/**
 * Replay the daemon's buffered structured logs with a minimum-severity
 * filter. A full pull (after_sequence 0) keeps the server-side filter
 * authoritative on every refresh.
 */
export async function refreshLogs(level?: LogLevelFilter): Promise<boolean> {
  const effective: LogLevelFilter = level ?? get(diagnosticsState).logs.level;
  diagnosticsState.update((s) => ({
    ...s,
    logs: { ...s.logs, status: 'loading', level: effective, error: null },
  }));
  try {
    const result = await logsReplay(0, undefined, effective === '' ? undefined : effective);
    diagnosticsState.update((s) => ({
      ...s,
      logs: {
        status: 'ready',
        records: result.records ?? [],
        count: result.count,
        lastSequence: result.last_sequence,
        level: effective,
        error: null,
        fetchedAt: Date.now(),
      },
    }));
    return true;
  } catch (raw) {
    const structured = readError(raw, 'logs.replay');
    if (isProjectUnavailable(structured)) {
      diagnosticsState.update((s) => ({ ...s, logs: initialDiagnosticsState().logs }));
      return false;
    }
    diagnosticsState.update((s) => ({ ...s, logs: { ...s.logs, status: 'idle', error: structured } }));
    return false;
  }
}

/**
 * Export the sanitized diagnostics bundle: native save dialog, then ONE
 * `diagnostics.export` request with the chosen path string forwarded
 * verbatim. A cancelled picker sends nothing and is not an error. The engine
 * sanitizes; the UI never assembles bundle content itself.
 */
export async function exportDiagnosticsFromUi(): Promise<boolean> {
  const flow = get(diagnosticsState).exportFlow;
  if (flow.status !== 'idle') return false;
  diagnosticsState.update((s) => ({ ...s, exportFlow: { status: 'picking', result: null, error: null } }));
  let destination: string | null;
  try {
    destination = await pickSaveTarget({
      title: 'Save the sanitized diagnostics bundle',
      defaultPath: 'diagnostics-bundle.json',
      filters: DIAGNOSTICS_EXPORT_FILTERS,
    });
  } catch (raw) {
    const structured = reportError(raw, 'diagnostics destination');
    diagnosticsState.update((s) => ({ ...s, exportFlow: { status: 'idle', result: null, error: structured } }));
    return false;
  }
  if (destination === null) {
    diagnosticsState.update((s) => ({ ...s, exportFlow: { status: 'idle', result: null, error: null } }));
    return false;
  }

  diagnosticsState.update((s) => ({ ...s, exportFlow: { status: 'exporting', result: null, error: null } }));
  try {
    const result = await diagnosticsExport(destination);
    diagnosticsState.update((s) => ({
      ...s,
      exportFlow: {
        status: 'idle',
        result: {
          path: result.output_path ?? destination,
          sanitized: result.sanitized !== false,
          findings: result.findings,
          at: Date.now(),
        },
        error: null,
      },
    }));
    return true;
  } catch (raw) {
    const structured = reportError(raw, 'diagnostics.export');
    diagnosticsState.update((s) => ({ ...s, exportFlow: { status: 'idle', result: null, error: structured } }));
    return false;
  }
}

/** Dismiss the last export result/error. */
export function dismissDiagnosticsExport(): void {
  diagnosticsState.update((s) => ({ ...s, exportFlow: { status: 'idle', result: null, error: null } }));
}

/** Refresh every diagnostics view (snapshot + queue + logs + shared usage). */
export async function refreshAllDiagnostics(): Promise<void> {
  await Promise.all([refreshDiagnostics(), refreshRuntimeQueue(), refreshLogs()]);
}

/** Reset all module state (tests / disposal). */
export function resetDiagnosticsState(): void {
  diagnosticsState.set(initialDiagnosticsState());
}

// Project closed: every projection below is project-scoped; drop it.
projectSnapshot.subscribe((snapshot) => {
  if (snapshot === null) resetDiagnosticsState();
});

// Engine restart: the daemon-side log ring and queue died with the process;
// store-backed diagnostics may persist, but the cached copy is stale. Reset —
// the screen refetches on mount/refresh (never mutates anything).
onEngineSessionChange(() => {
  resetDiagnosticsState();
});
