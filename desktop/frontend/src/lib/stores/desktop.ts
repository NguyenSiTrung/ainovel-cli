/**
 * Desktop stores: the reactive projection layer between the Tauri shell and
 * the feature screens (tasks 5-8).
 *
 * Responsibilities:
 * - Startup handshake: `desktop_status` (start the engine if needed) and,
 *   once ready, fetch `project.snapshot` + `usage.snapshot` and subscribe to
 *   `desktop://event` / `desktop://session` / `desktop://status`.
 * - (session, sequence) dedupe with duplicate tolerance; session-change
 *   detection triggers snapshot refetch + `project.replay_events` recovery.
 * - Reconnect handling driven by `desktop://status` (restarting/exited ->
 *   ready resync).
 * - Bounded buffers only (activity, stream entries, notifications).
 *
 * Explicitly NOT here (spec constraints): filesystem access, engine routing
 * or business decisions, hardcoded workflow transitions. Run state records
 * observed facts from events; it never advances on its own.
 */

import { get, writable, type Readable, type Writable } from 'svelte/store';

import {
  DesktopApiError,
  EventDeduper,
  getEventState,
  getStatus,
  hasTauriBridge,
  projectClose,
  projectCreate,
  projectOpen,
  projectReplayEvents,
  projectResume,
  projectSnapshot as fetchProjectSnapshot,
  restartEngine,
  shutdownEngine,
  startEngine,
  subscribeEngineEvents,
  subscribeSessionChanges,
  subscribeStatus,
  toStructuredError,
  usageSnapshot,
  type EngineEventDelivery,
} from '$lib/api/desktop';
import {
  presentError,
  type ActivityEntry,
  type AppNotification,
  type ChapterUpdateFact,
  type CocreateProgressFact,
  type ConnectionState,
  type EngineState,
  type EventEnvelope,
  type ImportProgressFact,
  type JsonObject,
  type ProjectSnapshot,
  type RecoveryPrompt,
  type RunState,
  type SimulationProgressFact,
  type StreamEntry,
  type StreamState,
  type StructuredError,
  type UsageState,
} from '$lib/types/protocol';

// ---------------------------------------------------------------------------
// Bounds for disposable UI state
// ---------------------------------------------------------------------------

export const ACTIVITY_LIMIT = 500;
export const STREAM_ENTRY_LIMIT = 2000;
export const NOTIFICATION_LIMIT = 50;
export const CHAPTER_EVENT_LIMIT = 100;
export const COCREATE_EVENT_LIMIT = 200;
export const IMPORT_EVENT_LIMIT = 200;
export const SIMULATION_EVENT_LIMIT = 200;

// ---------------------------------------------------------------------------
// Stores (public surface consumed by tasks 5-8)
// ---------------------------------------------------------------------------

export const connectionState: Writable<ConnectionState> = writable('booting');
export const engineState: Writable<EngineState> = writable({
  health: 'stopped',
  stopping: false,
  restartAttempts: 0,
  restartsTotal: 0,
  malformedOutputLines: 0,
});
export const projectSnapshot: Writable<ProjectSnapshot | null> = writable(null);
export const snapshotError: Writable<StructuredError | null> = writable(null);
export const activity: Writable<ActivityEntry[]> = writable([]);
/**
 * Observed chapter.updated facts (bounded), the chapter-level update signal:
 * the daemon does not synthesize checkpoint/artifact/outline events, so
 * chapter facts (plus the snapshot refresh they trigger) are how chapter and
 * artifact screens learn that engine-side content changed.
 */
export const chapterEvents: Writable<ChapterUpdateFact[]> = writable([]);
/**
 * Observed cocreate.progress facts (bounded) — the co-create screen's update
 * signal: streaming previews (thinking/reply) and terminal assistant replies
 * carrying the staged draft.
 */
export const cocreateEvents: Writable<CocreateProgressFact[]> = writable([]);
/** Observed import.progress facts (bounded); terminal stage is "done". */
export const importProgressEvents: Writable<ImportProgressFact[]> = writable([]);
/** Observed simulation.progress facts (bounded); shared by profile imports. */
export const simulationProgressEvents: Writable<SimulationProgressFact[]> = writable([]);
export const stream: Writable<StreamState> = writable({ entries: [], channels: {}, lastSequence: -1 });
export const runState: Writable<RunState> = writable({ status: 'idle' });
export const usage: Writable<UsageState> = writable({});
export const notifications: Writable<AppNotification[]> = writable([]);

/**
 * Set when an engine session change interrupted observed work and the user
 * must explicitly choose resume / inspect / close. Never set by local
 * heuristics about run progress; only by session-change facts.
 */
export const recoveryPrompt: Writable<RecoveryPrompt | null> = writable(null);

/** Read-only view of connection readiness for guards in screens. */
export const isConnected: Readable<boolean> = {
  subscribe(run) {
    return connectionState.subscribe((state) =>
      run(state === 'ready' || state === 'degraded'),
    );
  },
};

// ---------------------------------------------------------------------------
// Internal controller state
// ---------------------------------------------------------------------------

