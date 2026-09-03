/**
 * Simulation (style-imitation) orchestration for the task-7 Simulation
 * screen.
 *
 * Contract honored (task-2 daemon mapping + README §12):
 * - `simulation.start {source_path}` GENUINELY consumes the source: a
 *   `.txt/.md/.markdown` file or a directory containing them is staged into
 *   the project corpus directory `<project>/simulate` (returned as
 *   `engine_source_dir`). Staging ACCUMULATES across runs; same-name sources
 *   replace; unsupported single files are rejected with operation_failed.
 * - `simulation.resume` re-runs the engine over the staged corpus
 *   (incremental merge by content fingerprint); it fails synchronously with
 *   operation_failed when no corpus is staged yet.
 * - `simulation.profile_import {profile_path}` imports a produced profile
 *   JSON file into the project.
 * - All three drain through `simulation.progress` events `{stage, completed,
 *   total, detail, error?}`; terminal signals are structural: `stage ===
 *   "done"` completes, a payload `error` string fails (an engine.error event
 *   follows separately). A single sim operation runs at a time engine-side,
 *   so a terminal fact completes whichever operation this UI observed as
 *   active (simulation run or profile import).
 *
 * The generated profile is STAGED/generated content (it shapes style; it is
 * not a durable book fact) and is presented as such.
 */

import { get, writable, type Writable } from 'svelte/store';

import {
  simulationCancel,
  simulationProfileImport,
  simulationResume,
  simulationStart,
} from '$lib/api/desktop';
import { pickDirectory, pickFile } from '$lib/api/dialogs';
import {
  onEngineSessionChange,
  projectSnapshot,
  reportError,
  scheduleResync,
  simulationProgressEvents,
} from '$lib/stores/desktop';
import type {
  ConnectionState,
  ProjectSnapshot,
  SimulationProgressFact,
  StructuredError,
} from '$lib/types/protocol';

/** Engine-accepted simulation corpus file types (README §12). */
export const SIMULATION_SOURCE_FILTERS = [
  { name: 'Simulation corpus text', extensions: ['txt', 'md', 'markdown'] },
];

/** Produced profiles are JSON files (engine: meta/simulation_profile.json). */
export const SIMULATION_PROFILE_FILTERS = [{ name: 'Simulation profile', extensions: ['json'] }];

// ---------------------------------------------------------------------------
// Projection state
// ---------------------------------------------------------------------------

export type SimulationStatus =
  | 'idle'
  | 'picking' // native source picker open (no request yet)
  | 'starting'
  | 'resuming'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'; // engine session changed mid-run

export interface SimulationProgressLine {
  stage?: string;
  completed?: number;
  total?: number;
  detail?: string;
  at: number;
}

export type ProfileImportStatus = 'idle' | 'picking' | 'importing' | 'completed' | 'failed' | 'interrupted';

export interface ProfileImportState {
  status: ProfileImportStatus;
  /** Profile path echoed by the engine acceptance. */
  profilePath: string | null;
  /** Terminal "done" detail from the shared event channel. */
  detail: string | null;
  error: StructuredError | null;
}

export interface SimulationState {
  status: SimulationStatus;
  /** Last staged source path (acceptance echo; "" on resume). */
  sourcePath: string | null;
  /** The project corpus directory the engine reported (engine fact). */
  corpusDir: string | null;
  progress: SimulationProgressLine | null;
  recent: SimulationProgressLine[];
  /** Terminal "done" outcome (the engine's generated-profile summary). */
  result: { at: number; detail?: string } | null;
  error: StructuredError | null;
  message: string | null;
  pendingCancel: boolean;
  profileImport: ProfileImportState;
}

const RECENT_LIMIT = 40;

function initialProfileImport(): ProfileImportState {
  return { status: 'idle', profilePath: null, detail: null, error: null };
}

function initialSimulationState(): SimulationState {
  return {
    status: 'idle',
    sourcePath: null,
    corpusDir: null,
    progress: null,
    recent: [],
    result: null,
    error: null,
    message: null,
    pendingCancel: false,
    profileImport: initialProfileImport(),
  };
}

export const simulationState: Writable<SimulationState> = writable(initialSimulationState());

// ---------------------------------------------------------------------------
// Availability projection (pure)
// ---------------------------------------------------------------------------

export interface SimulationControlAvailability {
  projectOpen: boolean;
  engineReady: boolean;
  canStartFromFile: boolean;
  canStartFromDirectory: boolean;
  canResume: boolean;
  canCancel: boolean;
  canImportProfile: boolean;
}

export function deriveSimulationControls(
  state: SimulationState,
  snapshot: ProjectSnapshot | null,
  connection: ConnectionState,
): SimulationControlAvailability {
  const projectOpen = snapshot !== null;
  const engineReady = connection === 'ready' || connection === 'degraded';
  const flowBusy = isFlowBusy(state);
  return {
    projectOpen,
    engineReady,
    canStartFromFile: projectOpen && engineReady && !flowBusy,
    canStartFromDirectory: projectOpen && engineReady && !flowBusy,
    canResume: projectOpen && engineReady && !flowBusy,
    canCancel: state.status === 'running' && !state.pendingCancel,
    canImportProfile: projectOpen && engineReady && !flowBusy,
  };
}

