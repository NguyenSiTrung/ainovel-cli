/**
 * UI-facing types for the desktop-v1 protocol and the Tauri shell boundary.
 *
 * Sources of truth:
 * - `protocols/desktop-v1/README.md` (envelopes, catalogs, semantics)
 * - `protocols/desktop-v1/commands.schema.json` / `events.schema.json`
 *   (payload field names)
 * - `desktop/src-tauri` command + event surface (task 3 report):
 *   `desktop_request`, `desktop_status`, `desktop_start`, `desktop_shutdown`,
 *   `desktop_restart`, `desktop_event_state`, `desktop_paths`,
 *   `desktop_validate_project_dir`, and the `desktop://event`,
 *   `desktop://session`, `desktop://status` Tauri events.
 *
 * Rules encoded here:
 * - Payload objects are OPEN: unknown payload fields must be ignored
 *   (forward compatibility, README §9). Types therefore use optional known
 *   fields plus an index signature where the engine's shape is authoritative.
 * - Unknown event names must be ignored by the UI; `EventName` covers the 26
 * - Errors are structured `{code, message, details?}`; the 9 protocol codes
 *   plus the 4 shell-extension codes are first-class.
 */
import { t } from '$lib/locale';

// ---------------------------------------------------------------------------
// Protocol identity
// ---------------------------------------------------------------------------

export const PROTOCOL_ID = 'desktop-v1' as const;

// ---------------------------------------------------------------------------
// Method catalog (48 methods, README §6)
// ---------------------------------------------------------------------------

export type MethodName =
  // engine
  | 'engine.ping'
  | 'engine.shutdown'
  // project
  | 'project.create'
  | 'project.open'
  | 'project.close'
  | 'project.snapshot'
  | 'project.resume'
  | 'project.replay_events'
  // run
  | 'run.start'
  | 'run.continue'
  | 'run.steer'
  | 'run.abort'
  | 'run.pause'
  | 'run.advance_one_chapter'
  | 'run.set_advance_mode'
  | 'run.retry'
  // cocreate
  | 'cocreate.start'
  | 'cocreate.stage'
  | 'cocreate.resume'
  | 'cocreate.cancel'
  // chapter / revision / export
  | 'chapter.list'
  | 'chapter.read'
  | 'chapter.save'
  | 'chapter.revisions.check'
  | 'chapter.revisions.sync'
  | 'chapter.export'
  // artifacts (read-only projections: facts / world / summary)
  | 'artifacts.read'
  // import
  | 'import.start'
  | 'import.resume'
  | 'import.cancel'
  // simulation
  | 'simulation.start'
  | 'simulation.resume'
  | 'simulation.cancel'
  | 'simulation.profile_import'
  // configuration
  | 'config.get'
  | 'config.update'
  | 'config.providers'
  | 'config.models'
  | 'config.switch_model'
  | 'config.thinking_levels'
  | 'config.set_thinking'
  | 'config.set_language'
  | 'config.set_story_language'
  // diagnostics / usage / logs / runtime
  | 'diagnostics.snapshot'
  | 'diagnostics.export'
  | 'usage.snapshot'
  | 'logs.replay'
  | 'runtime.queue';

// ---------------------------------------------------------------------------
// Event catalog (26 events, README §7) with payload field names from
// events.schema.json (`<event>_event` definitions).
// ---------------------------------------------------------------------------

export type EventName =
  | 'engine.ready'
  | 'engine.status_changed'
  | 'engine.error'
  | 'engine.exited'
  | 'engine.restarting'
  | 'run.started'
  | 'run.step_changed'
  | 'run.progress'
  | 'run.paused'
  | 'run.completed'
  | 'run.failed'
  | 'run.aborted'
  | 'stream.delta'
  | 'stream.clear'
  | 'checkpoint.created'
  | 'artifact.updated'
  | 'chapter.updated'
  | 'outline.updated'
  | 'usage.updated'
  | 'cocreate.progress'
  | 'import.progress'
  | 'simulation.progress'
  | 'diagnostics.completed'
  | 'notification.info'
  | 'notification.warning'
  | 'notification.error';

