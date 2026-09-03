# Tauri Desktop Application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a full-parity desktop application for macOS, Windows, and Linux using a Tauri Rust shell, Svelte + TypeScript frontend, and the existing Go engine as a managed sidecar, while preserving a stable boundary for a future Rust engine.

**Architecture:** The existing Go `Host` remains the authoritative engine and persistence owner. A Go daemon exposes a versioned newline-delimited JSON protocol; Tauri supervises that process and forwards typed commands/events to a Svelte frontend. All desktop-specific code lives under `desktop/`; protocol schemas and fixtures live under `protocols/desktop-v1/`.

**Tech Stack:** Go 1.25.5, existing `Host`/`Engine`/`Store`/`Arbiter` stack, Tauri 2, Rust, Svelte, TypeScript, JSON Schema, platform-native Tauri bundles.

**Spec:** `docs/superpowers/specs/2026-09-03-tauri-desktop-design.md`

## Global Constraints

- Release one MUST retain the current Go engine as the source of truth.
- The existing CLI MUST remain buildable and behaviorally supported.
- Desktop code MUST remain under `desktop/`; protocol assets MUST remain under `protocols/desktop-v1/`.
- stdout from the Go daemon MUST contain only newline-delimited protocol JSON; logs MUST use stderr or existing file logging.
- The frontend MUST NOT read or mutate project files directly or duplicate engine decisions.
- IPC MUST use private stdin/stdout pipes, not a network listener.
- Every request MUST have one terminal response; long-running work MUST emit asynchronous events.
- Events MUST include monotonic sequence numbers per engine session.
- Secrets MUST be redacted from snapshots, events, errors, UI logs, and diagnostics.
- Existing atomic persistence, locking, checkpoints, Saga recovery, and exclusivity rules MUST remain authoritative.
- Supported release-one targets MUST include macOS Apple Silicon/Intel, Windows x64, and Linux x64 AppImage plus `.deb`.
- No paid LLM provider may be used by automated tests or smoke tests.

## File Map

### Protocol

- Create `protocols/desktop-v1/commands.schema.json`: request envelope and method payload schemas.
- Create `protocols/desktop-v1/events.schema.json`: response/event envelopes and event payload schemas.
- Create `protocols/desktop-v1/README.md`: wire rules, method/event catalog, compatibility policy, and redaction rules.
- Create `protocols/desktop-v1/fixtures/*.jsonl`: valid, invalid, streaming, error, replay, and recovery fixtures shared by Go/Rust tests.

### Go adapter

- Create `internal/entry/desktop/daemon.go`: daemon lifecycle and protocol stream loop.
- Create `internal/entry/desktop/protocol.go`: Go envelope types, decoder/encoder, error codes, and sequence generator.
- Create `internal/entry/desktop/dispatch.go`: method dispatch to public `host.Host` operations.
- Create `internal/entry/desktop/project.go`: project/config/artifact read projections.
- Create `internal/entry/desktop/redaction.go`: secret and sensitive-field redaction.
- Create `internal/entry/desktop/*_test.go`: protocol, dispatch, event, replay, lifecycle, and redaction tests.
- Modify `cmd/ainovel-cli/main.go`: add an explicit desktop-daemon mode without changing existing CLI modes.

### Tauri shell

- Create `desktop/src-tauri/Cargo.toml`, `tauri.conf.json`, capability configuration, and Rust source files.
- Create `desktop/src-tauri/src/main.rs`: Tauri setup and application lifecycle.
- Create `desktop/src-tauri/src/protocol.rs`: Rust representations of shared envelopes and payloads.
- Create `desktop/src-tauri/src/sidecar.rs`: process startup, stdin/stdout readers, shutdown, and restart state.
- Create `desktop/src-tauri/src/commands.rs`: typed frontend-invokable commands.
- Create `desktop/src-tauri/src/events.rs`: protocol-event forwarding and sequence/replay handling.
- Create Rust unit/integration tests and protocol-fixture tests.

### Frontend

- Create `desktop/frontend/package.json`, TypeScript/Vite/Svelte configuration, and app entry files.
- Create `desktop/frontend/src/lib/types/protocol.ts`: UI-facing protocol types.
- Create `desktop/frontend/src/lib/api/desktop.ts`: typed Tauri command wrappers.
- Create `desktop/frontend/src/lib/stores/desktop.ts`: connection, snapshot, run, stream, usage, activity, and notification state.
- Create shared components under `desktop/frontend/src/lib/components/`.
- Create route screens under `desktop/frontend/src/routes/` for overview, write, chapters, artifacts, co-create, import, simulation, diagnostics, settings, and export.
- Create frontend unit/component tests and desktop interaction tests.

