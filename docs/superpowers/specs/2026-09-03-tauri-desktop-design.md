# Tauri Desktop Application Design

**Status:** Approved architecture baseline; implementation plan pending user review
**Issue:** `ainovel-cli-8ey`

## Goal

Build a cross-platform desktop application for macOS, Windows, and Linux with full parity with the current CLI, while preserving the current Go engine as the release-one source of truth and keeping a 100% Rust engine as an optional later implementation.

## Scope

Release one supports:

- Project creation, opening, resume, and crash recovery.
- Novel generation, streaming output, start, continue, steer, pause, abort, retry, and chapter-advance controls.
- Chapter browsing, reading, editing, saving, revision detection, synchronization, and export.
- Outline, characters, summaries, facts, and world information views.
- Co-create workflows.
- Import, resume, cancellation, and simulation/profile workflows.
- Diagnostics, event history, logs, usage, budgets, notifications, and sanitized export.
- Provider/model selection, thinking levels, language, story-language, and configuration settings.
- macOS Apple Silicon and Intel, Windows x64, and Linux x64 AppImage plus `.deb` packaging.

Terminal-only interactions are represented by equivalent desktop controls, menus, dialogs, or keyboard shortcuts. The existing CLI remains supported and buildable.

## Architecture

```text
Svelte + TypeScript frontend
        ↕ Tauri commands/events
Rust/Tauri desktop shell
        ↕ versioned newline-delimited JSON over private stdin/stdout
Current Go engine sidecar
        ↕
Host → Engine → Flow / Arbiter / Workers / Tools / Store
```

The frontend is a passive projection and command issuer. It does not read or mutate project files directly and does not duplicate routing or business decisions.

The current Go engine remains authoritative for `Host`, deterministic flow routing, Arbiter decisions, worker execution, model integrations, tools, atomic persistence, checkpoints, Saga recovery, and diagnostics. The Rust layer owns desktop lifecycle, sidecar supervision, native OS integration, packaging, updater behavior, and protocol translation.

All desktop code lives under `desktop/`. The existing Go engine remains under `cmd/` and `internal/`. The protocol lives under `protocols/desktop-v1/` and must not depend on private Go package names.

## Repository Layout

```text
 desktop/
   frontend/                 Svelte + TypeScript application
   src-tauri/                Rust/Tauri backend and native integration
   README.md                 Desktop development and build instructions
 protocols/
   desktop-v1/
     commands.schema.json    Request schema
     events.schema.json      Event schema
     README.md               Protocol contract and compatibility rules
```

## IPC Contract

Every message is one JSON object per line. stdout is protocol-only; logs use stderr and the existing file logger.

Request envelope:

```json
{"protocol":"desktop-v1","kind":"request","id":"req-8f3a","method":"project.open","payload":{}}
```

Response envelope:

```json
{"protocol":"desktop-v1","kind":"response","id":"req-8f3a","ok":true,"payload":{}}
```

Event envelope:

```json
{"protocol":"desktop-v1","kind":"event","event":"engine.progress","project_id":"project-123","sequence":481,"payload":{}}
```

Each request has an ID and exactly one terminal response. Long-running actions return an acceptance response and emit asynchronous events. Events have a monotonic sequence per engine session. The frontend tolerates duplicates and requests a fresh snapshot plus replay after reconnect.

Supported request families:

```text
engine.ping, engine.shutdown
project.create, project.open, project.close, project.snapshot, project.resume, project.replay_events
run.start, run.continue, run.steer, run.abort, run.pause, run.advance_one_chapter, run.set_advance_mode, run.retry
cocreate.start, cocreate.stage, cocreate.resume, cocreate.cancel
chapter.list, chapter.read, chapter.save, chapter.revisions.check, chapter.revisions.sync, chapter.export
import.start, import.resume, import.cancel
simulation.start, simulation.resume, simulation.cancel, simulation.profile_import
config.get, config.update, config.providers, config.models, config.switch_model
config.thinking_levels, config.set_thinking, config.set_language, config.set_story_language
 diagnostics.snapshot, diagnostics.export, usage.snapshot, logs.replay, runtime.queue
```

Supported event families:

```text
engine.ready, engine.status_changed, engine.error, engine.exited, engine.restarting
run.started, run.step_changed, run.progress, run.paused, run.completed, run.failed, run.aborted
stream.delta, stream.clear
checkpoint.created, artifact.updated, chapter.updated, outline.updated, usage.updated
cocreate.progress, import.progress, simulation.progress, diagnostics.completed
notification.info, notification.warning, notification.error
```

Unknown methods, malformed JSON, duplicate IDs, invalid payloads, and engine failures return stable machine-readable error codes plus human-readable details. Sensitive values are redacted from events, errors, UI logs, and diagnostics. Mutating requests remain subject to the Go host's existing exclusivity rules.

