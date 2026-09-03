/**
 * Co-create orchestration for the task-7 Co-create screen. Mirrors
 * `chapters.ts` / `runControls.ts`: a passive projection of observed facts
 * plus one protocol request per user action.
 *
 * Contract honored (task-2 daemon mapping, internal/entry/desktop/dispatch.go
 * + startup.CoCreateSession):
 * - `cocreate.start {message, mode?}` returns ACCEPTANCE `{accepted, mode}`;
 *   the round then streams `cocreate.progress` previews (`thinking`/`reply`
 *   stages whose message is the ACCUMULATED text — replace, never append)
 *   and ends with exactly ONE terminal event `stage:"assistant"` carrying
 *   `{message, ready, draft, suggestions}`. Round failure arrives as an
 *   engine.error event (never as the response — acceptance already went out).
 * - mode `stage` pauses an active run to co-create against the current book
 *   (the engine rejects it when the book is completed or stopping); mode
 *   `cold` (default) co-creates a new book brief from scratch.
 * - `cocreate.stage {message}` appends a user turn to the EXISTING session
 *   and runs another round.
 * - The staged draft lives engine-side and accumulates: a terminal reply
 *   with an EMPTY draft string keeps the previous draft (daemon session
 *   semantics); `ready` reports the engine's own completeness verdict.
 * - `cocreate.resume` hands the engine's draft over (stage: applies it to the
 *   paused book; cold: starts a run from it) and the engine emits
 *   run.started — after acceptance the co-create session projection is
 *   dropped and run.* events own what happens next. The engine rejects
 *   resume while the draft is still empty (operation_failed).
 * - `cocreate.cancel {reason?}` tears the session down engine-side; a
 *   `cancelled:false` response means no session existed (a stale local
 *   projection is dropped to match).
 *
 * Everything here is STAGED content: nothing enters the book until resume.
 */

import { get, writable, type Writable } from 'svelte/store';

import {
  cocreateCancel,
  cocreateResume,
  cocreateStart,
  cocreateStage,
  type CocreateMode,
} from '$lib/api/desktop';
import {
  cocreateEvents,
  notifications,
  onEngineSessionChange,
  projectSnapshot,
  reportError,
} from '$lib/stores/desktop';
import type {
  CocreateProgressFact,
  ConnectionState,
  ProjectSnapshot,
  StructuredError,
} from '$lib/types/protocol';

export type { CocreateMode };

// ---------------------------------------------------------------------------
// Projection state
// ---------------------------------------------------------------------------