/** Loose JSON value used for open payload objects and `error.details`. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

// ---------------------------------------------------------------------------
// Structured errors (9 protocol codes + 4 shell-extension codes)
// ---------------------------------------------------------------------------

export type ProtocolErrorCode =
  | 'malformed_json'
  | 'invalid_payload'
  | 'unknown_method'
  | 'duplicate_request_id'
  | 'project_unavailable'
  | 'host_busy'
  | 'operation_failed'
  | 'cancelled'
  | 'internal_error';

export type ShellErrorCode =
  | 'engine_unavailable'
  | 'request_timeout'
  | 'sidecar_error'
  | 'invalid_path';

/** All 13 stable codes the frontend must be able to present. */
export type ErrorCode = ProtocolErrorCode | ShellErrorCode;

/**
 * Unknown additive codes are valid at runtime (README §9): keep the raw
 * string while carrying the known-code union for exhaustive switching.
 */
export type AnyErrorCode = ErrorCode | (string & {});

export interface StructuredError {
  readonly code: AnyErrorCode;
  readonly message: string;
  readonly details?: Json;
}

/** Compile-time exhaustiveness guard for code switches. */
export function assertNever(value: never): never {
  throw new Error(`unhandled variant: ${String(value)}`);
}

// ---------------------------------------------------------------------------
// Envelopes (README §2) — as delivered to the UI
// ---------------------------------------------------------------------------

/** `desktop://event` payload forwarded by the Rust shell (already deduped). */
export interface ForwardedEvent {
  readonly event: string;
  readonly session?: string | null;
  readonly sequence: number;
  readonly projectId?: string | null;
  readonly payload?: JsonObject | null;
}

/** UI-shaped engine event (normalized from `ForwardedEvent`). */
export interface EventEnvelope {
  readonly event: EventName;
  readonly session?: string;
  readonly sequence: number;
  readonly projectId?: string;
  readonly payload: JsonObject;
}

/** `desktop://session` payload: refetch snapshot + replay. */
export interface SessionChangePayload {
  readonly previous?: string | null;
  readonly current?: string | null;
  readonly lastSequence?: number | null;
}

/** `desktop://status` payload: `health` plus transition detail. */
export interface StatusEventPayload {
  /** The status signal adds `degraded` (malformed engine output) on top of ProviderStatus.health. */
  readonly health: EngineHealth | 'degraded';
  readonly session?: string | null;
  readonly graceful?: boolean;
  readonly exitCode?: number | null;
  readonly attempt?: number;
  readonly attempts?: number;
  readonly reason?: string;
  readonly malformedOutputLines?: number;
  readonly [key: string]: Json | undefined;
}

// ---------------------------------------------------------------------------
// Per-event payload shapes (required/optional fields per events.schema.json)
// ---------------------------------------------------------------------------