### CI and documentation

- Create `.github/workflows/desktop.yml`: Go sidecar builds, frontend build, Tauri packaging, checksums, and platform gates.
- Modify root documentation only where needed to link desktop development/build instructions.
- Create `desktop/README.md`: prerequisites, local run, test commands, sidecar development, and release process.

## Task 1: Define the Versioned Protocol

**Files:** Create the protocol files listed above; test with Go and Rust fixture readers.

**Interfaces:** Produces `desktop-v1` request/response/event envelopes, stable method names, stable error codes, sequence rules, and JSON fixtures. Later Go, Rust, and frontend tasks consume these exact names and fields.

- [ ] Write schemas for request, response, and event envelopes. Require `protocol`, `kind`, and `id` on requests/responses; require `protocol`, `kind`, `event`, `sequence`, and optional `project_id` on events.
- [ ] Define payload schemas for all method families: engine/project, run, co-create, chapter/revision/export, import/simulation, configuration, diagnostics, usage/log replay/runtime queue.
- [ ] Define event payload schemas for engine lifecycle, run lifecycle, stream, checkpoint/artifact updates, feature progress, diagnostics, usage, and notifications.
- [ ] Define error codes for malformed JSON, invalid payload, unknown method, duplicate request ID, unavailable project, busy host, operation failure, cancellation, and internal failure.
- [ ] Add fixtures for one valid request, one success response, one structured error, stream delta/clear/completion events, duplicate sequence replay, malformed input, and sidecar recovery.
- [ ] Document stdout/stderr separation, one-response rule, event ordering, duplicate tolerance, replay semantics, compatibility versioning, and secret redaction.
- [ ] Validate schemas and fixtures with a deterministic script that fails on invalid fixture acceptance or missing required fields.

## Task 2: Add the Go Desktop Daemon Adapter

**Files:** Create `internal/entry/desktop/daemon.go`, `protocol.go`, `dispatch.go`, `project.go`, `redaction.go`, tests; modify `cmd/ainovel-cli/main.go`.

**Interfaces:** Consumes `desktop-v1` JSON lines and existing public `host.Host` methods including `StartPrepared`, `Resume`, `Continue`, `Steer`, `Abort`, `SetAdvanceMode`, `AdvanceOneChapter`, co-create, import, simulation, revisions, diagnostics, export, model, usage, snapshot, and replay capabilities. Produces one response per request plus sequenced events and stream events.

- [ ] Add an explicit `--desktop-daemon` or equivalent internal startup mode that bypasses TUI/headless output and runs the protocol loop; preserve normal CLI parsing and behavior.
- [ ] Implement a decoder that reads one JSON object per line, rejects malformed/oversized input with structured errors, and never logs protocol data to stdout.
- [ ] Implement request correlation and duplicate-ID rejection for active requests.
- [ ] Build the host using the same bootstrap/config/assets path as existing entries, with a desktop-specific logger target that preserves full details in files/stderr.
- [ ] Dispatch project lifecycle requests and return redacted snapshots.
- [ ] Dispatch run controls and bridge `Host.Events()` and `Host.Stream()` to protocol events without blocking request responses.
- [ ] Dispatch chapter, outline, character, summary, revision, export, co-create, import, simulation, diagnostics, configuration, usage, logs, and queue operations using existing APIs or focused read-only adapters where no public API exists.
- [ ] Map Go errors to stable error codes while preserving complete diagnostic details in the sidecar log.
- [ ] Assign monotonic event sequence numbers and include project/session identity.
- [ ] Implement graceful `engine.shutdown`, close host resources, close event streams, and return a clean process exit.
- [ ] Add tests for malformed input, unknown methods, duplicate IDs, request correlation, event ordering, stream clear boundaries, error mapping, shutdown, redaction, and fixture compatibility.
- [ ] Run the focused Go adapter tests and existing package tests covering modified entry/bootstrap behavior.

## Task 3: Build the Tauri Rust Shell and Sidecar Supervisor

**Files:** Create `desktop/src-tauri/` files and Rust tests.

**Interfaces:** Consumes Go daemon protocol lines; produces typed Tauri commands/events and exposes a `GoSidecarProvider` boundary that can later coexist with `RustEngineProvider`.

