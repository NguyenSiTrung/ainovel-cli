# desktop-v1 Protocol

The versioned IPC contract between the Tauri desktop shell (Rust) and the Go
novel-engine sidecar, consumed by the Svelte frontend. This directory is the
source of truth for envelope shapes, method names, event names, error codes,
sequencing rules, and fixtures. The Go daemon (task 2), the Rust/Tauri shell
(task 3), and the Svelte frontend (task 4) implement these names and fields
verbatim. The protocol never depends on private Go package names.

Files:

```text
protocols/desktop-v1/
  commands.schema.json    Request envelope + per-method payload schemas (JSON Schema draft 2020-12)
  events.schema.json      Response/event envelopes + per-event payload schemas (JSON Schema draft 2020-12)
  fixtures/               NDJSON fixtures shared by Go, Rust, and frontend protocol tests
  README.md               This contract document
  validate.mjs            Deterministic fixture/schema validation
  package.json            Pinned tooling (ajv)
```

## 1. Wire rules

- Transport is newline-delimited JSON (NDJSON): exactly one JSON object per
  line, UTF-8, LF line endings.
- The engine's **stdout carries protocol messages only** — responses and
  events. **All logs go to stderr** and the existing file logger. A protocol
  message is never written to stderr; a log line is never written to stdout.
- The engine's **stdin receives requests** in the same NDJSON framing.
- Blank lines are not protocol messages. Emitters do not produce them;
  readers skip them.
- Nothing else is ever written to the protocol streams: no banners, no
  progress bars, no ANSI escapes.

## 2. Envelopes

### Request (client to engine, stdin)

```json
{"protocol":"desktop-v1","kind":"request","id":"req-8f3a","method":"project.open","payload":{"path":"/Users/demo/Novels/First-Novel"}}
```

Required: `protocol`, `kind`, `id`, `method`. Optional: `payload` (object,
defaults to `{}`).

### Response (engine to client, stdout) — success

```json
{"protocol":"desktop-v1","kind":"response","id":"req-8f3a","ok":true,"session":"sess-7f2c","payload":{}}
```

Required: `protocol`, `kind`, `id`, `ok`. Optional: `session`, `payload`.
`payload` appears on success responses only (it may be omitted or `{}`).

### Response — failure

```json
{"protocol":"desktop-v1","kind":"response","id":"req-bad-1","ok":false,"error":{"code":"host_busy","message":"a generation run is already active","details":{"active_request":"run.start"}}}
```

Failure responses are still `kind:"response"` envelopes. When `ok` is `false`,
`error` is required and `payload` is absent. `error.code` is one of the stable
codes in section 5; `error.message` is human-readable; `error.details` is an
optional structured value. All are redacted of secrets.

### Event (engine to client, stdout)

```json
{"protocol":"desktop-v1","kind":"event","event":"run.progress","project_id":"project-123","session":"sess-7f2c","sequence":481,"payload":{"completed":12,"total":24}}
```

Required: `protocol`, `kind`, `event`, `sequence`. Optional: `project_id`,
`session`, `payload`.

### Field rules (enforced by the schemas)

| Field | Request | Response | Event | Rule |
|---|---|---|---|---|
| `protocol` | required | required | required | const `"desktop-v1"` |
| `kind` | required | required | required | `"request"` / `"response"` / `"event"` |
| `id` | required | required | — | non-empty string; response echoes its request |
| `method` | required | — | — | one of the 49 method names (section 6) |
| `ok` | — | required | — | boolean |
| `error` | — | required iff `ok:false` | — | `{code, message, details?}` |
| `payload` | optional | success only | optional | object; open (unknown fields allowed) |
| `event` | — | — | required | one of the 26 event names (section 7) |
| `sequence` | — | — | required | integer >= 0, monotonic per session |
| `project_id` | — | — | optional | present when the event pertains to an open project |
| `session` | — | optional | optional | engine session id (section 4) |