export interface EngineReadyPayload {
  recovered?: boolean;
  [key: string]: Json | undefined;
}
export interface EngineStatusChangedPayload {
  status: string;
  [key: string]: Json | undefined;
}
export interface EngineErrorPayload {
  message: string;
  code?: string;
  details?: Json;
  [key: string]: Json | undefined;
}
export interface EngineExitedPayload {
  reason?: string;
  exit_code?: number;
  [key: string]: Json | undefined;
}
export interface EngineRestartingPayload {
  attempt?: number;
  reason?: string;
  [key: string]: Json | undefined;
}
export interface RunStartedPayload {
  run_id?: string;
  goal?: string;
  [key: string]: Json | undefined;
}
export interface RunStepChangedPayload {
  step: string;
  [key: string]: Json | undefined;
}
export interface RunProgressPayload {
  completed?: number;
  total?: number;
  detail?: string;
  [key: string]: Json | undefined;
}
export interface RunPausedPayload {
  reason?: string;
  [key: string]: Json | undefined;
}
export interface RunCompletedPayload {
  summary?: JsonObject;
  [key: string]: Json | undefined;
}
export interface RunFailedPayload {
  message: string;
  code?: string;
  [key: string]: Json | undefined;
}
export interface RunAbortedPayload {
  reason?: string;
  [key: string]: Json | undefined;
}
export interface StreamDeltaPayload {
  text: string;
  channel?: string;
  [key: string]: Json | undefined;
}
export interface StreamClearPayload {
  channel?: string;
  reason?: string;
  [key: string]: Json | undefined;
}
export interface CheckpointCreatedPayload {
  checkpoint_id: string;
  step?: string;
  [key: string]: Json | undefined;
}
export interface ArtifactUpdatedPayload {
  artifact: string;
  version?: number;
  path?: string;
  [key: string]: Json | undefined;
}
export interface ChapterUpdatedPayload {
  chapter: Json;
  version?: number;
  status?: string;
  [key: string]: Json | undefined;
}
export interface OutlineUpdatedPayload {
  version?: number;
  [key: string]: Json | undefined;
}
export interface UsageUpdatedPayload {
  usage?: JsonObject;
  budget?: JsonObject;
  [key: string]: Json | undefined;
}
export interface CocreateProgressPayload {
  stage: string;
  message?: string;
  [key: string]: Json | undefined;
}
export interface ImportProgressPayload {
  completed?: number;
  total?: number;
  detail?: string;
  [key: string]: Json | undefined;
}
export interface SimulationProgressPayload extends ImportProgressPayload {}
export interface DiagnosticsCompletedPayload {
  findings?: number;
  output_path?: string;
  [key: string]: Json | undefined;
}
export interface NotificationPayload {
  message: string;
  details?: Json;
  [key: string]: Json | undefined;
}

/** Typed payload lookup for the 26 catalog events. */
export interface EventPayloadMap {
  'engine.ready': EngineReadyPayload;
  'engine.status_changed': EngineStatusChangedPayload;
  'engine.error': EngineErrorPayload;
  'engine.exited': EngineExitedPayload;
  'engine.restarting': EngineRestartingPayload;
  'run.started': RunStartedPayload;
  'run.step_changed': RunStepChangedPayload;
  'run.progress': RunProgressPayload;
  'run.paused': RunPausedPayload;
  'run.completed': RunCompletedPayload;
  'run.failed': RunFailedPayload;
  'run.aborted': RunAbortedPayload;
  'stream.delta': StreamDeltaPayload;
  'stream.clear': StreamClearPayload;
  'checkpoint.created': CheckpointCreatedPayload;
  'artifact.updated': ArtifactUpdatedPayload;
  'chapter.updated': ChapterUpdatedPayload;
  'outline.updated': OutlineUpdatedPayload;
  'usage.updated': UsageUpdatedPayload;
  'cocreate.progress': CocreateProgressPayload;
  'import.progress': ImportProgressPayload;
  'simulation.progress': SimulationProgressPayload;
  'diagnostics.completed': DiagnosticsCompletedPayload;
  'notification.info': NotificationPayload;
  'notification.warning': NotificationPayload;
  'notification.error': NotificationPayload;
}

export function isKnownEventName(name: string): name is EventName {
  return Object.prototype.hasOwnProperty.call(EVENT_NAMES, name);
}

export const EVENT_NAMES: Readonly<Record<EventName, true>> = {
  'engine.ready': true,
  'engine.status_changed': true,
  'engine.error': true,
  'engine.exited': true,
  'engine.restarting': true,
  'run.started': true,
  'run.step_changed': true,
  'run.progress': true,
  'run.paused': true,
  'run.completed': true,
  'run.failed': true,
  'run.aborted': true,
  'stream.delta': true,
  'stream.clear': true,
  'checkpoint.created': true,
  'artifact.updated': true,
  'chapter.updated': true,
  'outline.updated': true,
  'usage.updated': true,
  'cocreate.progress': true,
  'import.progress': true,
  'simulation.progress': true,
  'diagnostics.completed': true,
  'notification.info': true,
  'notification.warning': true,
  'notification.error': true,
};

// ---------------------------------------------------------------------------
// Tauri shell command results (task 3, camelCase over the JS bridge)
// ---------------------------------------------------------------------------

export type EngineHealth =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'exited'
  | 'failed';