function isFlowBusy(state: SimulationState): boolean {
  return (
    state.status === 'picking' ||
    state.status === 'starting' ||
    state.status === 'resuming' ||
    state.profileImport.status === 'picking' ||
    state.profileImport.status === 'importing'
  );
}

function busy(): boolean {
  return isFlowBusy(get(simulationState));
}

// ---------------------------------------------------------------------------
// Actions — one protocol request each (the pickers send nothing)
// ---------------------------------------------------------------------------

/**
 * Pick a simulation source (`.txt/.md/.markdown` file, or a directory whose
 * supported files are staged preserving layout) and start the run.
 */
export async function startSimulationFromUi(sourceKind: 'file' | 'directory'): Promise<boolean> {
  if (busy()) return false;
  simulationState.update((s) => ({ ...s, status: 'picking', error: null, message: null }));
  let source: string | null;
  try {
    source =
      sourceKind === 'directory'
        ? await pickDirectory({ title: 'Choose a folder of simulation sources' })
        : await pickFile({
            title: 'Choose a simulation source (.txt / .md / .markdown)',
            filters: SIMULATION_SOURCE_FILTERS,
          });
  } catch (raw) {
    const structured = reportError(raw, 'simulation source picker');
    simulationState.update((s) => ({ ...s, status: 'idle', error: structured }));
    return false;
  }
  if (source === null) {
    simulationState.update((s) => ({ ...s, status: 'idle' }));
    return false;
  }

  simulationState.update((s) => ({ ...s, status: 'starting', result: null, recent: [] }));
  try {
    const acceptance = await simulationStart(source);
    noteRunAcceptance(acceptance, source);
    return true;
  } catch (raw) {
    const structured = reportError(raw, 'simulation.start');
    simulationState.update((s) => ({ ...s, status: 'idle', error: structured }));
    return false;
  }
}

/** Re-run the engine over the staged corpus (incremental merge = resume). */
export async function resumeSimulationFromUi(): Promise<boolean> {
  if (busy()) return false;
  simulationState.update((s) => ({ ...s, status: 'resuming', error: null, message: null }));
  try {
    const acceptance = await simulationResume();
    noteRunAcceptance(acceptance, null);
    return true;
  } catch (raw) {
    const structured = reportError(raw, 'simulation.resume');
    simulationState.update((s) => ({ ...s, status: 'idle', error: structured }));
    return false;
  }
}

function noteRunAcceptance(
  acceptance: { source_path?: string; engine_source_dir?: string },
  picked: string | null,
): void {
  simulationState.update((s) => {
    // A terminal event may have beaten the acceptance response (the daemon
    // spawns the drain goroutine before answering): advance-only update.
    const terminalBeat =
      s.status === 'completed' ||
      s.status === 'failed' ||
      s.status === 'cancelled' ||
      s.status === 'interrupted';
    return {
      ...s,
      status: terminalBeat ? s.status : 'running',
      sourcePath: acceptance.source_path ?? picked ?? s.sourcePath,
      corpusDir: acceptance.engine_source_dir ?? s.corpusDir,
      progress: terminalBeat ? s.progress : null,
      result: terminalBeat ? s.result : null,
      error: terminalBeat ? s.error : null,
    };
  });
}

/**
 * Cancel the in-flight simulation/profile run. `cancelled:false` keeps the
 * current status and surfaces the engine's reason.
 */
export async function cancelSimulationFromUi(): Promise<boolean> {
  const s = get(simulationState);
  if (s.pendingCancel || s.status !== 'running') return false;
  simulationState.update((st) => ({ ...st, pendingCancel: true, error: null, message: null }));
  try {
    const result = await simulationCancel();
    if (result.cancelled === true) {
      simulationState.update((st) => ({
        ...st,
        pendingCancel: false,
        status: 'cancelled',
        message: 'simulation cancelled',
      }));
    } else {
      simulationState.update((st) => ({
        ...st,
        pendingCancel: false,
        message: result.reason ?? 'no simulation in progress',
      }));
    }
    return true;
  } catch (raw) {
    const structured = reportError(raw, 'simulation.cancel');
    simulationState.update((st) => ({ ...st, pendingCancel: false, error: structured }));
    return false;
  }
}

/**
 * Pick a produced profile JSON and import it into the project
 * (`simulation.profile_import`); terminal outcome via the shared
 * simulation.progress channel.
 */