Envelope keys are closed (`additionalProperties: false`): unknown top-level
keys are rejected. Payload objects are open: unknown payload fields are
allowed and must be ignored (forward compatibility, section 9). Methods whose
payload schema declares required fields must carry a `payload` object.

The design document illustrates envelopes with a placeholder `payload:{}`;
real requests carry the documented fields, and argument-less methods send
`payload:{}`.

## 3. Request/response correlation

- Every request carries a client-chosen `id` that is unique among in-flight
  requests. The engine echoes it unchanged.
- **Exactly one terminal response per request.** No request is ever answered
  twice; a request is never left unanswered (success, failure, or shutdown
  aside).
- Long-running actions (`run.start`, `import.start`, `simulation.start`,
  `cocreate.start`, ...) return an immediate **acceptance response**
  (`ok:true`) or a rejection (`ok:false`, e.g. `host_busy`). Progress and the
  terminal outcome arrive as events (`run.*`, `stream.*`, `import.*`, ...).
- A duplicate `id` while the original is still in flight is rejected with
  `duplicate_request_id`. Reusing an id after its response arrived is allowed
  (but discouraged).
- Mutating requests remain subject to the Go host's existing exclusivity
  rules; a conflicting mutation is rejected with `host_busy`, and commands
  that need an open project are rejected with `project_unavailable`.
- `engine.shutdown` replies `ok:true`, flushes state, then exits. The
  supervisor waits out its grace period before force-termination.

## 4. Sessions, sequencing, and event ordering

- Events carry a `sequence` integer that is **monotonic within an engine
  session** (strictly increasing as produced; non-negative; typically numbered
  from 1). Events are emitted on stdout in sequence order.
- Responses and events may carry an optional `session` string: the
  engine-session id. It is absent in the spec's original examples and remains
  optional, but implementations should emit it once a session exists, and
  clients must use it when present.
- **A changed `session` value signals a sidecar restart and a sequence
  reset.** Sequence numbers from the old session must never be compared with
  numbers from the new session.

### Sidecar recovery procedure

1. The client observes `engine.exited` (old session), possibly
   `engine.restarting`, and finally `engine.ready` carrying a new `session`
   id, a reset `sequence`, and typically `payload.recovered:true`.
2. On the session change the client drops all buffered ordering state, issues
   `project.snapshot`, and replays history via `project.replay_events` (and
   `logs.replay` for structured logs).
3. Whether to resume, inspect, or close remains an explicit user action unless
   existing engine recovery semantics authorize automatic continuation. The
   client never guesses whether the last operation completed.

See `fixtures/valid-events-sidecar-recovery.jsonl` for the wire shape.

### Duplicate tolerance

Delivery is at-least-once: an event may be re-delivered with its **original**
sequence number (for example during replay or after a transport hiccup).
Duplicates are valid protocol messages; clients deduplicate on the
`(session, sequence)` pair. A sequence number never goes backwards within a
session except for an exact re-delivery. See
`fixtures/valid-events-duplicate-sequence-replay.jsonl`.

### Replay semantics

- `project.replay_events` with `payload.after_sequence` re-emits buffered
  project events with a greater sequence number (same session), using their
  original sequence numbers so clients can deduplicate and order seamlessly.
- After a session change (restart), replay numbering starts over under the new
  session id; the client snapshots first, then replays.
- `logs.replay` behaves the same way for buffered structured log records.

## 5. Errors

Failures are structured: `ok:false` plus `error:{code, message, details?}`.
Codes are stable snake_case strings and are binding for all implementations.