/** Result of `desktop_status` / `desktop_start` / `desktop_shutdown` / `desktop_restart`. */
export interface ProviderStatus {
  provider: string;
  protocol: string;
  health: EngineHealth;
  stopping: boolean;
  session?: string | null;
  pid?: number | null;
  restartAttempts: number;
  restartsTotal: number;
  malformedOutputLines: number;
  stderrLines: number;
  lastError?: string | null;
  lastExitCode?: number | null;
}

/** Result of `desktop_event_state` — `lastSequence` is the replay cursor. */
export interface EventState {
  session?: string | null;
  lastSequence?: number | null;
  sessionsSeen: number;
  duplicatesDropped: number;
  forwardedCount: number;
  sessionChanges: number;
}

/** Result of `desktop_paths`. */
export interface DesktopPaths {
  appDataDir: string;
  projectsDir: string;
  sidecarPath?: string | null;
  sidecarSource?: string | null;
  targetTriple: string;
}

/** Result of `desktop_validate_project_dir`. */
export interface ProjectDirReport {
  path: string;
  recognized: boolean;
}

// ---------------------------------------------------------------------------
// UI projection state (stores own disposable session state only)
// ---------------------------------------------------------------------------

export type ConnectionState =
  | 'booting' // initial handshake in progress
  | 'starting' // engine start requested / health=starting
  | 'ready' // engine ready and projections synced
  | 'reconnecting' // engine restarting after an unexpected exit
  | 'degraded' // engine ready but the protocol stream is degraded
  | 'failed' // engine failed and is not coming back automatically
  | 'stopped'; // engine intentionally shut down

export interface EngineState {
  health: EngineHealth;
  session?: string;
  status?: string; // payload.status of engine.status_changed (idle/running/paused/...)
  stopping: boolean;
  restartAttempts: number;
  restartsTotal: number;
  malformedOutputLines: number;
  lastError?: string;
  lastExitCode?: number | null;
}

/** One outline row as returned by project.snapshot. */
export interface OutlineEntry {
  chapter?: number | string;
  title?: string;
  core_event?: string;
}

/**
 * Loose projection of `project.snapshot`. Field names mirror the Go
 * adapter's `snapshotPayload` (internal/entry/desktop/project.go); every
 * field is optional and unknown fields are ignored per README §9 (hence
 * the open `unknown` index signature).
 */
export interface ProjectSnapshot {
  state?: string;
  status_label?: string;
  phase?: string;
  flow?: string;
  running?: boolean;
  book_title?: string;
  synopsis?: string;
  premise?: string;
  style?: string;
  provider?: string;
  model?: string;
  thinking_level?: string;
  current_chapter?: number;
  total_chapters?: number;
  completed_chapters?: number;
  total_word_count?: number;
  in_progress_chapter?: number;
  pending_rewrites?: number;
  advance_mode?: string;
  advance_permit_chapter?: number;
  has_advance_hold?: boolean;
  advance_hold_reason?: string;
  recovery_label?: string;
  pending_steer?: boolean;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cost_usd?: number;
  budget_limit_usd?: number;
  layered?: boolean;
  current_volume_arc?: string;
  outline?: OutlineEntry[];
  characters?: Json[];
  [key: string]: unknown;
}

/** Observed run facts (passive projection — no workflow transitions encoded). */
export type RunStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface RunState {
  status: RunStatus;
  runId?: string;
  goal?: string;
  step?: string;
  progress?: {
    completed?: number;
    total?: number;
    detail?: string;
    at: number;
  };
  /** Observed pause facts (run.paused payload); cleared by run.started. */
  pause?: {
    reason?: string;
    /** true when the engine paused at a chapter gate awaiting authorization. */
    advanceHold?: boolean;
    at: number;
  };
  /** Set by the terminal run.* event that produced the current status. */
  terminal?: {
    kind: 'run.completed' | 'run.failed' | 'run.aborted';
    at: number;
    message?: string;
    code?: string;
    reason?: string;
    summary?: JsonObject;
  };
  lastEventAt?: number;
}

