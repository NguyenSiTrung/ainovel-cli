/**
 * Run control orchestration for the task-5 screens.
 *
 * Two responsibilities, both strictly bounded by the protocol contract:
 *
 * 1. `deriveRunControls` — a PURE projection that decides which controls the
 *    UI may offer, computed only from backend-reported state (the engine
 *    snapshot's `running`/advance fields and observed run.* event facts).
 *    No workflow transitions are encoded here: availability describes what
 *    the engine last reported, never what it "should" do next.
 *
 * 2. Command actions (`startRunFromUi`, …) — issue exactly one protocol
 *    request through the API layer, track pending state for the button, and
 *    surface structured errors through the existing presentation. The UI
 *    never advances run state locally; every status change arrives as a
 *    run.* event from the engine.
 *
 * Semantics honored (task-2 daemon mapping):
 * - `run.start {goal}` returns an ACCEPTANCE; the outcome arrives async as
 *   run.started / run.failed (e.g. start-over-existing-book is accepted then
 *   failed via events).
 * - `run.pause` and `run.abort` both pause the engine (Host.Abort).
 * - `run.continue` / `run.retry` resume from persisted state (Host.Resume);
 *   retry is offered after an observed failure.
 * - `run.advance_one_chapter` is the explicit one-chapter authorization for
 *   chapter-gate pauses the engine reports (`has_advance_hold` on the
 *   snapshot / `advance_hold` on run.paused).
 */

import { get, writable, type Writable } from 'svelte/store';

import {
  runAbort,
  runAdvanceOneChapter,
  runContinue,
  runPause,
  runRetry,
  runSetAdvanceMode,
  runStart,
  runSteer,
  type AdvanceMode,
} from '$lib/api/desktop';
import {
  connectionState,
  projectSnapshot,
  refreshSnapshot,
  reportError,
  runState,
} from '$lib/stores/desktop';
import type { ConnectionState, ProjectSnapshot, RunState } from '$lib/types/protocol';

// ---------------------------------------------------------------------------
// Availability projection (pure; backend state in, flags out)
// ---------------------------------------------------------------------------

export interface RunControlAvailability {
  /** A project is open (snapshot present). */
  projectOpen: boolean;
  /** The engine bridge is usable right now. */
  engineReady: boolean;
  /** The engine reports an active run (snapshot.running or observed run.started). */
  engineRunning: boolean;
  /** Start a fresh run with a goal. */
  canStart: boolean;
  /** Continue after pause/completion (engine resume-from-facts). */
  canContinue: boolean;
  /** Send a steering instruction mid-run. */
  canSteer: boolean;
  /** Pause the engine (gentle stop; resumable). */
  canPause: boolean;
  /** Abort the engine's current run. */
  canAbort: boolean;
  /** Retry after an observed run failure (resume from persisted state). */
  canRetry: boolean;
  /** Explicitly authorize exactly one more chapter at a review gate. */
  canAuthorizeChapter: boolean;
  /** Current advance mode as last reported by the engine (null: unknown). */
  advanceMode: AdvanceMode | null;
  /** True when the engine reports a pending steer instruction. */
  pendingSteer: boolean;
}

function normalizeAdvanceMode(snapshot: ProjectSnapshot | null): AdvanceMode | null {
  const raw = snapshot?.advance_mode;
  if (raw === 'auto' || raw === 'review') return raw;
  if (raw === 'manual') return 'review'; // engine treats manual as review-gated
  return null;
}

export function deriveRunControls(
  snapshot: ProjectSnapshot | null,
  run: RunState,
  connection: ConnectionState,
): RunControlAvailability {
  const projectOpen = snapshot !== null;
  const engineReady = connection === 'ready' || connection === 'degraded';
  // Two independent backend signals for "a run is active": the engine's own
  // snapshot flag and the observed run.started (…terminal) event facts.
  const engineRunning = snapshot?.running === true || run.status === 'running';
  const holdPresent = snapshot?.has_advance_hold === true || run.pause?.advanceHold === true;
  // Has the project produced (or resumed into) work the engine could pick
  // up with a no-arg continue? Backend fields only: observed prior run
  // state, completed chapters, or the engine's own recovery label.
  const hasResumableWork =
    run.status === 'paused' ||
    run.status === 'completed' ||
    run.status === 'aborted' ||
    run.status === 'failed' ||
    (snapshot?.completed_chapters ?? 0) > 0 ||
    typeof snapshot?.recovery_label === 'string';

  return {
    projectOpen,
    engineReady,
    engineRunning,
    canStart: projectOpen && engineReady && !engineRunning,
    canContinue: projectOpen && engineReady && !engineRunning && hasResumableWork,
    canSteer: projectOpen && engineReady && engineRunning,
    canPause: projectOpen && engineReady && engineRunning,
    canAbort: projectOpen && engineReady && engineRunning,
    canRetry: projectOpen && engineReady && !engineRunning && run.status === 'failed',
    canAuthorizeChapter: projectOpen && engineReady && !engineRunning && holdPresent,
    advanceMode: normalizeAdvanceMode(snapshot),
    pendingSteer: snapshot?.pending_steer === true,
  };
}