| Code | Meaning | Typical trigger |
|---|---|---|
| `malformed_json` | An input line could not be parsed as a JSON object. | Truncated/invalid NDJSON line, or a line that parses to a non-object. |
| `invalid_payload` | The line parsed but the envelope or payload is invalid. | Missing required payload field, wrong type, unknown/extra envelope key, or an unsupported `protocol` value. |
| `unknown_method` | The request `method` is not in the desktop-v1 catalog. | Typos or methods from another protocol version. |
| `duplicate_request_id` | The request `id` is already in flight. | Client reusing ids concurrently. |
| `project_unavailable` | The command requires an open project and none is open. | Any project/run/chapter command before `project.open` completes. |
| `host_busy` | The host's exclusivity rules reject the mutating request. | Starting a second exclusive operation (for example a run during a run). |
| `operation_failed` | The requested operation was attempted and failed. | Engine-reported failures: provider errors, invalid source files, export errors. |
| `cancelled` | The requested operation was cancelled before reaching a terminal state. | A queued/starting operation superseded by an abort or user cancellation. |
| `internal_error` | Unexpected internal daemon failure. | Panics, unreachable states. Treat engine state as unknown. |

### Error routing

- **Parseable but invalid requests** (unknown method, invalid payload,
  duplicate id, unsupported protocol value) receive an ordinary error
  response echoing the request `id` when one is present.
- **Unparseable lines and non-object lines** cannot be correlated: the engine
  emits an `engine.error` **event** with `payload.code:"malformed_json"` (and
  logs to stderr) instead of a response. No request id exists to echo.
- **Asynchronous engine failures** (mid-run failures, provider outages) are
  reported as `run.failed` / `engine.error` / `notification.error` events,
  not as responses; the triggering request, if any, already received its
  acceptance response.

## 6. Method catalog (49 methods, binding)

Payload schemas are named `<method>_request` in `commands.schema.json`. "req"
fields must be present inside `payload`; "opt" fields are documented optional
fields. Loose object fields intentionally defer to the Go engine and are not
enumerated.

### engine

| Method | req | opt | Notes |
|---|---|---|---|
| `engine.ping` | — | — | Liveness check. |
| `engine.shutdown` | — | `reason` | Graceful stop; engine exits after `ok:true`. |

### project

| Method | req | opt | Notes |
|---|---|---|---|
| `project.create` | `path` | `name`, `options` | Path chosen via native dialog. |
| `project.open` | `path` | — | |
| `project.close` | — | `force` | Unsaved-change protection enforced by engine. |
| `project.snapshot` | — | — | Full snapshot of open project state. |
| `project.resume` | — | `checkpoint_id` | Crash/interruption recovery. |
| `project.reopen` | — | `direction` | Reopen a completed book; direction optionally passed to Arbiter. |
| `project.replay_events` | — | `after_sequence`, `limit` | Replay after reconnect/restart. |

### run

| Method | req | opt | Notes |
|---|---|---|---|
| `run.start` | — | `goal`, `options` | Acceptance response; progress via events. |
| `run.continue` | — | `instruction` | Continue run; instruction optionally passed to Arbiter before restart. |
| `run.steer` | `instruction` | `context` | Natural-language steering. |
| `run.abort` | — | `reason` | |
| `run.pause` | — | — | |
| `run.advance_one_chapter` | — | — | Explicit chapter authorization. |
| `run.set_advance_mode` | `mode` | — | Mode name as understood by the engine. |
| `run.retry` | — | — | Retry last failed step/run. |

### cocreate

| Method | req | opt | Notes |
|---|---|---|---|
| `cocreate.start` | `message` | `mode`, `options` | Opening user message. |
| `cocreate.stage` | `message` | `options` | Input for the current stage (accept/edit). |
| `cocreate.resume` | — | — | |
| `cocreate.cancel` | — | `reason` | |

### chapter / revision / export

| Method | req | opt | Notes |
|---|---|---|---|
| `chapter.list` | — | — | |
| `chapter.read` | `chapter` | — | `chapter`: number or id (string or integer). |
| `chapter.save` | `chapter`, `content` | `base_version` | Revision conflict detection via `base_version`. |
| `chapter.revisions.check` | — | `chapter` | Without `chapter`, checks all chapters. |
| `chapter.revisions.sync` | — | `chapter` | Without `chapter`, syncs all chapters. |
| `chapter.export` | — | `chapters`, `format`, `output_path` | Output path via native dialog. |