export type StreamEntry =
  | { kind: 'text'; channel: string; text: string; sequence: number; at: number }
  | { kind: 'clear'; channel: string; reason?: string; sequence: number; at: number };

export interface StreamChannelState {
  /** Current accumulated text since the last clear marker. */
  text: string;
  /** Increments on every stream.clear so the UI can key re-renders. */
  revision: number;
}

export interface StreamState {
  entries: StreamEntry[];
  channels: Record<string, StreamChannelState>;
  lastSequence: number;
}

export interface UsageState {
  /** Latest usage counters (loose, engine-defined). */
  usage?: JsonObject;
  /** Latest budget state (loose, engine-defined). */
  budget?: JsonObject;
  /** Per-agent counters from usage.snapshot (loose, engine-defined). */
  perAgent?: Json[];
  /** From project.snapshot token/cost counters, when available. */
  totals?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    budgetLimitUsd?: number;
  };
  updatedAt?: number;
}

export interface ActivityEntry {
  id: number;
  sequence: number;
  session?: string;
  event: EventName;
  projectId?: string;
  at: number;
  summary?: string;
}

/**
 * One observed `chapter.updated` fact (chapter number + version/status as
 * reported by the engine). Chapter-level screens consume these as the update
 * signal: the daemon does not emit artifact/outline events (task-2 concern),
 * so chapter facts + snapshot refreshes are how the UI learns about changes.
 */
export interface ChapterUpdateFact {
  id: number;
  sequence: number;
  chapter: number;
  version?: number;
  status?: string;
  /** True when the fact came from a revision sync (status:"synced"). */
  synced: boolean;
  at: number;
}

/**
 * One observed `cocreate.progress` fact. Terminal replies carry
 * stage:"assistant" plus the staged draft fields (ready/draft/suggestions);
 * every other stage is a streaming preview (thinking/reply) whose message is
 * the accumulated text for that stage (replace, not append — the engine's
 * CoCreateSession.ApplyDelta contract).
 */
export interface CocreateProgressFact {
  id: number;
  sequence: number;
  at: number;
  stage: string;
  message?: string;
  /** Terminal replies only: the session believes the draft is complete. */
  ready?: boolean;
  /** Terminal replies only: the staged draft text ("" = keep previous). */
  draft?: string;
  /** Terminal replies only: follow-up suggestion chips. */
  suggestions?: string[];
}

/** One observed `import.progress` fact (daemon drain payload, open shape). */
export interface ImportProgressFact {
  id: number;
  sequence: number;
  at: number;
  /** Engine stage name (ingesting/…/done/error). Terminal: "done". */
  stage?: string;
  completed?: number;
  total?: number;
  detail?: string;
  /** "warn" notes from the engine (e.g. provider retries). */
  level?: string;
  /** Present on retry warnings. */
  retryAt?: string;
  /** Present on stage failure — structural failure signal. */
  error?: string;
  /** Terminal "done" only: the engine auto-continued into a run. */
  continued?: boolean;
}

/** One observed `simulation.progress` fact (same drain shape as import). */
export interface SimulationProgressFact {
  id: number;
  sequence: number;
  at: number;
  stage?: string;
  completed?: number;
  total?: number;
  detail?: string;
  error?: string;
}

export type NotificationLevel = 'info' | 'warning' | 'error';

/**
 * Notification routing categories (task 8): the engine-event kinds the user
 * can mute in Settings (completion / pause / warning / failure toasts).
 * Uncategorized notifications (request errors, info notes) always surface.
 */
export type NotificationCategory = 'completion' | 'pause' | 'warning' | 'failure';

export interface AppNotification {
  id: number;
  level: NotificationLevel;
  message: string;
  details?: Json;
  /** Where this notification came from (presentation only). */
  source: 'event' | 'error' | 'status';
  code?: AnyErrorCode;
  /** Present when the notification belongs to a mutable event category. */
  category?: NotificationCategory;
  at: number;
}

/**
 * Explicit recovery choice demanded after an engine session change that
 * interrupted observed work (README §4: whether to resume, inspect, or
 * close is a user action; the client never guesses). Set by the stores on
 * session change; cleared only by an explicit user decision (or by the
 * engine itself starting a run, e.g. an accepted `project.resume`).
 */