The same JSON fixtures are consumed by Go and Rust protocol tests. A future Rust engine implements the same contract without changing the frontend.

## Process Lifecycle and Recovery

Rust starts the Go sidecar with validated arguments and private pipes. On close, it sends a graceful shutdown request, waits for termination, and force-terminates only after the grace period. Unexpected exit emits `engine.exited`; Rust may restart the sidecar and exposes recovery state rather than guessing whether the last operation completed.

After restart, Go reloads persisted files and checkpoints, emits `engine.ready`, and the frontend requests `project.snapshot`. Resume, inspect, or close remains an explicit user action unless existing engine recovery semantics authorize automatic continuation.

## UI Structure

The application shell contains project selection, run status, usage, notifications, navigation, an active workspace, and an activity/stream/error panel.

Screens:

- Overview: project, progress, runtime state, recovery, budget, usage, recent events, and actions.
- Write: plan, streamed generated content, facts/activity, steer, pause, abort, continue, retry, and chapter authorization.
- Chapters: list, read, edit, save, unsaved-change protection, revision sync, and export.
- Outline/Characters/Facts: read-only projections with explicit backend commands for any future mutations.
- Co-create: pause, conversation, staged stream, review/edit, resume, and cancel.
- Import: native source selection, start/resume/cancel, progress, results, and continuation.
- Simulation: source selection, start/resume/cancel, profile display, and profile import.
- Diagnostics: quality findings, runtime errors, sessions, checkpoints, event queue, and sanitized export.
- Settings: providers, models, thinking levels, language, story language, output directory, budgets, notifications, and update channel.

Svelte stores contain disposable UI/session state only. Durable facts remain in the existing project files.

## Security and Platform Rules

- Native file dialogs select project and source paths.
- Frontend code cannot invoke arbitrary shell commands.
- Rust validates sidecar executable paths and arguments.
- IPC is private stdin/stdout, not a network listener.
- API secrets remain in Go-side configuration paths and are redacted from ordinary snapshots/events.
- Path traversal outside approved project/application directories is rejected where applicable.
- Existing project locks and atomic writes remain authoritative.
- Platform-specific process signals, paths, file locks, notifications, permissions, and updater behavior are tested separately.

## Packaging

| Platform | Targets | Artifacts |
|---|---|---|
| macOS | `aarch64`, `x86_64` | signed/notarized `.dmg` |
| Windows | `x86_64` | `.msi` and/or NSIS installer |
| Linux | `x86_64` | AppImage and `.deb` |

Each package contains the Tauri app, matching Go sidecar, protocol metadata, icons, and updater metadata. CI builds and checksums sidecars before packaging. Signing and notarization credentials exist only in CI.

## Verification

Go adapter tests cover envelopes, malformed input, unknown methods, request correlation, event ordering, stream boundaries, errors, shutdown, replay, and redaction. Rust tests cover sidecar startup, readiness, forwarding, exit/restart, graceful shutdown, and platform paths. Frontend tests cover project lifecycle, run controls, streaming, reconnect/replay, chapter save protection, diagnostics, settings, and dialogs.

Cross-platform smoke tests use a deterministic test model/provider and exercise create/open, start, progress/stream, steer/abort, app restart, recovery, and export. No test invokes a paid provider.

A feature has desktop parity only when its primary action, progress, errors, persisted result, and supported cancellation/recovery behavior are accessible and tested.

## Delivery Phases

1. Versioned protocol schemas, fixtures, Go daemon entrypoint, request dispatch, and event forwarding.
2. Tauri shell, sidecar supervision, typed Rust protocol, lifecycle, and native paths.
3. Svelte shell, connection state, API client, event store, snapshots, and shared components.
4. Full feature screens: overview/write, chapters/revisions, artifacts, co-create, import, simulation, diagnostics, settings, usage, and export.
5. macOS/Windows/Linux packaging, signing, updater metadata, CI, and native smoke testing.

## Optional Rust Engine Track

The future Rust implementation is selected behind an engine-provider boundary:

```text
EngineProvider
├── GoSidecarProvider
└── RustEngineProvider
```

It proceeds in this order: domain serialization, flow routing and exhaustive tests, store/atomic persistence, tools/artifact formats, Arbiter interfaces, worker execution/streaming, model integrations, differential fixtures, benchmarks, and only then optional selection. Go remains the reference/default until behavior, persistence, recovery, and protocol parity are proven. The Rust implementation must demonstrate measurable benefit in startup, memory, streaming latency, or package size before replacing the sidecar.

## Non-Goals

- Replacing the Go engine in release one.
- Changing existing project file formats.
- Adding a network service for local desktop communication.
- Duplicating business logic in Rust or Svelte.
- Automatically repairing or changing state from diagnostics.
- Removing or weakening the existing CLI.