// ---------------------------------------------------------------------------
// Pending/confirmation state (UI affordances only, never run state)
// ---------------------------------------------------------------------------

export type RunControlKind =
  | 'start'
  | 'continue'
  | 'steer'
  | 'pause'
  | 'abort'
  | 'retry'
  | 'authorize-chapter'
  | 'advance-mode';

/** Which controls have a request in flight (button busy state). */
export const pendingRunControls: Writable<Partial<Record<RunControlKind, boolean>>> = writable({});

export interface RunControlOutcome {
  kind: RunControlKind;
  ok: boolean;
  at: number;
  message?: string;
  code?: string;
}

/** Last command outcome, for inline confirmation/error lines in the UI. */
export const lastRunControlOutcome: Writable<RunControlOutcome | null> = writable(null);

function availability(): RunControlAvailability {
  return deriveRunControls(get(projectSnapshot), get(runState), get(connectionState));
}

async function issue(
  kind: RunControlKind,
  allowed: boolean,
  confirmMessage: string,
  call: () => Promise<unknown>,
): Promise<boolean> {
  if (!allowed) return false; // Guarded by backend state, not trust in the UI.
  pendingRunControls.update((all) => ({ ...all, [kind]: true }));
  try {
    await call();
    lastRunControlOutcome.set({ kind, ok: true, at: Date.now(), message: confirmMessage });
    return true;
  } catch (raw) {
    const structured = reportError(raw, `run control (${kind})`);
    lastRunControlOutcome.set({
      kind,
      ok: false,
      at: Date.now(),
      code: structured.code,
      message: structured.message,
    });
    return false;
  } finally {
    pendingRunControls.update((all) => {
      const next = { ...all };
      delete next[kind];
      return next;
    });
  }
}

// ---------------------------------------------------------------------------
// Actions — one protocol request each; outcomes arrive as events
// ---------------------------------------------------------------------------

/** Start a run. Acceptance only: run.started/run.failed arrive as events. */
export function startRunFromUi(goal: string): Promise<boolean> {
  const trimmed = goal.trim();
  return issue(
    'start',
    availability().canStart && trimmed !== '',
    'run accepted — progress arrives as engine events',
    () => runStart(trimmed === '' ? undefined : trimmed),
  );
}

/** Continue the story (engine resume-from-facts; no text argument in v1). */
export function continueRunFromUi(): Promise<boolean> {
  return issue('continue', availability().canContinue, 'continue accepted', () => runContinue());
}

/** Retry after failure ≈ resume from persisted state (same engine control). */
export function retryRunFromUi(): Promise<boolean> {
  return issue('retry', availability().canRetry, 'retry accepted', () => runRetry());
}

/** Steer the active run with a natural-language instruction. */
export function steerRunFromUi(instruction: string): Promise<boolean> {
  const trimmed = instruction.trim();
  return issue(
    'steer',
    availability().canSteer && trimmed !== '',
    'steering instruction applied',
    () => runSteer(trimmed),
  );
}

/** Pause the engine (run.pause maps to the engine's abort/pause control). */
export function pauseRunFromUi(): Promise<boolean> {
  return issue('pause', availability().canPause, 'pause requested', () => runPause());
}

/** Abort the engine's current run (terminal run.aborted event follows). */
export function abortRunFromUi(reason?: string): Promise<boolean> {
  return issue('abort', availability().canAbort, 'abort requested', () => runAbort(reason ?? 'user abort'));
}

/**
 * Explicitly authorize exactly one more chapter at a review gate. The gate's
 * existence is backend-reported (`has_advance_hold` / run.paused advance_hold).
 */
export function authorizeOneChapterFromUi(): Promise<boolean> {
  return issue('authorize-chapter', availability().canAuthorizeChapter, 'one chapter authorized', () =>
    runAdvanceOneChapter(),
  );
}

/**
 * Switch advance mode. The engine owns the value: after acceptance the
 * snapshot is refetched so the toggle reflects the engine's advance_mode,
 * never a local echo.
 */
export async function setAdvanceModeFromUi(mode: AdvanceMode): Promise<boolean> {
  const avail = availability();
  const allowed = avail.projectOpen && avail.engineReady && avail.advanceMode !== mode;
  const ok = await issue('advance-mode', allowed, `advance mode set to ${mode}`, () => runSetAdvanceMode(mode));
  if (ok) await refreshSnapshot().catch(() => undefined);
  return ok;
}

/** Reset transient control state (tests / disposal). */
export function resetRunControls(): void {
  pendingRunControls.set({});
  lastRunControlOutcome.set(null);
}
