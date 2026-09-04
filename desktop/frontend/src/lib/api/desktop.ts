/**
 * Typed wrappers over the task-3 Tauri command and event surface.
 *
 * Commands consumed (see desktop/src-tauri/src/commands.rs):
 *   desktop_request(method, payload?) -> response payload object
 *   desktop_status() -> ProviderStatus
 *   desktop_start() -> Promise<ProviderStatus>
 *   desktop_shutdown(reason?) -> Promise<ProviderStatus>
 *   desktop_restart(reason?) -> Promise<ProviderStatus>
 *   desktop_event_state() -> EventState
 *   desktop_paths() -> Promise<DesktopPaths>
 *   desktop_validate_project_dir(path) -> Promise<ProjectDirReport>
 *
 * Events consumed:
 *   desktop://event   {event, session, sequence, projectId, payload}
 *   desktop://session {previous, current, lastSequence}
 *   desktop://status  {health, ...detail}
 *
 * Every command failure rejects with a structured `{code, message, details?}`
 * (the 9 protocol codes plus engine_unavailable / request_timeout /
 * sidecar_error / invalid_path). This module normalizes any rejection into
 * a `DesktopApiError` so callers never see raw strings.
 *
 * The frontend attaches its own request ids for diagnostics: the Rust shell
 * performs the actual wire-level id correlation (exactly one response per
 * request); we tag each call so failures can be traced and so concurrent
 * calls are observably distinct. Unknown payload/event fields and unknown
 * event names are ignored (README §9).
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import {
  isKnownEventName,
  type DesktopPaths,
  type EventEnvelope,
  type EventName,
  type EventState,
  type ForwardedEvent,
  type JsonObject,
  type MethodName,
  type ProjectDirReport,
  type ProviderStatus,
  type SessionChangePayload,
  type StatusEventPayload,
  type StructuredError,
} from '$lib/types/protocol';

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

/** True when running inside the Tauri webview (the @tauri-apps bridge exists). */
export function hasTauriBridge(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// ---------------------------------------------------------------------------
// Structured error normalization
// ---------------------------------------------------------------------------

/** Error thrown by every wrapper in this module. Carries the stable code. */
export class DesktopApiError extends Error {
  readonly code: string;
  readonly details?: unknown;
  /** Frontend-attached request id (diagnostics only). */
  readonly requestId?: string;

  constructor(structured: StructuredError, requestId?: string) {
    super(structured.message);
    this.name = 'DesktopApiError';
    this.code = structured.code;
    this.details = structured.details;
    this.requestId = requestId;
  }

  is(code: string): boolean {
    return this.code === code;
  }
}

/**
 * Normalize any rejection value into the structured error shape.
 * Handles: the shell's `{code, message, details?}` object, plain strings
 * (older serialization), and anything else (mapped to internal_error).
 */
export function toStructuredError(raw: unknown): StructuredError {
  if (raw instanceof DesktopApiError) {
    return { code: raw.code, message: raw.message, details: raw.details as StructuredError['details'] };
  }
  if (typeof raw === 'object' && raw !== null) {
    const rec = raw as Record<string, unknown>;
    if (typeof rec.code === 'string' && typeof rec.message === 'string') {
      return {
        code: rec.code,
        message: rec.message,
        details: rec.details as StructuredError['details'],
      };
    }
    if (typeof rec.message === 'string') {
      // Shape without a code (unexpected, but keep the message).
      return { code: 'internal_error', message: rec.message };
    }
  }
  if (typeof raw === 'string' && raw.length > 0) {
    return { code: 'internal_error', message: raw };
  }
  return { code: 'internal_error', message: 'unexpected command failure' };
}

// ---------------------------------------------------------------------------
// Request ids
// ---------------------------------------------------------------------------

let requestCounter = 0;
const pendingRequests = new Map<string, { method: string; startedAt: number }>();

function nextRequestId(): string {
  requestCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `ui-${Date.now().toString(36)}-${requestCounter.toString(36)}-${rand}`;
}

/** Requests currently in flight (diagnostics; keyed by frontend request id). */
export function pendingRequestCount(): number {
  return pendingRequests.size;
}

/** Snapshot of in-flight requests, for the diagnostics screen. */
export function pendingRequestSnapshot(): Array<{ requestId: string; method: string; startedAt: number }> {
  return [...pendingRequests.entries()].map(([requestId, info]) => ({ requestId, ...info }));
}

// ---------------------------------------------------------------------------
// Generic request
// ---------------------------------------------------------------------------

/**
 * Send one desktop-v1 request through the shell and await exactly one
 * response. Resolves with the response payload; rejects with
 * `DesktopApiError` carrying the stable code.
 */
export async function request<R extends JsonObject = JsonObject>(
  method: MethodName,
  payload?: JsonObject,
): Promise<R> {
  const requestId = nextRequestId();
  pendingRequests.set(requestId, { method, startedAt: Date.now() });
  try {
    const result = await invoke<unknown>('desktop_request', {
      method,
      payload: payload ?? {},
    });
    // Rust answers with the response payload object (Map<String, Value>).
    return (result ?? {}) as R;
  } catch (raw) {
    throw new DesktopApiError(toStructuredError(raw), requestId);
  } finally {
    pendingRequests.delete(requestId);
  }
}

// ---------------------------------------------------------------------------
// Shell lifecycle commands
// ---------------------------------------------------------------------------

export async function getStatus(): Promise<ProviderStatus> {
  return invoke<ProviderStatus>('desktop_status');
}

export async function startEngine(): Promise<ProviderStatus> {
  try {
    return await invoke<ProviderStatus>('desktop_start');
  } catch (raw) {
    throw new DesktopApiError(toStructuredError(raw));
  }
}

export async function shutdownEngine(reason?: string): Promise<ProviderStatus> {
  try {
    return await invoke<ProviderStatus>('desktop_shutdown', { reason });
  } catch (raw) {
    throw new DesktopApiError(toStructuredError(raw));
  }
}

export async function restartEngine(reason?: string): Promise<ProviderStatus> {
  try {
    return await invoke<ProviderStatus>('desktop_restart', { reason });
  } catch (raw) {
    throw new DesktopApiError(toStructuredError(raw));
  }
}

export async function getEventState(): Promise<EventState> {
  return invoke<EventState>('desktop_event_state');
}

export async function getPaths(): Promise<DesktopPaths> {
  try {
    return await invoke<DesktopPaths>('desktop_paths');
  } catch (raw) {
    throw new DesktopApiError(toStructuredError(raw));
  }
}

export async function validateProjectDir(path: string): Promise<ProjectDirReport> {
  try {
    return await invoke<ProjectDirReport>('desktop_validate_project_dir', { path });
  } catch (raw) {
    throw new DesktopApiError(toStructuredError(raw));
  }
}

// ---------------------------------------------------------------------------
// Common typed protocol methods (thin; every one awaits one response)
// ---------------------------------------------------------------------------

export function enginePing(): Promise<JsonObject> {
  return request('engine.ping');
}

export function projectOpen(path: string): Promise<JsonObject> {
  return request('project.open', { path });
}

export function projectCreate(path: string, name?: string): Promise<JsonObject> {
  return request('project.create', name === undefined ? { path } : { path, name });
}

export function projectClose(force?: boolean): Promise<JsonObject> {
  return force === undefined ? request('project.close') : request('project.close', { force });
}

export function projectSnapshot(): Promise<JsonObject> {
  return request('project.snapshot');
}

export function projectResume(checkpointId?: string): Promise<JsonObject> {
  return checkpointId === undefined
    ? request('project.resume')
    : request('project.resume', { checkpoint_id: checkpointId });
}
export function projectReopen(direction?: string): Promise<JsonObject> {
  return direction === undefined || direction.trim() === ''
    ? request('project.reopen')
    : request('project.reopen', { direction: direction.trim() });
}


/** Replay result payload: `{replayed, last_sequence, advise?}` (Go adapter). */
export interface ReplayResult {
  replayed?: number;
  last_sequence?: number;
  advise?: string;
  [key: string]: unknown;
}

export function projectReplayEvents(afterSequence: number, limit?: number): Promise<ReplayResult> {
  const payload: JsonObject =
    limit === undefined ? { after_sequence: afterSequence } : { after_sequence: afterSequence, limit };
  return request<JsonObject & ReplayResult>('project.replay_events', payload).then((r) => r as ReplayResult);
}

export function usageSnapshot(): Promise<JsonObject> {
  return request('usage.snapshot');
}

// ---------------------------------------------------------------------------
// Run controls (task 5). Thin wrappers; semantics live engine-side:
// - run.start accepts {goal} and returns an ACCEPTANCE response — progress
//   and the terminal outcome arrive asynchronously as run.* events.
// - run.pause and run.abort both pause the engine (the daemon maps both to
//   Host.Abort; pause is the gentler label).
// - run.retry / run.continue both resume from persisted state (Host.Resume).
// - run.advance_one_chapter is the explicit one-chapter authorization.
// ---------------------------------------------------------------------------

/** run.start result (acceptance): `{accepted, run_id?, via?}` (Go adapter). */
export interface RunAcceptance {
  accepted?: boolean;
  run_id?: string;
  via?: string;
  [key: string]: unknown;
}

export function runStart(goal?: string): Promise<JsonObject> {
  return goal === undefined || goal.trim() === ''
    ? request('run.start')
    : request('run.start', { goal });
}

export function runContinue(instruction?: string): Promise<JsonObject> {
  return instruction === undefined || instruction.trim() === ''
    ? request('run.continue')
    : request('run.continue', { instruction: instruction.trim() });
}

export function runSteer(instruction: string, context?: string): Promise<JsonObject> {
  return context === undefined
    ? request('run.steer', { instruction })
    : request('run.steer', { instruction, context });
}

export function runPause(): Promise<JsonObject> {
  return request('run.pause');
}

export function runAbort(reason?: string): Promise<JsonObject> {
  return reason === undefined ? request('run.abort') : request('run.abort', { reason });
}

export function runRetry(): Promise<JsonObject> {
  return request('run.retry');
}

export function runAdvanceOneChapter(): Promise<JsonObject> {
  return request('run.advance_one_chapter');
}

/** Engine advance modes: `auto` runs freely; `review`/`manual` gate chapters. */
export type AdvanceMode = 'auto' | 'review';

export function runSetAdvanceMode(mode: AdvanceMode): Promise<JsonObject> {
  return request('run.set_advance_mode', { mode });
}

// ---------------------------------------------------------------------------
// Chapter content, revisions, and export (task 6). Field names are the Go
// adapter's (internal/entry/desktop/project.go):
// - chapter.list → {chapters:[{chapter,words,status,version?,origin?,title?}],
//   completed, total, in_progress, pending_rewrites}
// - chapter.read {chapter} → {chapter, content, words, version?, origin?,
//   source?} (version = accept-record revision; base for optimistic locking)
// - chapter.save {chapter, content, base_version?} → conflict when base_version
//   ≠ the record's current revision: operation_failed with
//   details:{conflict:true, current_version}; success → {chapter, version,
//   saved} and a chapter.updated event
// - chapter.revisions.check {chapter?} → {chapters:[changed], count}
// - chapter.revisions.sync {chapter?} → acceptance {accepted, changed}; the
//   outcome arrives as events (chapter.updated {status:"synced"} per applied
//   chapter + notification.info; failure → engine.error)
// - chapter.export {chapters?, format, output_path} → synchronous local IO;
//   {path, chapters, bytes, skipped}; format txt/epub (txt default)
// ---------------------------------------------------------------------------

/** One chapter row from chapter.list (open payload; all fields optional). */
export interface ChapterListItem {
  chapter?: number;
  title?: string;
  words?: number;
  version?: number;
  origin?: string;
  status?: string;
  [key: string]: unknown;
}

export interface ChapterListResult {
  chapters?: ChapterListItem[];
  completed?: number;
  total?: number;
  in_progress?: number;
  pending_rewrites?: number;
  [key: string]: unknown;
}

export function chapterList(): Promise<ChapterListResult> {
  return request<JsonObject & ChapterListResult>('chapter.list').then((r) => r as ChapterListResult);
}

export interface ChapterReadResult {
  chapter?: number;
  content?: string;
  words?: number;
  version?: number;
  origin?: string;
  /** "record" when the daemon fell back to the accepted record content. */
  source?: string;
  [key: string]: unknown;
}

export function chapterRead(chapter: number): Promise<ChapterReadResult> {
  return request<JsonObject & ChapterReadResult>('chapter.read', { chapter }).then(
    (r) => r as ChapterReadResult,
  );
}

export interface ChapterSaveResult {
  chapter?: number;
  version?: number;
  saved?: boolean;
  [key: string]: unknown;
}

export function chapterSave(
  chapter: number,
  content: string,
  baseVersion?: number,
): Promise<ChapterSaveResult> {
  const payload: JsonObject =
    baseVersion === undefined ? { chapter, content } : { chapter, content, base_version: baseVersion };
  return request<JsonObject & ChapterSaveResult>('chapter.save', payload).then(
    (r) => r as ChapterSaveResult,
  );
}

export interface RevisionsCheckResult {
  chapters?: number[];
  count?: number;
  [key: string]: unknown;
}

export function chapterRevisionsCheck(chapter?: number): Promise<RevisionsCheckResult> {
  return chapter === undefined
    ? request<JsonObject & RevisionsCheckResult>('chapter.revisions.check').then(
        (r) => r as RevisionsCheckResult,
      )
    : request<JsonObject & RevisionsCheckResult>('chapter.revisions.check', { chapter }).then(
        (r) => r as RevisionsCheckResult,
      );
}

/** Acceptance payload; the applied chapters arrive as chapter.updated events. */
export interface RevisionsSyncAcceptance {
  accepted?: boolean;
  changed?: number[];
  /** Only present when a chapter filter found nothing to do (no-op path). */
  applied?: number[];
  [key: string]: unknown;
}

export function chapterRevisionsSync(chapter?: number): Promise<RevisionsSyncAcceptance> {
  return chapter === undefined
    ? request<JsonObject & RevisionsSyncAcceptance>('chapter.revisions.sync').then(
        (r) => r as RevisionsSyncAcceptance,
      )
    : request<JsonObject & RevisionsSyncAcceptance>('chapter.revisions.sync', { chapter }).then(
        (r) => r as RevisionsSyncAcceptance,
      );
}

export type ExportFormat = 'txt' | 'epub';

/** Synchronous export result (Host.Export over local IO). */
export interface ChapterExportResult {
  path?: string;
  chapters?: number;
  bytes?: number;
  skipped?: number[];
  [key: string]: unknown;
}

export function chapterExport(
  outputPath: string,
  format: ExportFormat,
  chapters?: number[],
): Promise<ChapterExportResult> {
  const payload: JsonObject =
    chapters === undefined || chapters.length === 0
      ? { format, output_path: outputPath }
      : { chapters, format, output_path: outputPath };
  return request<JsonObject & ChapterExportResult>('chapter.export', payload).then(
    (r) => r as ChapterExportResult,
  );
}

/**
 * True when a chapter.save rejection is a base_version conflict (the engine
 * reports details:{conflict:true, current_version}). Detected structurally —
 * never by message text.
 */
export function isChapterConflictError(raw: unknown): boolean {
  if (!(raw instanceof DesktopApiError)) return false;
  if (raw.code !== 'operation_failed') return false;
  const details = raw.details as Record<string, unknown> | undefined;
  return typeof details === 'object' && details !== null && details.conflict === true;
}

/** Engine's current revision from a conflict rejection's details, if present. */
export function conflictCurrentVersion(raw: unknown): number | undefined {
  if (!(raw instanceof DesktopApiError)) return undefined;
  const details = raw.details as Record<string, unknown> | undefined;
  const version = typeof details === 'object' && details !== null ? details.current_version : undefined;
  return typeof version === 'number' && Number.isFinite(version) ? version : undefined;
}

// ---------------------------------------------------------------------------
// Artifacts (task 6 fix: read-only facts / world / summaries projections).
// Field names are the Go adapter's (internal/entry/desktop/project.go,
// response shapes in protocols/desktop-v1/README.md §12):
// - artifacts.read {kind:"facts"} → {facts:[{chapter, version, origin,
//   facts:{title, summary, characters[], key_events[], ...}}], count}
// - artifacts.read {kind:"world"} → {rules:[{category, rule, boundary?}], count}
// - artifacts.read {kind:"summary"} → {summaries:[{chapter, title, summary,
//   characters[], key_events[]}], count}
// The protocol also accepts a chapter scoping for facts/summary; the UI lists
// all chapters, so only the list reads are wrapped.
// ---------------------------------------------------------------------------

/** One accepted chapter-facts record (open payload; fields optional). */
export interface ChapterFactsEntry {
  chapter?: number;
  version?: number;
  origin?: string;
  facts?: JsonObject;
  [key: string]: unknown;
}

export interface FactsReadResult {
  facts?: ChapterFactsEntry[];
  count?: number;
  [key: string]: unknown;
}

/** One world-rules ledger entry. */
export interface WorldRule {
  category?: string;
  rule?: string;
  boundary?: string;
  [key: string]: unknown;
}

export interface WorldReadResult {
  rules?: WorldRule[];
  count?: number;
  [key: string]: unknown;
}

/** One per-chapter summary record. */
export interface ChapterSummaryEntry {
  chapter?: number;
  title?: string;
  summary?: string;
  characters?: string[];
  key_events?: string[];
  [key: string]: unknown;
}

export interface SummaryReadResult {
  summaries?: ChapterSummaryEntry[];
  count?: number;
  [key: string]: unknown;
}

export function readFacts(): Promise<FactsReadResult> {
  return request<JsonObject & FactsReadResult>('artifacts.read', { kind: 'facts' }).then(
    (r) => r as FactsReadResult,
  );
}

export function readWorld(): Promise<WorldReadResult> {
  return request<JsonObject & WorldReadResult>('artifacts.read', { kind: 'world' }).then(
    (r) => r as WorldReadResult,
  );
}

export function readSummaries(): Promise<SummaryReadResult> {
  return request<JsonObject & SummaryReadResult>('artifacts.read', { kind: 'summary' }).then(
    (r) => r as SummaryReadResult,
  );
}

// ---------------------------------------------------------------------------
// Co-create / import / simulation (task 7). Field names are the Go adapter's
// (internal/entry/desktop/dispatch.go):
// - cocreate.start {message, mode?} → ACCEPTANCE {accepted, mode:"cold"|"stage"};
//   the round streams cocreate.progress (thinking/reply previews, replace
//   semantics) and ends with ONE terminal event stage:"assistant" carrying
//   {message, ready, draft, suggestions}; round failure arrives as engine.error.
// - cocreate.stage {message} → acceptance for the next round of the EXISTING
//   session (operation_failed when none).
// - cocreate.resume → stage mode: {resumed:true, mode:"stage"} (engine emits
//   run.started); cold mode: {accepted:true, mode:"cold", run_id} then the
//   async start emits run.started / run.failed.
// - cocreate.cancel {reason?} → {cancelled:true, stage} or
//   {cancelled:false, reason:"no co-create session"}.
// - import.start {source_path, options?} → acceptance {accepted, source_path};
//   progress via import.progress events; terminal stage:"done" (payload
//   continued) or payload.error (+ engine.error).
// - import.resume (no payload; continues the active workspace) / import.cancel
//   → {cancelled} (reason when nothing was running).
// - simulation.start {source_path} stages the source into <project>/simulate
//   (README §12) → acceptance {accepted, source_path, engine_source_dir};
//   simulation.resume re-runs the staged corpus (operation_failed when none);
//   simulation.profile_import {profile_path} → acceptance; both drain through
//   simulation.progress events with the same done/error terminal shape.
// ---------------------------------------------------------------------------

export type CocreateMode = 'cold' | 'stage';

/** cocreate.start / cocreate.stage acceptance: `{accepted, mode}`. */
export interface CocreateAcceptance {
  accepted?: boolean;
  mode?: string;
  [key: string]: unknown;
}

/** cocreate.resume result: stage mode resolves synchronously, cold accepts. */
export interface CocreateResumeResult {
  resumed?: boolean;
  accepted?: boolean;
  mode?: string;
  run_id?: string;
  [key: string]: unknown;
}

/** cocreate.cancel result: `cancelled:false` carries the reason string. */
export interface CocreateCancelResult {
  cancelled?: boolean;
  stage?: string;
  reason?: string;
  [key: string]: unknown;
}

export function cocreateStart(message: string, mode?: CocreateMode): Promise<CocreateAcceptance> {
  const payload: JsonObject =
    mode === 'stage' ? { message, mode: 'stage' } : { message };
  return request<JsonObject & CocreateAcceptance>('cocreate.start', payload).then(
    (r) => r as CocreateAcceptance,
  );
}

export function cocreateStage(message: string): Promise<CocreateAcceptance> {
  return request<JsonObject & CocreateAcceptance>('cocreate.stage', { message }).then(
    (r) => r as CocreateAcceptance,
  );
}

export function cocreateResume(): Promise<CocreateResumeResult> {
  return request<JsonObject & CocreateResumeResult>('cocreate.resume').then(
    (r) => r as CocreateResumeResult,
  );
}

export function cocreateCancel(reason?: string): Promise<CocreateCancelResult> {
  return reason === undefined
    ? request<JsonObject & CocreateCancelResult>('cocreate.cancel').then((r) => r as CocreateCancelResult)
    : request<JsonObject & CocreateCancelResult>('cocreate.cancel', { reason }).then(
        (r) => r as CocreateCancelResult,
      );
}

/** Engine-documented import options (desktop has no interactive confirm
 * channel, so auto_confirm is the meaningful path for this UI). */
export interface ImportOptions {
  auto_confirm?: boolean;
  continue_after?: boolean;
  story_resolution?: 'open' | 'closed';
  guidance?: string;
}

/** import.start / import.resume acceptance: `{accepted, source_path}`. */
export interface ImportAcceptance {
  accepted?: boolean;
  source_path?: string;
  [key: string]: unknown;
}

/** import.cancel / simulation.cancel result. */
export interface CancelResult {
  cancelled?: boolean;
  reason?: string;
  [key: string]: unknown;
}

export function importStart(sourcePath: string, options?: ImportOptions): Promise<ImportAcceptance> {
  // The adapter reads a nested `options` object (dispatch.go impOptionsFromPayload).
  const payload: JsonObject =
    options === undefined ? { source_path: sourcePath } : { source_path: sourcePath, options: options as JsonObject };
  return request<JsonObject & ImportAcceptance>('import.start', payload).then(
    (r) => r as ImportAcceptance,
  );
}

export function importResume(): Promise<ImportAcceptance> {
  return request<JsonObject & ImportAcceptance>('import.resume').then((r) => r as ImportAcceptance);
}

export function importCancel(): Promise<CancelResult> {
  return request<JsonObject & CancelResult>('import.cancel').then((r) => r as CancelResult);
}

/** simulation.start / simulation.resume acceptance (README §12 staging). */
export interface SimulationAcceptance {
  accepted?: boolean;
  source_path?: string;
  engine_source_dir?: string;
  [key: string]: unknown;
}

export function simulationStart(sourcePath: string): Promise<SimulationAcceptance> {
  return request<JsonObject & SimulationAcceptance>('simulation.start', { source_path: sourcePath }).then(
    (r) => r as SimulationAcceptance,
  );
}

export function simulationResume(): Promise<SimulationAcceptance> {
  return request<JsonObject & SimulationAcceptance>('simulation.resume').then(
    (r) => r as SimulationAcceptance,
  );
}

export function simulationCancel(): Promise<CancelResult> {
  return request<JsonObject & CancelResult>('simulation.cancel').then((r) => r as CancelResult);
}

/** simulation.profile_import acceptance: `{accepted, profile_path}`. */
export interface ProfileImportAcceptance {
  accepted?: boolean;
  profile_path?: string;
  [key: string]: unknown;
}

export function simulationProfileImport(profilePath: string): Promise<ProfileImportAcceptance> {
  return request<JsonObject & ProfileImportAcceptance>('simulation.profile_import', {
    profile_path: profilePath,
  }).then((r) => r as ProfileImportAcceptance);
}

// ---------------------------------------------------------------------------
// Diagnostics / usage / logs / runtime queue (task 8). Field names are the Go
// adapter's (internal/entry/desktop/project.go); response shapes verified
// against the adapter, not assumed:
// - diagnostics.snapshot → {stats:{...}, findings:[{rule, category, severity,
//   confidence, title, evidence, suggestion}], runtime:{current_step,
//   stuck_step, stuck_count, log_errors, log_warns, stop_guard, models:[...],
//   load_errors}, planned_actions}
// - diagnostics.export {output_path?} → {output_path, sanitized:true,
//   findings}; the bundle is sanitized engine-side (README §8); emits
//   diagnostics.completed. The `include` filter has no engine support, so the
//   UI never sends it (default = every sanitized section).
// - config.get {keys?} → redacted view {provider, model, reasoning_effort,
//   language, story_language, style, budget_usd, config_path,
//   providers:[{name, type, api, base_url, models, has_api_key,
//   api_key_hint, requires_api_key}]} — NO plaintext secrets ever leave the
//   daemon; the UI renders only what arrives.
// - config.update {values} → {updated:[], unsupported:[]}; the engine applies
//   only language / story_language / reasoning_effort and never fakes success.
// - config.providers → {providers, default_provider, default_model}
// - config.models {provider?} → {provider, models:[{name, context_window,
//   context_source}]} or {providers:{name:[models]}} without a filter.
// - config.switch_model {provider, model} → {provider, model}
// - config.thinking_levels {provider?, model?} → {levels, provider, model}
//   (engine exposes levels for the ACTIVE model; requested pair echoed back)
// - config.set_thinking {level} → {level} (invalid levels → invalid_payload)
// - config.set_language / set_story_language {language} → the NORMALIZED code
//   echoed back ({language} / {story_language})
// - logs.replay {after_sequence?, limit?, level?} → {records:[{sequence,
//   time, level, module, message, attrs?}], count, last_sequence}; level is a
//   MINIMUM severity filter; records are already redacted engine-side.
// - runtime.queue → {items:[{seq, time, priority, summary, agent?, category?}],
//   count}
// ---------------------------------------------------------------------------

/** One diagnostics finding (open payload; fields optional). */
export interface DiagnosticsFinding {
  rule?: string;
  category?: string;
  severity?: string;
  confidence?: string;
  title?: string;
  evidence?: string;
  suggestion?: string;
  [key: string]: unknown;
}

/** Per-agent model row from the diagnostics runtime view. */
export interface DiagnosticsModelRow {
  agent?: string;
  provider?: string;
  model?: string;
  [key: string]: unknown;
}

export interface DiagnosticsSnapshotResult {
  stats?: JsonObject;
  findings?: DiagnosticsFinding[];
  runtime?: JsonObject & { models?: DiagnosticsModelRow[] };
  planned_actions?: number;
  [key: string]: unknown;
}

export function diagnosticsSnapshot(): Promise<DiagnosticsSnapshotResult> {
  return request<JsonObject & DiagnosticsSnapshotResult>('diagnostics.snapshot').then(
    (r) => r as DiagnosticsSnapshotResult,
  );
}

/** diagnostics.export result: `{output_path, sanitized, findings}`. */
export interface DiagnosticsExportResult {
  output_path?: string;
  sanitized?: boolean;
  findings?: number;
  [key: string]: unknown;
}

export function diagnosticsExport(outputPath?: string): Promise<DiagnosticsExportResult> {
  const payload: JsonObject =
    outputPath === undefined ? {} : { output_path: outputPath };
  return request<JsonObject & DiagnosticsExportResult>('diagnostics.export', payload).then(
    (r) => r as DiagnosticsExportResult,
  );
}

/** One redacted provider summary from config.get / config.providers. */
export interface ProviderSummary {
  name?: string;
  type?: string;
  api?: string;
  base_url?: string;
  models?: string[];
  has_api_key?: boolean;
  /** Masked hint only (e.g. last characters); never the key itself. */
  api_key_hint?: string;
  requires_api_key?: boolean;
  [key: string]: unknown;
}

/** config.get result (always redacted server-side; open payload). */
export interface ConfigGetResult {
  provider?: string;
  model?: string;
  reasoning_effort?: string;
  language?: string;
  story_language?: string;
  style?: string;
  budget_usd?: number;
  config_path?: string;
  providers?: ProviderSummary[];
  [key: string]: unknown;
}

export function configGet(keys?: string[]): Promise<ConfigGetResult> {
  const payload: JsonObject =
    keys === undefined || keys.length === 0 ? {} : { keys: [...keys] };
  return request<JsonObject & ConfigGetResult>('config.get', payload).then(
    (r) => r as ConfigGetResult,
  );
}

// NOTE on the two catalog methods not wrapped here: `config.update` (loose
// key/value update) and `config.providers` (standalone provider list) are
// redundant for this UI — the dedicated setters below give one explicit
// request per change, and `config.get` already embeds the provider
// summaries. Following this module's convention of wrapping only the
// surface the UI consumes (cf. engine.shutdown), they are omitted.

/** One model row from config.models. */
export interface ModelOption {
  name?: string;
  context_window?: number;
  context_source?: string;
  [key: string]: unknown;
}

export interface ConfigModelsResult {
  provider?: string;
  models?: ModelOption[];
  /** Present when no provider filter was sent: {providerName: ModelOption[]}. */
  providers?: Record<string, ModelOption[]>;
  [key: string]: unknown;
}

export function configModels(provider?: string): Promise<ConfigModelsResult> {
  const payload: JsonObject = provider === undefined || provider === '' ? {} : { provider };
  return request<JsonObject & ConfigModelsResult>('config.models', payload).then(
    (r) => r as ConfigModelsResult,
  );
}

/** config.switch_model result: the accepted pair echoed back. */
export interface ConfigSwitchModelResult {
  provider?: string;
  model?: string;
  [key: string]: unknown;
}

export function configSwitchModel(provider: string, model: string): Promise<ConfigSwitchModelResult> {
  return request<JsonObject & ConfigSwitchModelResult>('config.switch_model', {
    provider,
    model,
  }).then((r) => r as ConfigSwitchModelResult);
}

/** config.thinking_levels result: levels for the ACTIVE model. */
export interface ThinkingLevelsResult {
  levels?: string[];
  provider?: string;
  model?: string;
  requested_provider?: string;
  requested_model?: string;
  [key: string]: unknown;
}

export function configThinkingLevels(provider?: string, model?: string): Promise<ThinkingLevelsResult> {
  const payload: JsonObject = {};
  if (provider !== undefined && provider !== '') payload.provider = provider;
  if (model !== undefined && model !== '') payload.model = model;
  return request<JsonObject & ThinkingLevelsResult>('config.thinking_levels', payload).then(
    (r) => r as ThinkingLevelsResult,
  );
}

/** config.set_thinking result: `{level}` (the applied level). */
export interface AppliedLevelResult {
  level?: string;
  [key: string]: unknown;
}

export function configSetThinking(level: string): Promise<AppliedLevelResult> {
  return request<JsonObject & AppliedLevelResult>('config.set_thinking', { level }).then(
    (r) => r as AppliedLevelResult,
  );
}

/** config.set_language result: `{language}` (normalized engine-side). */
export interface AppliedLanguageResult {
  language?: string;
  story_language?: string;
  [key: string]: unknown;
}

export function configSetLanguage(language: string): Promise<AppliedLanguageResult> {
  return request<JsonObject & AppliedLanguageResult>('config.set_language', { language }).then(
    (r) => r as AppliedLanguageResult,
  );
}

export function configSetStoryLanguage(language: string): Promise<AppliedLanguageResult> {
  return request<JsonObject & AppliedLanguageResult>('config.set_story_language', { language }).then(
    (r) => r as AppliedLanguageResult,
  );
}

export interface ProviderModelDraft {
  name: string;
  context_window?: number;
  [key: string]: unknown;
}

export interface SaveProviderPayload {
  provider: string;
  type: string;
  api?: string;
  base_url?: string;
  api_key_action?: 'keep' | 'replace' | 'clear';
  api_key?: string;
  models: ProviderModelDraft[];
  renames?: Array<{ from: string; to: string }>;
  [key: string]: unknown;
}

export interface SaveProviderResult {
  saved: boolean;
  provider: ProviderSummary;
  [key: string]: unknown;
}

export interface TestProviderPayload extends SaveProviderPayload {
  test_model: string;
}

export interface TestProviderResult {
  success: boolean;
  latency_ms?: number;
  [key: string]: unknown;
}

export interface DeleteProviderPayload {
  provider: string;
  [key: string]: unknown;
}

export interface DeleteProviderResult {
  deleted: boolean;
  provider: string;
  [key: string]: unknown;
}

export function configSaveProvider(payload: SaveProviderPayload): Promise<SaveProviderResult> {
  return request<JsonObject & SaveProviderResult>('config.save_provider', payload as unknown as JsonObject).then(
    (r) => r as SaveProviderResult,
  );
}

export function configTestProvider(payload: TestProviderPayload): Promise<TestProviderResult> {
  return request<JsonObject & TestProviderResult>('config.test_provider', payload as unknown as JsonObject).then(
    (r) => r as TestProviderResult,
  );
}

export function configDeleteProvider(payload: DeleteProviderPayload): Promise<DeleteProviderResult> {
  return request<JsonObject & DeleteProviderResult>('config.delete_provider', payload as unknown as JsonObject).then(
    (r) => r as DeleteProviderResult,
  );
}

export interface FetchProviderModelsPayload {
  provider?: string;
  type: string;
  api?: string;
  base_url: string;
  api_key_action?: 'keep' | 'replace' | 'clear';
  api_key?: string;
  [key: string]: unknown;
}

export interface FetchProviderModelsResult {
  models: string[];
  [key: string]: unknown;
}

export function configFetchProviderModels(payload: FetchProviderModelsPayload): Promise<FetchProviderModelsResult> {
  return request<JsonObject & FetchProviderModelsResult>('config.fetch_provider_models', payload as unknown as JsonObject).then(
    (r) => r as FetchProviderModelsResult,
  );
}

/** One buffered structured log record (already redacted engine-side). */
export interface LogRecord {
  sequence?: number;
  time?: string;
  level?: string;
  module?: string;
  message?: string;
  attrs?: Record<string, string>;
  [key: string]: unknown;
}

export interface LogsReplayResult {
  records?: LogRecord[];
  count?: number;
  last_sequence?: number;
  [key: string]: unknown;
}

/**
 * Replay the daemon's buffered structured logs. `level` is a MINIMUM severity
 * filter (the engine also returns more severe records). Server-side redaction
 * is authoritative; the UI renders records verbatim.
 */
export function logsReplay(
  afterSequence?: number,
  limit?: number,
  level?: string,
): Promise<LogsReplayResult> {
  const payload: JsonObject = {};
  if (afterSequence !== undefined && Number.isFinite(afterSequence)) {
    payload.after_sequence = afterSequence;
  }
  if (limit !== undefined && Number.isFinite(limit)) payload.limit = limit;
  if (level !== undefined && level !== '') payload.level = level;
  return request<JsonObject & LogsReplayResult>('logs.replay', payload).then(
    (r) => r as LogsReplayResult,
  );
}

/** One persisted runtime-queue item. */
export interface RuntimeQueueItem {
  seq?: number;
  time?: string;
  priority?: string;
  summary?: string;
  agent?: string;
  category?: string;
  [key: string]: unknown;
}

export interface RuntimeQueueResult {
  items?: RuntimeQueueItem[];
  count?: number;
  [key: string]: unknown;
}

export function runtimeQueue(): Promise<RuntimeQueueResult> {
  return request<JsonObject & RuntimeQueueResult>('runtime.queue').then(
    (r) => r as RuntimeQueueResult,
  );
}

// ---------------------------------------------------------------------------
// Event dedupe (README §4: at-least-once delivery, (session, sequence) key)
// ---------------------------------------------------------------------------

export type DedupeVerdict =
  | { kind: 'apply' }
  | { kind: 'duplicate' }
  | { kind: 'session-change'; previous: string | null; current: string | null };

export interface DedupeState {
  lastSession: string | null;
  lastSequence: number;
  duplicatesDropped: number;
}

/**
 * Tracks the (session, sequence) delivery window. Rules:
 * - A new session id resets the sequence window (sidecar restart).
 * - Within a session, sequence <= lastSequence is an exact re-delivery
 *   (duplicate) and is dropped; anything greater is applied.
 * - Events without a session string share one anonymous window.
 */
export class EventDeduper {
  private state: DedupeState = { lastSession: null, lastSequence: -1, duplicatesDropped: 0 };

  accept(envelope: { session?: string | null; sequence: number }): DedupeVerdict {
    const session = envelope.session ?? null;
    const previous = this.state.lastSession;
    if (session !== null && previous !== null && session !== previous) {
      this.state = { lastSession: session, lastSequence: envelope.sequence, duplicatesDropped: 0 };
      return { kind: 'session-change', previous, current: session };
    }
    if (session !== null) {
      this.state.lastSession = session;
    }
    if (envelope.sequence <= this.state.lastSequence) {
      this.state.duplicatesDropped += 1;
      return { kind: 'duplicate' };
    }
    this.state.lastSequence = envelope.sequence;
    return { kind: 'apply' };
  }

  /** Force a window reset (used on desktop://session). */
  reset(session: string | null): void {
    this.state = { lastSession: session, lastSequence: -1, duplicatesDropped: 0 };
  }

  snapshot(): DedupeState {
    return { ...this.state };
  }
}

/** Normalize a forwarded `desktop://event` payload into a UI envelope. */
export function normalizeForwardedEvent(raw: ForwardedEvent): EventEnvelope | null {
  if (typeof raw?.event !== 'string' || typeof raw?.sequence !== 'number') {
    return null;
  }
  if (!isKnownEventName(raw.event)) {
    return null; // Unknown event names are ignored (README §9).
  }
  return {
    event: raw.event as EventName,
    session: raw.session ?? undefined,
    sequence: raw.sequence,
    projectId: raw.projectId ?? undefined,
    payload: (raw.payload ?? {}) as JsonObject,
  };
}

// ---------------------------------------------------------------------------
// Event subscriptions
// ---------------------------------------------------------------------------

export type EngineEventDelivery =
  | { kind: 'event'; envelope: EventEnvelope }
  | { kind: 'duplicate'; envelope: EventEnvelope; duplicatesDropped: number }
  | {
      kind: 'session-change';
      previous: string | null;
      current: string | null;
      envelope: EventEnvelope;
    };

/**
 * Options for the event/session subscriptions. Pass the SAME `EventDeduper`
 * to both: the `desktop://session` notice then resets the window the engine
 * events are deduped against, so one sidecar restart yields exactly one
 * session-change handling instead of the notice AND the deduper's own
 * session-change verdict both firing for the same transition.
 */
export interface EventSubscriptionOptions {
  deduper?: EventDeduper;
}

/**
 * Subscribe to deduped engine events. The Rust shell already drops exact
 * re-deliveries; this second layer guards the frontend against replays and
 * multi-subscriber races, and detects session changes carried by envelopes
 * even if the `desktop://session` notice raced ahead. Dedupes against its
 * own window unless a shared one is provided via `options.deduper`.
 */
export async function subscribeEngineEvents(
  onDelivery: (delivery: EngineEventDelivery) => void,
  options: EventSubscriptionOptions = {},
): Promise<UnlistenFn> {
  const deduper = options.deduper ?? new EventDeduper();
  return listen<ForwardedEvent>('desktop://event', (tauriEvent) => {
    const envelope = normalizeForwardedEvent(tauriEvent.payload);
    if (!envelope) return; // Unknown names / malformed shapes: ignore.
    const verdict = deduper.accept(envelope);
    if (verdict.kind === 'apply') {
      onDelivery({ kind: 'event', envelope });
    } else if (verdict.kind === 'duplicate') {
      onDelivery({ kind: 'duplicate', envelope, duplicatesDropped: deduper.snapshot().duplicatesDropped });
    } else {
      onDelivery({ kind: 'session-change', previous: verdict.previous, current: verdict.current, envelope });
    }
  });
}

export async function subscribeSessionChanges(
  onChange: (change: SessionChangePayload) => void,
  options: EventSubscriptionOptions = {},
): Promise<UnlistenFn> {
  return listen<SessionChangePayload>('desktop://session', (tauriEvent) => {
    const payload = tauriEvent.payload ?? {};
    if (options.deduper) {
      // The shell's authoritative notice opens the new session: reset the
      // shared dedupe window so the first forwarded event of that session
      // applies normally instead of re-firing a session-change verdict for
      // the same transition.
      options.deduper.reset(typeof payload.current === 'string' ? payload.current : null);
    }
    onChange(payload);
  });
}

export async function subscribeStatus(
  onStatus: (status: StatusEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<StatusEventPayload>('desktop://status', (tauriEvent) => {
    onStatus(tauriEvent.payload ?? ({} as StatusEventPayload));
  });
}