### artifacts

| Method | req | opt | Notes |
|---|---|---|---|
| `artifacts.read` | `kind` | `chapter` | Read-only artifact projection. `kind`: `facts` (per-chapter accepted chapter facts), `world` (world rules), `summary` (chapter summaries). `chapter` scopes facts/summary to one chapter; rejected with `invalid_payload` for `kind:world`. Response shapes in section 12. |

### import

| Method | req | opt | Notes |
|---|---|---|---|
| `import.start` | `source_path` | `options` | Source via native dialog. |
| `import.resume` | — | — | |
| `import.cancel` | — | `reason` | |

### simulation

| Method | req | opt | Notes |
|---|---|---|---|
| `simulation.start` | `source_path` | `options` | Source file or directory via native dialog. The engine stages the source into the project corpus directory (`<project>/simulate`, returned as `engine_source_dir`); see §12 for staging semantics. |
| `simulation.resume` | — | — | Re-runs the engine over the project corpus directory (incremental merge by content fingerprint). Rejected with `operation_failed` when no corpus is staged yet. |
| `simulation.cancel` | — | `reason` | |
| `simulation.profile_import` | `profile_path` | `options` | Imports a produced profile. |

### configuration

| Method | req | opt | Notes |
|---|---|---|---|
| `config.get` | — | `keys` | Response always redacted of secrets. |
| `config.update` | `values` | — | Loose key/value map. |
| `config.providers` | — | — | Credentials redacted. |
| `config.models` | — | `provider` | |
| `config.switch_model` | `provider`, `model` | — | |
| `config.thinking_levels` | — | `provider`, `model` | |
| `config.set_thinking` | `level` | — | Level name from `config.thinking_levels`. |
| `config.set_language` | `language` | — | UI language code. |
| `config.set_story_language` | `language` | — | Story output language code. |

### diagnostics / usage / logs / runtime

| Method | req | opt | Notes |
|---|---|---|---|
| `diagnostics.snapshot` | — | — | Findings, errors, sessions, checkpoints. |
| `diagnostics.export` | — | `output_path`, `include` | Sanitized bundle only. |
| `usage.snapshot` | — | — | |
| `logs.replay` | — | `after_sequence`, `limit`, `level` | Buffered structured logs. |
| `runtime.queue` | — | — | Runtime event queue state. |

## 7. Event catalog (26 events, binding)

Payload schemas are named `<event>_event` in `events.schema.json`.

### engine lifecycle

| Event | req | opt | Notes |
|---|---|---|---|
| `engine.ready` | — | `recovered` | New session id + reset sequence after restart. |
| `engine.status_changed` | `status` | — | idle, running, paused, recovered, ... |
| `engine.error` | `message` | `code`, `details` | Also used for `malformed_json` input lines. |
| `engine.exited` | — | `reason`, `exit_code` | |
| `engine.restarting` | — | `attempt`, `reason` | Catalog-reserved † |

### run lifecycle

| Event | req | opt | Notes |
|---|---|---|---|
| `run.started` | — | `run_id`, `goal` | |
| `run.step_changed` | `step` | — | Flow step name. |
| `run.progress` | — | `completed`, `total`, `detail` | |
| `run.paused` | — | `reason` | |
| `run.completed` | — | `summary` | Terminal (success). |
| `run.failed` | — | `message` (req), `code` | Terminal (failure). |
| `run.aborted` | — | `reason` | Terminal (user abort). |

### stream

| Event | req | opt | Notes |
|---|---|---|---|
| `stream.delta` | `text` | `channel` | Appended streamed fragment. |
| `stream.clear` | — | `channel`, `reason` | Clears current stream content. |

Stream completion is signalled by the owning lifecycle event (`run.completed`,
`run.failed`, `run.aborted`, `cocreate.progress` stage changes); there is no
separate `stream.completion` event in v1.