interface DesktopController {
  initialized: boolean;
  unlisteners: Array<() => void>;
  /** (session, sequence) window for frontend-side duplicate tolerance. */
  lastSession: string | null;
  lastSequence: number;
  duplicatesTolerated: number;
  activitySeq: number;
  notificationSeq: number;
  chapterEventSeq: number;
  cocreateEventSeq: number;
  importEventSeq: number;
  simulationEventSeq: number;
  resyncInFlight: Promise<void> | null;
  resyncQueued: boolean;
}

const controller: DesktopController = {
  initialized: false,
  unlisteners: [],
  lastSession: null,
  lastSequence: -1,
  duplicatesTolerated: 0,
  activitySeq: 0,
  notificationSeq: 0,
  chapterEventSeq: 0,
  cocreateEventSeq: 0,
  importEventSeq: 0,
  simulationEventSeq: 0,
  resyncInFlight: null,
  resyncQueued: false,
};

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export function pushNotification(
  level: AppNotification['level'],
  message: string,
  options: {
    source?: AppNotification['source'];
    code?: string;
    details?: unknown;
    category?: AppNotification['category'];
  } = {},
): AppNotification {
  controller.notificationSeq += 1;
  const notification: AppNotification = {
    id: controller.notificationSeq,
    level,
    message,
    source: options.source ?? 'event',
    code: options.code,
    category: options.category,
    details: options.details as AppNotification['details'],
    at: Date.now(),
  };
  notifications.update((all) => {
    const next = [...all, notification];
    return next.length > NOTIFICATION_LIMIT ? next.slice(next.length - NOTIFICATION_LIMIT) : next;
  });
  return notification;
}

export function dismissNotification(id: number): void {
  notifications.update((all) => all.filter((n) => n.id !== id));
}

export function clearNotifications(): void {
  notifications.set([]);
}

// ---------------------------------------------------------------------------
// Notification preferences (local UI prefs; no engine setting exists)
// ---------------------------------------------------------------------------

/**
 * Which desktop-notification categories surface as toasts. Local UI concern
 * only — the engine has no notification-preference setting, and request
 * errors (uncategorized) always surface regardless of these prefs.
 */
export interface NotificationPrefs {
  completion: boolean;
  pause: boolean;
  warning: boolean;
  failure: boolean;
}

export const NOTIFICATION_PREF_DEFAULTS: NotificationPrefs = {
  completion: true,
  pause: true,
  warning: true,
  failure: true,
};

export const notificationPrefs: Writable<NotificationPrefs> = writable({ ...NOTIFICATION_PREF_DEFAULTS });

export function setNotificationPref(category: keyof NotificationPrefs, enabled: boolean): void {
  notificationPrefs.update((prefs) => ({ ...prefs, [category]: enabled }));
}

/** True when a notification should surface as a toast under the current prefs. */
export function notificationVisible(note: AppNotification, prefs: NotificationPrefs): boolean {
  return note.category === undefined || prefs[note.category] === true;
}

/** Surface any thrown value as a structured error notification. */
export function reportError(raw: unknown, context?: string): StructuredError {
  const structured = toStructuredError(raw);
  const presentation = presentError(structured.code);
  const prefix = context ? `${context}: ` : '';
  pushNotification(presentation.severity, `${prefix}${presentation.title} — ${structured.message}`, {
    source: 'error',
    code: structured.code,
    details: structured.details,
  });
  return structured;
}

// ---------------------------------------------------------------------------
// Event application (pure store updates; exported for tests)
// ---------------------------------------------------------------------------

function appendActivity(envelope: EventEnvelope, summary?: string): void {
  controller.activitySeq += 1;
  const entry: ActivityEntry = {
    id: controller.activitySeq,
    sequence: envelope.sequence,
    session: envelope.session,
    event: envelope.event,
    projectId: envelope.projectId,
    at: Date.now(),
    summary,
  };
  activity.update((all) => {
    const next = [...all, entry];
    return next.length > ACTIVITY_LIMIT ? next.slice(next.length - ACTIVITY_LIMIT) : next;
  });
}

function appendStreamDelta(envelope: EventEnvelope, text: string, channel: string): void {
  const entry: StreamEntry = { kind: 'text', channel, text, sequence: envelope.sequence, at: Date.now() };
  stream.update((state) => {
    const entries = [...state.entries, entry];
    const ch = state.channels[channel] ?? { text: '', revision: 0 };
    const channels = {
      ...state.channels,
      [channel]: { ...ch, text: ch.text + text },
    };
    const bounded =
      entries.length > STREAM_ENTRY_LIMIT ? entries.slice(entries.length - STREAM_ENTRY_LIMIT) : entries;
    return { entries: bounded, channels, lastSequence: envelope.sequence };
  });
}