export interface RecoveryPrompt {
  at: number;
  previousSession: string | null;
  currentSession: string | null;
  /** Observed run status at the moment the session changed (context only). */
  runStatusBefore: RunStatus;
  /** True when a project was open (or a run active) when it happened. */
  projectWasOpen: boolean;
}

// ---------------------------------------------------------------------------
// Error presentation (all 13 codes map to user-presentable states)
// ---------------------------------------------------------------------------

export type ErrorSeverity = 'info' | 'warning' | 'error';

export interface ErrorPresentation {
  title: string;
  description: string;
  severity: ErrorSeverity;
  /** Suggested user action; presentation only, never auto-executed. */
  action?: string;
}

export const ERROR_CATALOG: Record<ErrorCode, ErrorPresentation> = {
  malformed_json: {
    title: 'Protocol noise',
    description: 'The engine received a line it could not parse.',
    severity: 'warning',
    action: 'If this repeats, restart the engine from Diagnostics.',
  },
  invalid_payload: {
    title: 'Invalid request',
    description: 'A request was rejected because its payload was invalid.',
    severity: 'warning',
  },
  unknown_method: {
    title: 'Unsupported command',
    description: 'This version of the engine does not implement that command.',
    severity: 'warning',
  },
  duplicate_request_id: {
    title: 'Duplicate request',
    description: 'The same request was sent twice while still in flight.',
    severity: 'warning',
  },
  project_unavailable: {
    title: 'No project open',
    description: 'This action needs an open project.',
    severity: 'info',
    action: 'Open or create a project first.',
  },
  host_busy: {
    title: 'Engine busy',
    description: 'Another exclusive operation is already active.',
    severity: 'warning',
    action: 'Wait for it to finish, or abort it first.',
  },
  operation_failed: {
    title: 'Operation failed',
    description: 'The engine attempted the operation and it failed.',
    severity: 'error',
  },
  cancelled: {
    title: 'Cancelled',
    description: 'The operation was cancelled before completing.',
    severity: 'info',
  },
  internal_error: {
    title: 'Engine error',
    description: 'The engine reported an internal failure; its state may be inconsistent.',
    severity: 'error',
    action: 'Check Diagnostics, then consider restarting the engine.',
  },
  engine_unavailable: {
    title: 'Engine unavailable',
    description: 'The engine is not running or died while handling the request.',
    severity: 'error',
    action: 'Wait for the automatic restart, or start the engine again.',
  },
  request_timeout: {
    title: 'Request timed out',
    description: 'The engine did not answer in time.',
    severity: 'error',
  },
  sidecar_error: {
    title: 'Engine process error',
    description: 'The engine process could not be started or supervised.',
    severity: 'error',
    action: 'Check that the engine binary is available, then retry.',
  },
  invalid_path: {
    title: 'Invalid path',
    description: 'The path was rejected by native validation.',
    severity: 'warning',
    action: 'Pick an absolute path without traversal segments.',
  },
};

/**
 * Presentation for any code, including additive unknown codes (§9).
 *
 * Strings resolve through the tiny en/vi/zh chrome catalog (`$lib/locale`);
 * severity stays here beside the stable code contract. `ERROR_CATALOG`
 * remains the English reference table (and the severity source); the empty
 * action (`''`) means "no suggested action" and is omitted like before.
 */
export function presentError(code: AnyErrorCode): ErrorPresentation {
  if (Object.prototype.hasOwnProperty.call(ERROR_CATALOG, code)) {
    const known = code as ErrorCode;
    const action = t(`error.${known}.action`);
    return {
      title: t(`error.${known}.title`),
      description: t(`error.${known}.description`),
      severity: ERROR_CATALOG[known].severity,
      ...(action === '' ? {} : { action }),
    };
  }
  const fallbackAction = t('error.unknown.action');
  return {
    title: t('error.unknown.title'),
    description: t('error.unknown.description'),
    severity: 'warning',
    ...(fallbackAction === '' ? {} : { action: fallbackAction }),
  };
}