export async function importProfileFromUi(): Promise<boolean> {
  if (busy()) return false;
  simulationState.update((s) => ({
    ...s,
    profileImport: { ...initialProfileImport(), status: 'picking' },
  }));
  let profilePath: string | null;
  try {
    profilePath = await pickFile({
      title: 'Choose a generated simulation profile (.json)',
      filters: SIMULATION_PROFILE_FILTERS,
    });
  } catch (raw) {
    const structured = reportError(raw, 'profile picker');
    simulationState.update((s) => ({
      ...s,
      profileImport: { ...initialProfileImport(), error: structured },
    }));
    return false;
  }
  if (profilePath === null) {
    simulationState.update((s) => ({ ...s, profileImport: initialProfileImport() }));
    return false;
  }

  simulationState.update((s) => ({
    ...s,
    profileImport: { ...initialProfileImport(), status: 'importing', profilePath },
  }));
  try {
    const acceptance = await simulationProfileImport(profilePath);
    simulationState.update((s) => ({
      ...s,
      // A terminal event may have beaten this response: never reopen a
      // completed/failed import.
      profileImport:
        s.profileImport.status === 'importing'
          ? { ...s.profileImport, profilePath: acceptance.profile_path ?? profilePath }
          : s.profileImport,
    }));
    return true;
  } catch (raw) {
    const structured = reportError(raw, 'simulation.profile_import');
    simulationState.update((s) => ({
      ...s,
      profileImport: { ...s.profileImport, status: 'failed', error: structured },
    }));
    return false;
  }
}

/** Dismiss terminal results/errors and return to idle. */
export function dismissSimulationResult(): void {
  simulationState.set(initialSimulationState());
}

/** Reset all module state (tests / disposal). */
export function resetSimulationState(): void {
  // Project close / engine session change reset the projection but do NOT
  // clear the shared fact store (only disposeDesktop does). Svelte
  // subscribers receive the full array on every append, so a cursor of 0
  // would replay the previous flow's facts onto the fresh projection (e.g.
  // an old stage:"done" completing the next simulation/profile import).
  // Advance the cursor past everything already recorded instead.
  const facts = get(simulationProgressEvents);
  lastFactId = facts.length > 0 ? facts[facts.length - 1]!.id : 0;
  simulationState.set(initialSimulationState());
}

// ---------------------------------------------------------------------------
// Engine-driven updates (observed facts only)
// ---------------------------------------------------------------------------

let lastFactId = 0;

function noteSimulationFact(fact: SimulationProgressFact): void {
  const s = get(simulationState);
  // Live while a start/resume is pending (an event may beat the acceptance
  // response — the daemon spawns the drain goroutine first), the run is
  // accepted, or a just-cancelled run may still be corrected; the profile
  // import is live from its request until its terminal.
  const runLive =
    s.status === 'starting' || s.status === 'resuming' || s.status === 'running' || s.status === 'cancelled';
  const profileActive = s.profileImport.status === 'importing';
  // A late terminal fact may still correct a just-cancelled run; when only
  // the profile import is active, terminals belong to it, not the run.
  const runOwnsTerminal =
    (s.status === 'running' || s.status === 'starting' || s.status === 'resuming') ||
    (!profileActive && s.status === 'cancelled');
  if (!runLive && !profileActive) return;

  const line: SimulationProgressLine = {
    stage: fact.stage,
    completed: fact.completed,
    total: fact.total,
    detail: fact.detail,
    at: fact.at,
  };
  const recent = [...s.recent, line].slice(-RECENT_LIMIT);

  if (fact.error !== undefined) {
    // Structural failure signal (engine.error follows separately).
    simulationState.update((st) => ({
      ...st,
      recent,
      progress: line,
      status: runOwnsTerminal ? 'failed' : st.status,
      error: runOwnsTerminal
        ? { code: 'operation_failed', message: fact.error ?? 'simulation failed' }
        : st.error,
      profileImport: profileActive
        ? {
            ...s.profileImport,
            status: 'failed',
            error: { code: 'operation_failed', message: fact.error ?? 'profile import failed' },
          }
          : s.profileImport,
    }));
    return;
  }

  if (fact.stage === 'done') {
    simulationState.update((st) => ({
      ...st,
      recent,
      progress: line,
      status: runOwnsTerminal ? 'completed' : st.status,
      result: runOwnsTerminal ? { at: fact.at, detail: fact.detail } : st.result,
      profileImport: profileActive
        ? { ...s.profileImport, status: 'completed', detail: fact.detail ?? null }
        : s.profileImport,
    }));
    // A profile import can change project-visible style facts: re-read the
    // authoritative snapshot (coalesced).
    if (profileActive) void scheduleResync();
    return;
  }

  simulationState.update((st) => ({ ...st, progress: line, recent }));
}

// Subscriptions live for the module's lifetime (the stores are app-global).
simulationProgressEvents.subscribe((facts) => {
  for (const fact of facts) {
    if (fact.id > lastFactId) {
      lastFactId = fact.id;
      noteSimulationFact(fact);
    }
  }
});

// Project closed: the staged corpus stays on disk but no flow is active.
projectSnapshot.subscribe((snapshot) => {
  if (snapshot === null && get(simulationState).status !== 'idle') resetSimulationState();
});

// Engine restart mid-run: no terminal event will ever arrive for this run.
onEngineSessionChange(() => {
  const s = get(simulationState);
  if (s.status === 'running') {
    simulationState.update((st) => ({
      ...st,
      status: 'interrupted',
      message: 'engine session changed mid-run — resume re-runs the staged corpus',
    }));
  }
  if (s.profileImport.status === 'importing') {
    simulationState.update((st) => ({
      ...st,
      profileImport: { ...st.profileImport, status: 'interrupted' },
    }));
  }
});