export interface CocreateTurn {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

/** The engine-side staged draft as last reported by a terminal reply. */
export interface CocreateDraft {
  text: string;
  ready: boolean;
  suggestions: string[];
  at: number;
}

export interface CocreateState {
  /** Engine-side session mode; null until a start acceptance is observed. */
  mode: CocreateMode | null;
  /** Between start/stage acceptance and the terminal assistant event. */
  roundActive: boolean;
  /** Streaming previews of the active round (accumulated text per stage). */
  preview: { thinking: string; reply: string } | null;
  conversation: CocreateTurn[];
  draft: CocreateDraft | null;
  pendingStart: boolean;
  pendingStage: boolean;
  pendingResume: boolean;
  pendingCancel: boolean;
  /** Last request-level structured error. */
  error: StructuredError | null;
  /** Last round failure observed via engine.error while a round was active. */
  roundError: string | null;
  /** Informational outcome line (cancel results, resume confirmations). */
  message: string | null;
  /** Set after a resume acceptance; the run itself is visible via run.* events. */
  lastResumed: { mode: CocreateMode; at: number } | null;
}

function initialCocreateState(): CocreateState {
  return {
    mode: null,
    roundActive: false,
    preview: null,
    conversation: [],
    draft: null,
    pendingStart: false,
    pendingStage: false,
    pendingResume: false,
    pendingCancel: false,
    error: null,
    roundError: null,
    message: null,
    lastResumed: null,
  };
}

export const cocreateState: Writable<CocreateState> = writable(initialCocreateState());

// ---------------------------------------------------------------------------
// Availability projection (pure; backend state in, flags out)
// ---------------------------------------------------------------------------

export interface CocreateControlAvailability {
  projectOpen: boolean;
  engineReady: boolean;
  /** Begin a fresh cold-start session (new book brief from scratch). */
  canStartCold: boolean;
  /** Begin a stage session (pauses the current run to co-create mid-book). */
  canStartStage: boolean;
  /** Append a follow-up message to the existing session. */
  canStage: boolean;
  /**
   * Hand the staged draft to the engine. Mirrors the daemon's BuildPrompt
   * guard: resume requires a non-empty engine-reported draft.
   */
  canResume: boolean;
  canCancel: boolean;
}

export function deriveCocreateControls(
  state: CocreateState,
  snapshot: ProjectSnapshot | null,
  connection: ConnectionState,
): CocreateControlAvailability {
  const projectOpen = snapshot !== null;
  const engineReady = connection === 'ready' || connection === 'degraded';
  const idle = state.mode === null && !state.roundActive && !state.pendingStart;
  const chatReady = state.mode !== null && !state.roundActive;
  const draftReady = state.draft !== null && state.draft.text.trim() !== '';
  return {
    projectOpen,
    engineReady,
    canStartCold: projectOpen && engineReady && idle,
    canStartStage: projectOpen && engineReady && idle,
    canStage: projectOpen && engineReady && chatReady && !state.pendingStage,
    canResume: projectOpen && engineReady && chatReady && !state.pendingResume && draftReady,
    canCancel: state.mode !== null && !state.pendingCancel,
  };
}

// ---------------------------------------------------------------------------
// Actions — one protocol request each
// ---------------------------------------------------------------------------

let turnSeq = 0;
/** The user message of the round currently awaiting its response; inserted
 * by the event pipeline if the round settles (terminal reply or engine.error)
 * before the acceptance response arrives. */
let pendingRoundUser: string | null = null;
/** The round settled via events while its acceptance response was still in
 * flight (the daemon spawns the round goroutine before answering); the
 * acceptance must neither re-open the round nor re-insert its turn. */
let pendingRoundSettled = false;

/** A round is live from its request until its terminal reply/failure event. */
function roundLive(s: CocreateState): boolean {
  return s.roundActive || s.pendingStart || s.pendingStage;
}

function pushTurn(state: CocreateState, role: CocreateTurn['role'], text: string): CocreateTurn[] {
  turnSeq += 1;
  const turn: CocreateTurn = { id: turnSeq, role, text, at: Date.now() };
  return [...state.conversation, turn];
}

/**
 * Start a co-create session. `stage` pauses the current run and co-creates
 * against the book (the engine may reject that); cold starts a new brief.
 */
export async function startCocreateFromUi(message: string, mode: CocreateMode = 'cold'): Promise<boolean> {
  const trimmed = message.trim();
  const current = get(cocreateState);
  if (trimmed === '' || current.mode !== null || current.roundActive || current.pendingStart) return false;
  pendingRoundUser = trimmed;
  pendingRoundSettled = false;
  cocreateState.update((s) => ({ ...s, pendingStart: true, error: null, roundError: null, message: null }));
  try {
    const acceptance = await cocreateStart(trimmed, mode);
    const acceptedMode: CocreateMode = acceptance.mode === 'stage' ? 'stage' : 'cold';
    const settledByEvent = pendingRoundSettled;
    pendingRoundUser = null;
    pendingRoundSettled = false;
    cocreateState.update((s) => {
      // The event pipeline may have settled this round while we awaited —
      // terminal reply OR engine.error failure. Either way the round stays
      // closed (advance-only update; an error must not be reopened, or the
      // composer stays wedged waiting for a terminal that already came).
      const settled = settledByEvent || s.roundError !== null;
      return {
        ...s,
        pendingStart: false,
        mode: acceptedMode,
        roundActive: settled ? s.roundActive : true,
        preview: settled ? s.preview : null,
        conversation: settled ? s.conversation : pushTurn(s, 'user', trimmed),
      };
    });
    return true;
  } catch (raw) {
    pendingRoundUser = null;
    pendingRoundSettled = false;
    const structured = reportError(raw, `cocreate.start (${mode})`);
    cocreateState.update((s) => ({ ...s, pendingStart: false, error: structured }));
    return false;
  }
}

/** Append a follow-up message to the existing session (next round). */
export async function stageCocreateFromUi(message: string): Promise<boolean> {
  const trimmed = message.trim();
  const current = get(cocreateState);
  if (trimmed === '' || current.mode === null || current.roundActive || current.pendingStage) return false;
  pendingRoundUser = trimmed;
  pendingRoundSettled = false;
  cocreateState.update((s) => ({ ...s, pendingStage: true, error: null, roundError: null, message: null }));
  try {
    await cocreateStage(trimmed);
    const settledByEvent = pendingRoundSettled;
    pendingRoundUser = null;
    pendingRoundSettled = false;
    cocreateState.update((s) => {
      const settled = settledByEvent || s.roundError !== null;
      return {
        ...s,
        pendingStage: false,
        roundActive: settled ? s.roundActive : true,
        preview: settled ? s.preview : null,
        conversation: settled ? s.conversation : pushTurn(s, 'user', trimmed),
      };
    });
    return true;
  } catch (raw) {
    pendingRoundUser = null;
    pendingRoundSettled = false;
    const structured = reportError(raw, 'cocreate.stage');
    cocreateState.update((s) => ({ ...s, pendingStage: false, error: structured }));
    return false;
  }
}

/**
 * Hand the staged draft to the engine. After acceptance the session is the
 * engine's concern (run.started follows); the local projection resets with a
 * confirmation note.
 */
export async function resumeCocreateFromUi(): Promise<boolean> {
  const current = get(cocreateState);
  if (current.mode === null || current.roundActive || current.pendingResume) return false;
  cocreateState.update((s) => ({ ...s, pendingResume: true, error: null, message: null }));
  const mode = current.mode;
  try {
    await cocreateResume();
    cocreateState.set({
      ...initialCocreateState(),
      lastResumed: { mode, at: Date.now() },
      message:
        mode === 'stage'
          ? 'draft applied to the book — the run continues (see Write)'
          : 'run started from the draft — progress on the Write screen',
    });
    return true;
  } catch (raw) {
    const structured = reportError(raw, 'cocreate.resume');
    cocreateState.update((s) => ({ ...s, pendingResume: false, error: structured }));
    return false;
  }
}

/**
 * Cancel the session. `cancelled:false` (no engine-side session) also drops
 * the local projection — it was stale.
 */
export async function cancelCocreateFromUi(reason?: string): Promise<boolean> {
  const current = get(cocreateState);
  if (current.mode === null || current.pendingCancel) return false;
  cocreateState.update((s) => ({ ...s, pendingCancel: true, error: null, message: null }));
  try {
    const result = await cocreateCancel(reason);
    cocreateState.set({
      ...initialCocreateState(),
      message:
        result.cancelled === true
          ? 'co-create session cancelled'
          : (result.reason ?? 'no co-create session'),
    });
    return true;
  } catch (raw) {
    const structured = reportError(raw, 'cocreate.cancel');
    cocreateState.update((s) => ({ ...s, pendingCancel: false, error: structured }));
    return false;
  }
}

/** Reset all module state (tests / disposal). */
export function resetCocreateState(): void {
  turnSeq = 0;
  pendingRoundUser = null;
  pendingRoundSettled = false;
  // Project close / engine session change reset the projection but do NOT
  // clear the shared fact/notification stores (only disposeDesktop does).
  // Svelte subscribers receive the full array on every append, so a cursor
  // of 0 would replay the previous flow's facts onto the fresh projection
  // (e.g. an old stage:"done" completing the next import). Advance the
  // cursors past everything already recorded instead.
  const facts = get(cocreateEvents);
  lastFactId = facts.length > 0 ? facts[facts.length - 1]!.id : 0;
  const notes = get(notifications);
  lastNotificationId = notes.length > 0 ? notes[notes.length - 1]!.id : 0;
  cocreateState.set(initialCocreateState());
}

// ---------------------------------------------------------------------------
// Engine-driven updates (observed facts only)
// ---------------------------------------------------------------------------

let lastFactId = 0;
let lastNotificationId = 0;

function noteCocreateFact(fact: CocreateProgressFact): void {
  if (fact.stage === 'assistant') {
    // Terminal reply: closes the round and carries the staged draft. An
    // empty draft string keeps the previous draft (daemon session rule).
    const racedUserTurn = pendingRoundUser;
    if (racedUserTurn !== null) pendingRoundSettled = true;
    pendingRoundUser = null;
    cocreateState.update((s) => {
      let conversation = s.conversation;
      if (racedUserTurn !== null) conversation = pushTurn(s, 'user', racedUserTurn);
      const keptDraft =
        fact.draft !== undefined && fact.draft.trim() !== '' ? fact.draft : (s.draft?.text ?? '');
      return {
        ...s,
        roundActive: false,
        preview: null,
        roundError: null,
        conversation: pushTurn({ ...s, conversation }, 'assistant', fact.message ?? ''),
        draft: {
          text: keptDraft,
          ready: fact.ready === true,
          suggestions: fact.suggestions ?? [],
          at: fact.at,
        },
      };
    });
    return;
  }
  if (fact.stage === 'thinking' || fact.stage === 'reply') {
    // Preview: each event carries the accumulated text for its stage.
    cocreateState.update((s) => ({
      ...s,
      roundActive: true,
      preview: {
        thinking: fact.stage === 'thinking' ? (fact.message ?? '') : (s.preview?.thinking ?? ''),
        reply: fact.stage === 'reply' ? (fact.message ?? '') : (s.preview?.reply ?? ''),
      },
    }));
  }
  // Other stage names: recorded in activity by the stores; nothing to project.
}

// Subscriptions live for the module's lifetime (the stores are app-global).
cocreateEvents.subscribe((facts) => {
  for (const fact of facts) {
    if (fact.id > lastFactId) {
      lastFactId = fact.id;
      noteCocreateFact(fact);
    }
  }
});

notifications.subscribe((all) => {
  for (const n of all) {
    if (n.id > lastNotificationId) {
      lastNotificationId = n.id;
      // engine.error is the documented failure channel for a live round —
      // including one whose acceptance response has not resolved yet (the
      // daemon spawns the round goroutine before answering; matched by event
      // type + round-live window, never by message text).
      const s = get(cocreateState);
      if (n.source === 'event' && n.level === 'error' && roundLive(s)) {
        const racedUserTurn = pendingRoundUser;
        pendingRoundUser = null;
        if (racedUserTurn !== null) pendingRoundSettled = true;
        cocreateState.update((st) => ({
          ...st,
          roundActive: false,
          preview: null,
          roundError: n.message,
          // The engine recorded the user message before running the round;
          // keep it in the history exactly once.
          conversation:
            racedUserTurn !== null ? pushTurn(st, 'user', racedUserTurn) : st.conversation,
        }));
      }
    }
  }
});

// Project closed: nothing to co-create against; staged content is dropped.
projectSnapshot.subscribe((snapshot) => {
  if (snapshot === null && get(cocreateState).mode !== null) resetCocreateState();
});

// Engine restart: the daemon-resident session died with the process.
onEngineSessionChange(() => {
  if (get(cocreateState).mode !== null || get(cocreateState).roundActive) {
    resetCocreateState();
  }
});