- [ ] Initialize Tauri 2 configuration under `desktop/src-tauri` without changing root Go module behavior.
- [ ] Implement Rust protocol types matching the schemas and reject incompatible protocol versions.
- [ ] Implement sidecar launch with validated executable path, target-specific arguments, private piped stdin/stdout/stderr, and no shell interpolation.
- [ ] Implement asynchronous stdout line reading, response correlation, event forwarding, malformed-output handling, and stderr logging.
- [ ] Implement sidecar readiness, health state, graceful shutdown request, grace timeout, and final forced termination through the child-process API.
- [ ] Implement unexpected-exit handling and bounded restart state; never infer operation success from process exit alone.
- [ ] Implement typed Tauri commands for sending protocol requests and returning structured errors.
- [ ] Implement native path resolution and application/project directory handling for macOS, Windows, and Linux.
- [ ] Add protocol fixture tests, request correlation tests, event forwarding tests, graceful shutdown tests, unexpected-exit tests, and path tests.
- [ ] Run focused Rust tests and a development Tauri startup smoke test.

## Task 4: Scaffold the Svelte Frontend Foundation

**Files:** Create `desktop/frontend/` configuration, `src/lib/types/protocol.ts`, `src/lib/api/desktop.ts`, `src/lib/stores/desktop.ts`, shell components, and tests.

**Interfaces:** Consumes Tauri typed commands/events and produces reactive UI projections. It must not access the filesystem or Go internals.

- [ ] Initialize Svelte + TypeScript + Vite under `desktop/frontend` with scripts for dev, typecheck, test, and build.
- [ ] Define frontend types for envelopes, engine state, project snapshot, run state, stream state, usage, activity, notifications, and structured errors.
- [ ] Implement a typed API wrapper that attaches request IDs, awaits one response, and surfaces stable error codes.
- [ ] Implement stores for connection state, engine state, project snapshot, activity sequence, stream deltas/clear markers, run state, usage, and notifications.
- [ ] Implement startup handshake, snapshot fetch, event subscription, duplicate-event tolerance, reconnect, and replay from the last sequence.
- [ ] Build the application shell with project switcher, status/usage/notification header, navigation, active workspace, activity panel, stream panel, and error presentation.
- [ ] Add focused component/store tests for request failure, event ordering, clear boundaries, reconnect, and replay.
- [ ] Run frontend typecheck, unit tests, and production build.

## Task 5: Implement Project Lifecycle and Writing UI

**Files:** Add overview/write screens and shared run/stream/activity components.

**Interfaces:** Consumes project/run/stream protocol methods and events from Tasks 1–4; produces complete start/resume/continue/steer/pause/abort/retry/advance interactions.

- [ ] Implement native project create/open selection through Tauri and project snapshot loading.
- [ ] Implement overview rendering for project identity, progress, runtime status, recovery state, budget, usage, recent events, and last errors.
- [ ] Implement write view with plan/content/facts-activity panes and streaming markdown/text rendering.
- [ ] Implement stream clear handling so worker rounds are visually separated without losing persisted content.
- [ ] Implement controls for start, resume, continue, steer, pause, abort, retry, advance mode, and one-chapter authorization with backend confirmation/error states.
- [ ] Protect controls based on engine state returned by the backend; do not hardcode workflow transitions in Svelte.
- [ ] Add interaction tests for new/open, start, stream, steer, abort, resume after reconnect, and explicit recovery choice.
- [ ] Run frontend tests and a controlled-engine desktop smoke scenario.

## Task 6: Implement Content, Artifacts, Revision, and Export UI

**Files:** Add chapter, outline, character, facts, summaries, revision, and export screens/components.

**Interfaces:** Consumes chapter/artifact/revision/export methods and update events; all mutations go through protocol commands.

- [ ] Implement chapter list/status and final/intermediate artifact reads.
- [ ] Implement markdown editor with dirty state, save command, save errors, and close/navigation unsaved-change protection.
- [ ] Implement revision check and synchronization flows with explicit confirmation and result display.
- [ ] Implement read-only outline, characters, facts, world, and summary projections.
- [ ] Implement chapter and complete-book export through the backend, using native destination selection where required.
- [ ] Add tests for read, edit/save, dirty protection, revision mismatch/sync, artifact updates, and export errors.
- [ ] Run focused frontend tests and a smoke export against a fixture project.

## Task 7: Implement Co-create, Import, and Simulation UI

**Files:** Add co-create, import, simulation screens and progress/cancellation components.

**Interfaces:** Consumes co-create/import/simulation protocol methods/events; produces explicit staged-draft review and cancellation flows.