function applyStreamClear(envelope: EventEnvelope, channel: string, reason?: string): void {
  const marker: StreamEntry = { kind: 'clear', channel, reason, sequence: envelope.sequence, at: Date.now() };
  stream.update((state) => {
    const entries = [...state.entries, marker];
    const ch = state.channels[channel] ?? { text: '', revision: 0 };
    const channels = {
      ...state.channels,
      [channel]: { text: '', revision: ch.revision + 1 },
    };
    const bounded =
      entries.length > STREAM_ENTRY_LIMIT ? entries.slice(entries.length - STREAM_ENTRY_LIMIT) : entries;
    return { entries: bounded, channels, lastSequence: envelope.sequence };
  });
}

function payloadString(payload: JsonObject, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function payloadNumber(payload: JsonObject, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function payloadObject(payload: JsonObject, key: string): JsonObject | undefined {
  const value = payload[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function payloadArrayStrings(payload: JsonObject, key: string): string[] | undefined {
  const value = payload[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((v): v is string => typeof v === 'string');
  return strings.length > 0 || value.length === 0 ? strings : undefined;
}

function boundedAppend<T>(all: T[], entry: T, limit: number): T[] {
  const next = [...all, entry];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** Record one observed cocreate.progress fact (bounded). */
function appendCocreateFact(envelope: EventEnvelope): CocreateProgressFact | null {
  const stage = payloadString(envelope.payload, 'stage');
  if (stage === undefined) return null;
  controller.cocreateEventSeq += 1;
  const fact: CocreateProgressFact = {
    id: controller.cocreateEventSeq,
    sequence: envelope.sequence,
    at: Date.now(),
    stage,
    message: payloadString(envelope.payload, 'message'),
    ready: envelope.payload.ready === true ? true : undefined,
    draft: payloadString(envelope.payload, 'draft'),
    suggestions: payloadArrayStrings(envelope.payload, 'suggestions'),
  };
  cocreateEvents.update((all) => boundedAppend(all, fact, COCREATE_EVENT_LIMIT));
  return fact;
}

/** Record one observed import.progress fact (bounded). */
function appendImportFact(envelope: EventEnvelope): ImportProgressFact | null {
  controller.importEventSeq += 1;
  const fact: ImportProgressFact = {
    id: controller.importEventSeq,
    sequence: envelope.sequence,
    at: Date.now(),
    stage: payloadString(envelope.payload, 'stage'),
    completed: payloadNumber(envelope.payload, 'completed'),
    total: payloadNumber(envelope.payload, 'total'),
    detail: payloadString(envelope.payload, 'detail'),
    level: payloadString(envelope.payload, 'level'),
    retryAt: payloadString(envelope.payload, 'retry_at'),
    error: payloadString(envelope.payload, 'error'),
    continued: envelope.payload.continued === true ? true : undefined,
  };
  importProgressEvents.update((all) => boundedAppend(all, fact, IMPORT_EVENT_LIMIT));
  return fact;
}

/** Record one observed simulation.progress fact (bounded). */
function appendSimulationFact(envelope: EventEnvelope): SimulationProgressFact | null {
  controller.simulationEventSeq += 1;
  const fact: SimulationProgressFact = {
    id: controller.simulationEventSeq,
    sequence: envelope.sequence,
    at: Date.now(),
    stage: payloadString(envelope.payload, 'stage'),
    completed: payloadNumber(envelope.payload, 'completed'),
    total: payloadNumber(envelope.payload, 'total'),
    detail: payloadString(envelope.payload, 'detail'),
    error: payloadString(envelope.payload, 'error'),
  };
  simulationProgressEvents.update((all) => boundedAppend(all, fact, SIMULATION_EVENT_LIMIT));
  return fact;
}

/** Record one observed chapter.updated fact (bounded). */
function appendChapterFact(envelope: EventEnvelope): ChapterUpdateFact | null {
  const raw = envelope.payload.chapter;
  const chapter = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number(raw);
  if (!Number.isFinite(chapter) || chapter <= 0) return null;
  controller.chapterEventSeq += 1;
  const status = payloadString(envelope.payload, 'status');
  const fact: ChapterUpdateFact = {
    id: controller.chapterEventSeq,
    sequence: envelope.sequence,
    chapter,
    version: payloadNumber(envelope.payload, 'version'),
    status,
    synced: status === 'synced',
    at: Date.now(),
  };
  chapterEvents.update((all) => {
    const next = [...all, fact];
    return next.length > CHAPTER_EVENT_LIMIT ? next.slice(next.length - CHAPTER_EVENT_LIMIT) : next;
  });
  return fact;
}

/**
 * Chapter/artifact content changed engine-side. The daemon does not emit
 * checkpoint/artifact/outline events (documented task-2 limitation), so the
 * snapshot is refreshed (coalesced) as the authoritative update signal; the
 * recorded chapter facts give chapter screens the chapter-level detail.
 */
function refreshAfterContentChange(): void {
  scheduleResync().catch(() => undefined);
}

/**
 * After a terminal run outcome the snapshot is authoritative again
 * (chapters, progress, recovery labels); re-read it. Coalesced by
 * scheduleResync; this is a data refresh, not a state transition.
 */
function refreshAfterTerminal(): void {
  scheduleResync().catch(() => undefined);
}

/**
 * Apply one deduped engine event to the projections. Records observed facts
 * only; unknown event names never reach here (filtered upstream).
 */
export function applyEngineEvent(envelope: EventEnvelope): void {
  const now = Date.now();
  switch (envelope.event) {
    case 'engine.ready': {
      appendActivity(envelope, envelope.payload.recovered === true ? 'recovered' : undefined);
      break;
    }
    case 'engine.status_changed': {
      const status = payloadString(envelope.payload, 'status');
      engineState.update((state) => ({ ...state, status }));
      appendActivity(envelope, status);
      break;
    }
    case 'engine.error': {
      const message = payloadString(envelope.payload, 'message') ?? 'engine error';
      const code = payloadString(envelope.payload, 'code');
      pushNotification('error', message, {
        source: 'event',
        code,
        category: 'failure',
        details: envelope.payload.details,
      });
      appendActivity(envelope, message);
      break;
    }
    case 'engine.exited':
    case 'engine.restarting': {
      const reason = payloadString(envelope.payload, 'reason');
      appendActivity(envelope, reason);
      break;
    }
    case 'run.started': {
      runState.set({
        status: 'running',
        runId: payloadString(envelope.payload, 'run_id'),
        goal: payloadString(envelope.payload, 'goal'),
        lastEventAt: now,
      });
      // A run demonstrably started (e.g. an accepted project.resume): no
      // recovery choice is pending anymore.
      recoveryPrompt.set(null);
      appendActivity(envelope, payloadString(envelope.payload, 'goal'));
      break;
    }
    case 'run.step_changed': {
      const step = payloadString(envelope.payload, 'step');
      runState.update((state) => ({ ...state, step, lastEventAt: now }));
      appendActivity(envelope, step);
      break;
    }
    case 'run.progress': {
      const completed = payloadNumber(envelope.payload, 'completed');
      const total = payloadNumber(envelope.payload, 'total');
      const detail = payloadString(envelope.payload, 'detail');
      runState.update((state) => ({
        ...state,
        progress: { completed, total, detail, at: now },
        lastEventAt: now,
      }));
      appendActivity(envelope, detail ?? (total !== undefined ? `${completed ?? 0}/${total}` : undefined));
      break;
    }
    case 'run.paused': {
      const reason = payloadString(envelope.payload, 'reason');
      const advanceHold = envelope.payload.advance_hold === true;
      runState.update((state) => ({
        ...state,
        status: 'paused',
        pause: {
          reason,
          // The engine marks chapter-gate pauses (`advance_hold`) so the UI
          // can offer the explicit one-chapter authorization.
          advanceHold,
          at: now,
        },
        lastEventAt: now,
      }));
      // Desktop notification for pause events: chapter-gate holds ask for a
      // user decision, so they surface as warnings.
      pushNotification(
        advanceHold ? 'warning' : 'info',
        reason ? `run paused: ${reason}` : 'run paused',
        { source: 'event', category: 'pause' },
      );
      appendActivity(envelope, reason);
      break;
    }
    case 'run.completed': {
      runState.update((state) => ({
        ...state,
        status: 'completed',
        progress: state.progress,
        terminal: {
          kind: 'run.completed',
          at: now,
          summary: payloadObject(envelope.payload, 'summary'),
        },
        lastEventAt: now,
      }));
      pushNotification('info', 'run completed', { source: 'event', category: 'completion' });
      appendActivity(envelope, 'run completed');
      refreshAfterTerminal();
      break;
    }
    case 'run.failed': {
      const message = payloadString(envelope.payload, 'message') ?? 'run failed';
      runState.update((state) => ({
        ...state,
        status: 'failed',
        terminal: {
          kind: 'run.failed',
          at: now,
          message,
          code: payloadString(envelope.payload, 'code'),
        },
        lastEventAt: now,
      }));
      pushNotification('error', message, {
        source: 'event',
        code: payloadString(envelope.payload, 'code'),
        category: 'failure',
      });
      appendActivity(envelope, message);
      refreshAfterTerminal();
      break;
    }
    case 'run.aborted': {
      const reason = payloadString(envelope.payload, 'reason');
      runState.update((state) => ({
        ...state,
        status: 'aborted',
        terminal: { kind: 'run.aborted', at: now, reason },
        lastEventAt: now,
      }));
      pushNotification('warning', reason ? `run aborted: ${reason}` : 'run aborted', {
        source: 'event',
        category: 'warning',
      });
      appendActivity(envelope, reason);
      refreshAfterTerminal();
      break;
    }
    case 'stream.delta': {
      const text = payloadString(envelope.payload, 'text');
      if (text !== undefined) {
        appendStreamDelta(envelope, text, payloadString(envelope.payload, 'channel') ?? 'default');
      }
      break;
    }
    case 'stream.clear': {
      applyStreamClear(
        envelope,
        payloadString(envelope.payload, 'channel') ?? 'default',
        payloadString(envelope.payload, 'reason'),
      );
      break;
    }
    case 'checkpoint.created': {
      appendActivity(envelope, payloadString(envelope.payload, 'checkpoint_id'));
      break;
    }
    case 'artifact.updated': {
      appendActivity(envelope, payloadString(envelope.payload, 'artifact'));
      // Additive-event safety: when a newer engine DOES emit artifact events,
      // the read-only artifact screens resync from the snapshot.
      refreshAfterContentChange();
      break;
    }
    case 'chapter.updated': {
      const fact = appendChapterFact(envelope);
      appendActivity(envelope, fact?.status ?? (fact !== null ? String(fact.chapter) : undefined));
      // Chapter content changed engine-side (user save, engine commit, or
      // revision sync): refresh the snapshot-backed projections (coalesced).
      refreshAfterContentChange();
      break;
    }
    case 'outline.updated': {
      appendActivity(envelope);
      refreshAfterContentChange();
      break;
    }
    case 'usage.updated': {
      usage.update((state) => ({
        usage: payloadObject(envelope.payload, 'usage') ?? state.usage,
        budget: payloadObject(envelope.payload, 'budget') ?? state.budget,
        updatedAt: now,
      }));
      appendActivity(envelope);
      break;
    }
    case 'cocreate.progress': {
      appendCocreateFact(envelope);
      appendActivity(envelope, payloadString(envelope.payload, 'message') ?? payloadString(envelope.payload, 'stage'));
      break;
    }
    case 'import.progress': {
      appendImportFact(envelope);
      const total = payloadNumber(envelope.payload, 'total');
      const completed = payloadNumber(envelope.payload, 'completed');
      appendActivity(
        envelope,
        payloadString(envelope.payload, 'detail') ??
          (total !== undefined ? `${completed ?? 0}/${total}` : undefined),
      );
      break;
    }
    case 'simulation.progress': {
      appendSimulationFact(envelope);
      const total = payloadNumber(envelope.payload, 'total');
      const completed = payloadNumber(envelope.payload, 'completed');
      appendActivity(
        envelope,
        payloadString(envelope.payload, 'detail') ??
          (total !== undefined ? `${completed ?? 0}/${total}` : undefined),
      );
      break;
    }
    case 'diagnostics.completed': {
      const findings = payloadNumber(envelope.payload, 'findings');
      appendActivity(envelope, findings !== undefined ? `${findings} findings` : undefined);
      break;
    }
    case 'notification.info':
    case 'notification.warning':
    case 'notification.error': {
      const message = payloadString(envelope.payload, 'message') ?? envelope.event;
      pushNotification(
        envelope.event === 'notification.info' ? 'info' : envelope.event === 'notification.warning' ? 'warning' : 'error',
        message,
        {
          source: 'event',
          category:
            envelope.event === 'notification.warning' ? 'warning' : envelope.event === 'notification.error' ? 'failure' : undefined,
          details: envelope.payload.details,
        },
      );
      appendActivity(envelope, message);
      break;
    }
    default: {
      // Exhaustiveness guard: every catalog event is handled above.
      const exhausted: never = envelope.event;
      void exhausted;
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot / usage / replay
// ---------------------------------------------------------------------------

/**
 * Fetch the authoritative project snapshot. `project_unavailable` simply
 * means no project is open: clear the projection without raising an error.
 */
export async function refreshSnapshot(): Promise<void> {
  try {
    const payload = await fetchProjectSnapshot();
    projectSnapshot.set(payload as ProjectSnapshot);
    snapshotError.set(null);
    usage.update((state) => ({
      ...state,
      totals: {
        inputTokens: typeof payload.total_input_tokens === 'number' ? payload.total_input_tokens : state.totals?.inputTokens,
        outputTokens: typeof payload.total_output_tokens === 'number' ? payload.total_output_tokens : state.totals?.outputTokens,
        costUsd: typeof payload.total_cost_usd === 'number' ? payload.total_cost_usd : state.totals?.costUsd,
        budgetLimitUsd: typeof payload.budget_limit_usd === 'number' ? payload.budget_limit_usd : state.totals?.budgetLimitUsd,
      },
      updatedAt: Date.now(),
    }));
  } catch (raw) {
    const structured = toStructuredError(raw);
    if (structured.code === 'project_unavailable') {
      projectSnapshot.set(null);
      snapshotError.set(null);
      return;
    }
    if (structured.code === 'engine_unavailable') {
      const connection = get(connectionState);
      if (connection !== 'ready' && connection !== 'degraded') {
        // Startup race: the engine is not ready yet; the ready status signal
        // triggers the real resync. Not an error state.
        return;
      }
    }
    projectSnapshot.set(null);
    snapshotError.set(structured);
    reportError(raw, 'project.snapshot');
  }
}

export async function refreshUsage(): Promise<void> {
  try {
    const payload = await usageSnapshot();
    usage.update((state) => ({
      ...state,
      usage: payloadObject(payload, 'usage') ?? state.usage,
      budget: payloadObject(payload, 'budget') ?? state.budget,
      perAgent: Array.isArray(payload.per_agent) ? payload.per_agent : undefined,
      updatedAt: Date.now(),
    }));
  } catch (raw) {
    // Usage is non-critical; surface but never block.
    reportError(raw, 'usage.snapshot');
  }
}

/**
 * Replay buffered project events after `afterSequence` using the frontend's
 * applied cursor. Re-emitted events arrive through the normal deduped event
 * pipeline, so this is idempotent under duplicate delivery.
 */
async function replayFromCursor(): Promise<void> {
  const after = controller.lastSequence < 0 ? 0 : controller.lastSequence;
  try {
    await projectReplayEvents(after);
  } catch (raw) {
    const structured = toStructuredError(raw);
    // No project open: nothing to replay.
    if (structured.code !== 'project_unavailable') {
      reportError(raw, 'project.replay_events');
    }
  }
}

/**
 * Coalesced resync: snapshot + replay + usage. Triggered on session change
 * and on reconnect-to-ready; concurrent triggers collapse into one run with
 * a trailing re-run if another request arrived mid-flight.
 */
export function scheduleResync(): Promise<void> {
  if (controller.resyncInFlight) {
    controller.resyncQueued = true;
    return controller.resyncInFlight;
  }
  const run = (async () => {
    do {
      controller.resyncQueued = false;
      await refreshSnapshot();
      await replayFromCursor();
      await refreshUsage();
    } while (controller.resyncQueued);
  })().finally(() => {
    controller.resyncInFlight = null;
  });
  controller.resyncInFlight = run;
  return run;
}

// ---------------------------------------------------------------------------
// Session / connection handling
// ---------------------------------------------------------------------------

function applyProviderStatus(status: {
  health: string;
  session?: string | null;
  stopping?: boolean;
  restartAttempts?: number;
  restartsTotal?: number;
  malformedOutputLines?: number;
  lastError?: string | null;
  lastExitCode?: number | null;
}): void {
  engineState.update((state) => ({
    ...state,
    health: (status.health as EngineState['health']) ?? state.health,
    session: status.session ?? undefined,
    stopping: status.stopping ?? state.stopping,
    restartAttempts: status.restartAttempts ?? state.restartAttempts,
    restartsTotal: status.restartsTotal ?? state.restartsTotal,
    malformedOutputLines: status.malformedOutputLines ?? state.malformedOutputLines,
    lastError: status.lastError ?? undefined,
    lastExitCode: status.lastExitCode ?? null,
  }));
}

function mapStatusToConnection(
  health: string,
  stopping: boolean,
  previous: ConnectionState,
): ConnectionState {
  switch (health) {
    case 'ready':
      return previous === 'ready' || previous === 'degraded' ? previous : 'ready';
    case 'starting':
      return previous === 'reconnecting' ? 'reconnecting' : 'starting';
    case 'restarting':
      return 'reconnecting';
    case 'exited':
      return stopping ? 'stopped' : previous === 'stopped' ? 'stopped' : 'reconnecting';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    case 'degraded':
      return previous === 'ready' ? 'degraded' : previous;
    default:
      return previous;
  }
}

function handleStatusSignal(
  payload: {
    health: string;
    session?: string | null;
    graceful?: boolean;
    exitCode?: number | null;
    attempt?: number;
    attempts?: number;
    reason?: string;
    malformedOutputLines?: number;
  },
): void {
  const previous = get(connectionState);
  const stopping = payload.health === 'exited' ? payload.graceful === true : get(engineState).stopping;
  const next = mapStatusToConnection(payload.health, stopping, previous);
  connectionState.set(next);

  const wasReadyOrBetter = previous === 'ready' || previous === 'degraded';
  if (payload.health === 'ready') {
    // (Re)connected: resync projections. The first ready after boot syncs
    // too; scheduleResync coalesces repeats.
    if (!wasReadyOrBetter) scheduleResync().catch(() => undefined);
  } else if (payload.health === 'failed') {
    pushNotification('error', payload.reason ? `engine failed: ${payload.reason}` : 'engine failed', {
      source: 'status',
      code: 'sidecar_error',
    });
  } else if (payload.health === 'degraded') {
    pushNotification('warning', 'engine output is degraded (malformed protocol lines)', {
      source: 'status',
    });
  } else if (payload.health === 'restarting') {
    pushNotification('info', `engine restarting (attempt ${payload.attempt ?? 1})`, { source: 'status' });
  }

  applyProviderStatus({
    health: payload.health === 'degraded' ? 'ready' : payload.health,
    session: payload.session,
    malformedOutputLines: payload.malformedOutputLines,
    lastError: payload.reason,
    lastExitCode: payload.exitCode ?? undefined,
    restartAttempts: payload.attempt ?? payload.attempts,
  });
}

/** Session change: drop ordering state, then snapshot + replay under the new id. */
function handleSessionChange(change: { previous?: string | null; current?: string | null }): void {
  const current = change.current ?? null;
  // One recovery per transition: the `desktop://session` notice and the
  // shared deduper's session-change verdict both describe the same restart,
  // and the shell emits the new session's first event either before or after
  // the notice. Whichever side observes the transition first adopts the new
  // session id here; the other side then sees `current` already in effect
  // and must not re-run the recovery (one toast, one prompt, one resync).
  if (current !== null && controller.lastSession === current) {
    return;
  }
  const runBefore = get(runState);
  const projectWasOpen = get(projectSnapshot) !== null || runBefore.status === 'running';
  controller.lastSession = current;
  controller.lastSequence = -1;
  // Observed run/stream state belongs to the old session; the fresh
  // snapshot is authoritative. Whether to resume stays a user action.
  runState.set({ status: 'idle' });
  stream.update((state) => ({ entries: state.entries, channels: state.channels, lastSequence: -1 }));
  if (projectWasOpen) {
    // Interrupted observed work: demand an explicit resume / inspect /
    // close decision. Never resume automatically (README §4).
    recoveryPrompt.set({
      at: Date.now(),
      previousSession: change.previous ?? null,
      currentSession: change.current ?? null,
      runStatusBefore: runBefore.status,
      projectWasOpen: true,
    });
  }
  pushNotification('info', 'engine session changed — resynchronizing', { source: 'status' });
  scheduleResync().catch(() => undefined);
}

function handleEngineDelivery(delivery: EngineEventDelivery): void {
  if (delivery.kind === 'session-change') {
    // Envelope carried a new session before/without the desktop://session
    // notice; run the same recovery.
    handleSessionChange({ previous: delivery.previous, current: delivery.current });
    applyEngineEvent(delivery.envelope);
    controller.lastSequence = delivery.envelope.sequence;
    return;
  }
  if (delivery.kind === 'duplicate') {
    controller.duplicatesTolerated += 1;
    return; // Exact re-delivery: tolerated, not applied twice.
  }
  const envelope = delivery.envelope;
  const session = envelope.session ?? null;
  // Sequence must advance within a session; equal-or-lower is a duplicate.
  if (envelope.sequence <= controller.lastSequence && session === controller.lastSession) {
    controller.duplicatesTolerated += 1;
    return;
  }
  controller.lastSession = session;
  controller.lastSequence = envelope.sequence;
  applyEngineEvent(envelope);
}

// ---------------------------------------------------------------------------
// Lifecycle: init / dispose + engine controls
// ---------------------------------------------------------------------------

/**
 * Startup handshake:
 * 1. `desktop_status` — adopt current health.
 * 2. If the engine is not running yet, `desktop_start` (readiness wait is
 *    shell-side).
 * 3. Subscribe to events, session changes, and status signals (idempotent).
 * 4. On ready: snapshot + replay + usage (scheduleResync).
 *
 * Runs in the Tauri webview; in a plain browser (no bridge) it degrades to a
 * notice instead of throwing, so `vite dev` keeps working for UI work.
 */
export async function initDesktop(): Promise<void> {
  if (controller.initialized) return;
  controller.initialized = true;

  if (!hasTauriBridge()) {
    connectionState.set('stopped');
    pushNotification(
      'warning',
      'Tauri bridge not available — run the app through the desktop shell (tauri dev) to talk to the engine.',
      { source: 'status' },
    );
    return;
  }

  connectionState.set('booting');
  try {
    const status = await getStatus();
    applyProviderStatus(status);
    const needsStart = status.health !== 'ready' && status.health !== 'starting' && status.health !== 'restarting';
    if (needsStart) {
      connectionState.set('starting');
      try {
        const started = await startEngine();
        applyProviderStatus(started);
      } catch (raw) {
        connectionState.set('failed');
        reportError(raw, 'desktop_start');
        return;
      }
    }
  } catch (raw) {
    connectionState.set('failed');
    reportError(raw, 'desktop_status');
    return;
  }

  await attachSubscriptions();

  // Seed the dedupe window from the shell's authoritative bookkeeping so
  // live events forwarded before our subscription are not re-expected.
  try {
    const eventState = await getEventState();
    if (eventState.session ?? null) controller.lastSession = eventState.session ?? null;
    if (typeof eventState.lastSequence === 'number' && eventState.lastSequence > controller.lastSequence) {
      controller.lastSequence = eventState.lastSequence;
    }
  } catch {
    // Purely informational; live events still work.
  }

  if (get(engineState).health === 'ready') {
    connectionState.set('ready');
    await scheduleResync().catch(() => undefined);
  } else {
    // Still starting/restarting: the `desktop://status` ready signal owns
    // the first resync.
    connectionState.set('starting');
  }
}

async function attachSubscriptions(): Promise<void> {
  if (controller.unlisteners.length > 0) return;
  try {
    // One shared dedupe window: the desktop://session notice resets it, so a
    // restart is recovered exactly once (see handleSessionChange).
    const deduper = new EventDeduper();
    const unlistenEvents = await subscribeEngineEvents(handleEngineDelivery, { deduper });
    const unlistenSession = await subscribeSessionChanges(handleSessionChange, { deduper });
    const unlistenStatus = await subscribeStatus(handleStatusSignal);
    controller.unlisteners.push(unlistenEvents, unlistenSession, unlistenStatus);
  } catch (raw) {
    reportError(raw, 'event subscription');
  }
}

/** Detach subscriptions and reset stores (used by tests and hot reload). */
export async function disposeDesktop(): Promise<void> {
  for (const unlisten of controller.unlisteners.splice(0)) {
    try {
      unlisten();
    } catch {
      // Ignore double-unlisten races.
    }
  }
  controller.initialized = false;
  controller.lastSession = null;
  controller.lastSequence = -1;
  controller.duplicatesTolerated = 0;
  controller.resyncInFlight = null;
  controller.resyncQueued = false;
  connectionState.set('booting');
  engineState.set({
    health: 'stopped',
    stopping: false,
    restartAttempts: 0,
    restartsTotal: 0,
    malformedOutputLines: 0,
  });
  projectSnapshot.set(null);
  snapshotError.set(null);
  activity.set([]);
  chapterEvents.set([]);
  cocreateEvents.set([]);
  importProgressEvents.set([]);
  simulationProgressEvents.set([]);
  stream.set({ entries: [], channels: {}, lastSequence: -1 });
  runState.set({ status: 'idle' });
  usage.set({});
  notifications.set([]);
  notificationPrefs.set({ ...NOTIFICATION_PREF_DEFAULTS });
  recoveryPrompt.set(null);
}

// ---------------------------------------------------------------------------
// Project + engine controls (commands issued by UI, decisions stay engine-side)
// ---------------------------------------------------------------------------

export async function openProject(path: string): Promise<void> {
  await projectOpen(path);
  await scheduleResync();
}

export async function createProject(path: string, name?: string): Promise<void> {
  await projectCreate(path, name);
  await scheduleResync();
}

export async function closeProject(force?: boolean): Promise<void> {
  try {
    await projectClose(force);
  } finally {
    projectSnapshot.set(null);
    snapshotError.set(null);
    recoveryPrompt.set(null);
  }
}

// ---------------------------------------------------------------------------
// Recovery choice (explicit user action after an interrupted session)
// ---------------------------------------------------------------------------

/** "Inspect": keep everything visible, drop the prompt. No engine command. */
export function dismissRecoveryPrompt(): void {
  recoveryPrompt.set(null);
}

/**
 * "Resume": `project.resume` with NO checkpoint id — the engine always
 * resumes the latest checkpoint and rejects explicit `checkpoint_id`
 * payloads with `invalid_payload`. On acceptance the engine emits
 * `run.started` (which also clears any prompt state).
 */
export async function resumeRecoveredProject(): Promise<void> {
  try {
    await projectResume();
    recoveryPrompt.set(null);
    pushNotification('info', 'resume requested — waiting for the engine to confirm', { source: 'status' });
  } catch (raw) {
    // Prompt stays up: the interruption is unresolved.
    reportError(raw, 'project.resume');
  }
}

export async function startEngineFromUi(): Promise<void> {
  try {
    const status = await startEngine();
    applyProviderStatus(status);
    connectionState.set(status.health === 'ready' ? 'ready' : 'starting');
  } catch (raw) {
    reportError(raw, 'desktop_start');
  }
}

export async function restartEngineFromUi(reason?: string): Promise<void> {
  connectionState.set('reconnecting');
  try {
    const status = await restartEngine(reason);
    applyProviderStatus(status);
  } catch (raw) {
    connectionState.set('failed');
    reportError(raw, 'desktop_restart');
  }
}

export async function shutdownEngineFromUi(reason?: string): Promise<void> {
  engineState.update((state) => ({ ...state, stopping: true }));
  try {
    const status = await shutdownEngine(reason);
    applyProviderStatus(status);
    connectionState.set('stopped');
  } catch (raw) {
    reportError(raw, 'desktop_shutdown');
  } finally {
    engineState.update((state) => ({ ...state, stopping: false }));
  }
}

// ---------------------------------------------------------------------------
// Diagnostics accessors
// ---------------------------------------------------------------------------

/** Frontend-side event bookkeeping, for the diagnostics screen. */
export function eventBookkeeping(): {
  lastSession: string | null;
  lastSequence: number;
  duplicatesTolerated: number;
  pendingResync: boolean;
} {
  return {
    lastSession: controller.lastSession,
    lastSequence: controller.lastSequence,
    duplicatesTolerated: controller.duplicatesTolerated,
    pendingResync: controller.resyncQueued || controller.resyncInFlight !== null,
  };
}

/** Structured error helper re-export for UI convenience. */
export { DesktopApiError };

// ---------------------------------------------------------------------------
// Engine session observation (feature controllers)
// ---------------------------------------------------------------------------

/**
 * Observe engine session id changes (sidecar restart). Daemon-resident state
 * — the co-create session, in-flight import/simulation handles — dies with
 * the process; controllers drop their staged projections when this fires.
 * The initial observation only records the baseline.
 */
export function onEngineSessionChange(listener: (previous: string, current: string) => void): () => void {
  let last: string | undefined;
  return engineState.subscribe((state) => {
    const session = state.session;
    if (session !== undefined && session !== last) {
      if (last !== undefined) listener(last, session);
      last = session;
    }
  });
}