### checkpoint / artifacts / chapters / outline / usage

| Event | req | opt | Notes |
|---|---|---|---|
| `checkpoint.created` | `checkpoint_id` | `step` | Catalog-reserved † |
| `artifact.updated` | `artifact` | `version`, `path` | Catalog-reserved † (outline, characters, facts, world, ...) |
| `chapter.updated` | `chapter` | `version`, `status` | |
| `outline.updated` | — | `version` | Catalog-reserved † |
| `usage.updated` | — | `usage`, `budget` | Loose counters inside. |

### progress

| Event | req | opt | Notes |
|---|---|---|---|
| `cocreate.progress` | `stage` | `message` | |
| `import.progress` | — | `completed`, `total`, `detail` | |
| `simulation.progress` | — | `completed`, `total`, `detail` | |
| `diagnostics.completed` | — | `findings`, `output_path` | |

### notifications

| Event | req | opt | Notes |
|---|---|---|---|
| `notification.info` | `message` | `details` | |
| `notification.warning` | `message` | `details` | |
| `notification.error` | `message` | `details` | Catalog-reserved † |

† *Catalog-reserved, not emitted by the release-one Go daemon*: the five
events marked above (`engine.restarting`, `checkpoint.created`,
`artifact.updated`, `outline.updated`, `notification.error`) are part of the
binding catalog but are never emitted by the release-one daemon. A sidecar
restart is signalled by the Rust shell instead (`desktop://status`
`restarting`/`ready` plus the new session's `engine.ready`), and error-level
host events surface as `engine.error`. Clients must still tolerate these
events should a newer engine emit them (additive compatibility, §9); the
table above remains the binding event catalog.

## 8. Redaction rules

- **Secrets never appear on the protocol.** API keys, tokens, and credentials
  are never included in any request payload, response payload, event payload,
  `error.details`, notification, or diagnostics output.
- Secrets remain in Go-side configuration paths only. `config.get`,
  `config.providers`, and related responses return provider metadata with
  credentials redacted (masked or omitted).
- Provider error strings are scrubbed before they reach `error.message`,
  `engine.error`, or `run.failed` payloads.
- `diagnostics.export` produces a sanitized bundle; the sanitizer is part of
  the binding contract for that command.

## 9. Compatibility and versioning

- `protocol` is the literal `"desktop-v1"`; anything else is rejected.
- Within desktop-v1 only **additive** changes are permitted: new optional
  payload fields, new methods, new events, new error codes. Existing names,
  fields, semantics, and codes are never renamed, removed, or repurposed.
- Payload objects are open (`additionalProperties` unset) precisely so the
  engine can add fields without breaking older readers; clients **must ignore
  unknown payload fields** and **must ignore event names they do not know**.
- The engine rejects methods it does not implement with `unknown_method`;
  forward-added methods are how old clients meet new engines.
- Breaking changes require a new protocol identifier (`desktop-v2`) and a new
  schema directory; desktop-v1 remains frozen once released.
- These schemas and fixtures are the shared conformance surface: Go, Rust,
  and frontend protocol tests all consume `fixtures/` unchanged.

## 10. Fixtures

All fixtures are NDJSON (`.jsonl`), one JSON object per line. Files prefixed
`invalid-` must be rejected (unparseable or schema-invalid); every other file
must validate line-by-line.

| File | Contents | Expected |
|---|---|---|
| `valid-request.jsonl` | One valid request (binding envelope example). | accept |
| `valid-response-success.jsonl` | Success responses, incl. the binding example and one with `session`. | accept |
| `valid-response-error.jsonl` | Structured error responses (`host_busy`, `project_unavailable`). | accept |
| `valid-events-stream-lifecycle.jsonl` | `run.started`, `stream.delta` x2, `stream.clear`, `run.completed` (completion). | accept |
| `valid-events-duplicate-sequence-replay.jsonl` | Same-session duplicate sequence 471 re-delivered, then 472. | accept |
| `valid-events-sidecar-recovery.jsonl` | Old session events, exit/restart, `engine.ready` with new session id and reset sequence. | accept |
| `valid-requests-catalog.jsonl` | One valid request per method (49 lines). | accept |
| `valid-events-catalog.jsonl` | One valid event per event name (26 lines). | accept |
| `invalid-malformed-line.jsonl` | Truncated JSON and garbage lines. | reject |
| `invalid-schema-violations.jsonl` | Wrong protocol, missing required fields, unknown method/event, bad error shapes, non-object line. | reject |

## 11. Validation

Deterministic validation with pinned ajv (Node 26 / npm 11):

```bash
cd protocols/desktop-v1
npm install
npm run validate   # or: node validate.mjs
```

The validator compiles both schemas (draft 2020-12, strict mode), checks
catalog completeness (every method/event has a named payload schema and an
if/then selector), validates every fixture line in both directions (valid
fixtures must pass; `invalid-*` fixtures must be rejected), probes that each
required envelope field is actually enforced, and exits non-zero on any
unexpected result or missing required field.

## 12. Catalog notes

- The design document's illustrative event example uses `engine.progress`.
  The binding event families list has no `engine.progress`: run progress is
  `run.progress` and engine state changes are `engine.status_changed`. The
  catalog in section 7 is authoritative; `engine.progress` is not a desktop-v1
  event name.
- Stream completion is expressed through run lifecycle terminal events (see
  section 7, "stream").
- **`artifacts.read` response shapes** (read-only projections over the
  engine's persisted artifacts; payloads are open, clients ignore unknown
  fields):
  - `kind:"facts"` without `chapter` → `{kind, facts:[{chapter, version,
    origin, facts:{title, summary, characters[], key_events[],
    timeline_events[], foreshadow_updates[], relationship_changes[],
    state_changes[], cast_intros[], hook_type?, dominant_strand?, ...}}],
    count}` — one entry per completed chapter that has an accepted record.
  - `kind:"facts"` with `chapter` → `{kind, chapter, found,
    version?, origin?, facts?}` — `found:false` when that chapter has no
    accepted facts record yet (normal for in-progress chapters).
  - `kind:"world"` → `{kind, rules:[{category, rule, boundary?}], count}` —
    the engine's world-rules ledger.
  - `kind:"summary"` without `chapter` → `{kind, summaries:[{chapter, title,
    summary, characters[], key_events[]}], count}` — per completed chapter.
  - `kind:"summary"` with `chapter` → `{kind, chapter, found, summary?}` —
    `found:false` when no summary exists for that chapter yet.
- **Chapter versions are not addressable.** The engine's store persists, per
  chapter, only the latest working draft (`drafts/NN.draft.md`), the final
  text (`chapters/NN.md`), and a single latest accepted record
  (`meta/chapter_records`) whose `revision`/`base_version` is a conflict
  counter — not a content history. There is therefore no intermediate or
  historical version for `chapter.read` to return; it always returns the
  latest final text, and clients must not present version pickers. This is
  the binding store-level bound; exposing history would require a new
  additive method backed by versioned storage.
- **Simulation corpus semantics.** `simulation.start {source_path}` genuinely
  consumes the selected source: a `.txt`/`.md`/`.markdown` file or a directory
  containing them is staged into the project corpus directory
  (`<project>/simulate`, the absolute path returned as `engine_source_dir`).
  Staging **accumulates**: sources from earlier runs stay, re-staging a source
  with the same relative path replaces the previous copy (matching the engine's
  profile merge, which keys on relative path + content fingerprint), and
  subdirectory layout is preserved. Unsupported file types are skipped when
  staging a directory and rejected with `operation_failed` when supplied as a
  single file. `simulation.resume` re-runs the engine over that same corpus
  directory (the merge is incremental, so only new or changed sources are
  analyzed).