- [ ] Implement co-create pause, conversation history, staged streaming, draft review/edit, resume, and cancel.
- [ ] Implement native source file/directory selection and import start/resume/cancel with progress and result artifacts.
- [ ] Implement simulation source selection, start/resume/cancel, generated profile display, and profile import.
- [ ] Distinguish staged/generated content from active durable project facts in all screens.
- [ ] Add tests for progress events, cancellation, staged-draft confirmation, import result display, simulation profile import, and operation errors.
- [ ] Run controlled smoke flows for each feature without paid providers.

## Task 8: Implement Diagnostics, Settings, Usage, Notifications, and Logs

**Files:** Add diagnostics/settings/usage screens, notification handling, and log/event views.

**Interfaces:** Consumes diagnostics, config, usage, log replay, runtime queue, and notification methods/events; produces redacted UI projections and explicit settings mutations.

- [ ] Implement diagnostics findings, runtime errors, sessions, checkpoints, event queue, and sanitized export.
- [ ] Enforce observer-only behavior: diagnostics screens cannot auto-repair, resume, or mutate engine state.
- [ ] Implement provider/model selection, role thinking levels, language, story language, output directory, budgets, notification preferences, and update channel.
- [ ] Ensure configuration screens never display secrets from ordinary snapshots and use backend redaction/error behavior.
- [ ] Implement usage and budget indicators plus desktop notifications for completion, pause, warning, and failure events.
- [ ] Implement log/event replay views with filtering and full-detail access subject to redaction.
- [ ] Add tests for diagnostics rendering, export, configuration validation, secret absence, usage updates, notifications, and replay.
- [ ] Run focused tests and a smoke flow that generates a sanitized diagnostic export.

## Task 9: Package and Release on Three Platforms

**Files:** Create `desktop/README.md`, `.github/workflows/desktop.yml`, Tauri bundle configuration, icons/resources, and release metadata.

**Interfaces:** Consumes built frontend and target-specific Go sidecars; produces installable, signed release artifacts.

- [ ] Define sidecar build matrix for macOS `aarch64`/`x86_64`, Windows `x86_64`, and Linux `x86_64`.
- [ ] Build sidecars with reproducible version metadata and verify checksums before packaging.
- [ ] Configure Tauri external binaries and target-specific naming for every supported platform.
- [ ] Configure macOS `.dmg`, signing, and notarization; Windows `.msi`/NSIS; Linux AppImage and `.deb`.
- [ ] Add updater metadata and target artifact verification without embedding signing credentials in the repository.
- [ ] Add CI jobs for Go tests, protocol validation, Rust tests, frontend typecheck/test/build, and packaging gates.
- [ ] Document prerequisites, local development, sidecar debugging, test commands, signing variables, and release steps.
- [ ] Run native smoke tests on each supported runner: create/open, start controlled run, observe stream/progress, steer/abort, restart, recover/inspect, and export.

## Task 10: Establish the Optional Rust Engine Compatibility Track

**Files:** Create a Rust engine workspace/module only after Tasks 1–9 are stable; add provider abstraction and differential fixtures.

**Interfaces:** `EngineProvider` exposes the same protocol-level behavior as `GoSidecarProvider`; `RustEngineProvider` is disabled by default until parity gates pass.

- [ ] Define provider selection in the Rust shell with `GoSidecarProvider` as the default and no user-visible Rust option until parity is proven.
- [ ] Port domain serialization and create compatibility tests against existing Go JSON fixtures.
- [ ] Port `flow.Route` and reuse exhaustive transition cases as differential tests.
- [ ] Port store read/write and atomic persistence behavior, including checkpoint and recovery fixtures.
- [ ] Port tools and artifact formats without changing existing project files.
- [ ] Port Arbiter interfaces, worker execution/streaming, and model integrations only after lower layers pass.
- [ ] Run differential replay tests comparing Go and Rust responses/events for identical fixtures.
- [ ] Benchmark startup, memory, streaming latency, and package size; do not switch defaults without a measurable benefit.
- [ ] Add an explicit compatibility gate requiring protocol, persistence, recovery, and behavior parity before enabling Rust selection.

## Verification and Handoff

- [ ] Run the full existing Go test suite after adapter integration.
- [ ] Run protocol validation, focused Go adapter tests, Rust tests, frontend typecheck/tests/build, and platform packaging gates.
- [ ] Run native smoke tests for macOS, Windows, and Linux using a deterministic test provider.
- [ ] Confirm the existing CLI still starts in TUI/headless modes and no desktop protocol JSON leaks into normal output.
- [ ] Confirm secrets do not appear in protocol fixtures, UI snapshots, forwarded logs, or diagnostic exports.
- [ ] Update Beads issue status only after the implementation and quality gates are complete; do not commit or push under the conservative repository profile without explicit authorization.
