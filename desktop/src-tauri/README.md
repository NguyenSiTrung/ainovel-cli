# AI Novel Desktop — Tauri Rust Shell

Tauri 2 shell supervising the Go engine sidecar over the `desktop-v1`
NDJSON protocol (`protocols/desktop-v1/`). This crate is standalone: the
repository root is a Go module and is never touched by `cargo` commands
below (run them from `desktop/src-tauri`).

## Layout

| Path | Purpose |
|---|---|
| `src/protocol.rs` | Envelope types + line parser; fixture conformance tests |
| `src/sidecar.rs` | Process supervisor: spawn, correlation, health, shutdown, bounded restart |
| `src/provider.rs` | `EngineProvider` trait boundary; `GoSidecarProvider` implementation |
| `src/events.rs` | Sequence/replay bookkeeping + Tauri event forwarding |
| `src/commands.rs` | `desktop_*` Tauri commands for the frontend |
| `src/paths.rs` | Native path validation + sidecar binary resolution |
| `src/error.rs` | Structured `{code, message, details?}` errors |
| `src/bin/mock_sidecar.rs` | Protocol-speaking test double (never shipped) |


## Commands

```bash
cargo check          # compiles without a real frontend (placeholder page embedded)
cargo test           # unit + fixture + process-level + app-wiring startup tests
cargo fmt
cargo tauri dev      # needs the sidecar resolvable (see below) + Task 4 frontend

# One-shot startup smoke: full app init (context codegen, setup, command
# registration, engine start) then exit before lingering in the event loop:
cargo build --bin mock-sidecar
AINOVEL_DESKTOP_SMOKE_EXIT=1 AINOVEL_SIDECAR="$PWD/target/debug/mock-sidecar" \
  cargo run --bin ainovel-desktop
```

The `desktop/frontend/dist` placeholder page is git-ignored by the root
`.gitignore` (`dist/`); `build.rs` regenerates it idempotently whenever it
is missing, before tauri codegen runs, so any fresh checkout self-heals and
Task 4's real Vite output simply supersedes it.

## Sidecar binary resolution (dev story)

The shell never hardcodes a build output. Resolution order
(`src/paths.rs::resolve_sidecar_path`):

1. **`AINOVEL_SIDECAR` env var** — explicit path override for dev and tests:
   ```bash
   go build -o /tmp/ainovel-engine ./cmd/ainovel-cli
   AINOVEL_SIDECAR=/tmp/ainovel-engine cargo tauri dev
   ```
   The path is validated (existing file, executable bit on Unix) before any
   spawn; there is no shell interpolation anywhere — the child is exec'd
   directly with the fixed argument `--desktop-daemon`.
2. **`ainovel-engine-<target-triple>`** next to the app executable — the
   externalBin naming convention used by the packaged app (CI/packaging is
   task 9; it will populate this name).
3. **`ainovel-engine`** (`.exe` on Windows) next to the app executable.

Without a resolvable binary the app still starts: engine commands return the
structured error `engine_unavailable`/`sidecar_error`, so the UI can show a
diagnostic instead of crashing. The mock sidecar used by tests lives at
`target/debug/mock-sidecar` after `cargo test`/`cargo build` and works fine
as `AINOVEL_SIDECAR` for manual smoke runs.

Child-only env vars (mock modes in tests) are passed through
`SidecarConfig::env`; nothing process-global is mutated.

## Tauri command surface (frontend contract, task 4)

Arguments are camelCase on the JS side (`invoke('desktop_request', { method, payload })`).

| Command | Signature | Notes |
|---|---|---|
| `desktop_request` | `(method: string, payload?: object) -> Promise<object>` | One protocol request. Resolves with the response payload; rejects with `{code, message, details?}`. |
| `desktop_status` | `() -> ProviderStatus` | `{health, stopping, session, pid, restartAttempts, restartsTotal, malformedOutputLines, stderrLines, lastError, lastExitCode, provider, protocol}`; health: `stopped|starting|ready|restarting|exited|failed`. |
| `desktop_start` | `() -> Promise<ProviderStatus>` | Idempotent start + wait for readiness. |
| `desktop_shutdown` | `(reason?: string) -> Promise<ProviderStatus>` | Graceful stop (`engine.shutdown` → grace → force kill). |
| `desktop_restart` | `(reason?: string) -> Promise<ProviderStatus>` | Stop + fresh start; session id changes. |
| `desktop_event_state` | `() -> EventState` | `{session, lastSequence, sessionsSeen, duplicatesDropped, forwardedCount, sessionChanges}` — replay cursor lives in `lastSequence`. |
| `desktop_paths` | `() -> DesktopPaths` | `{appDataDir, projectsDir, sidecarPath, sidecarSource, targetTriple}`. |
| `desktop_validate_project_dir` | `(path: string) -> Promise<ProjectDirReport>` | Native validation: absolute, no `..` traversal, exists, is a directory; `{path, recognized}` (`recognized` is a hint; the engine stays authoritative). |

Error codes: the 9 protocol codes plus shell extensions
`engine_unavailable` (engine not running/ready, or it died with the request
in flight), `request_timeout`, `sidecar_error` (spawn/supervision),
`invalid_path`.

## Tauri events (frontend contract, task 4)

| Event | Payload | Meaning |
|---|---|---|
| `desktop://event` | `{event, session, sequence, projectId, payload}` | One deduped protocol event (unknown event names are forwarded opaquely and must be ignored). |
| `desktop://session` | `{previous, current, lastSequence}` | Engine session changed (restart): refetch `project.snapshot` and replay. |
| `desktop://status` | `{health, ...}` | Supervisor lifecycle: ready / exited `{graceful, exitCode}` / restarting `{attempt}` / failed `{attempts, reason}` / degraded `{malformedOutputLines}`. |

Dedupe rule (`src/events.rs`): within a session, any sequence at or below
the last forwarded one is an exact re-delivery and is dropped; a session
change resets the window (README section 4 of the protocol).

## Supervisor lifecycle rules

- Readiness = first `engine.ready` (sequence 1, carries the session id). A
  readiness watchdog kills a silent child after `ready_timeout` (10 s
  default) so the bounded restart path takes over.
- Graceful shutdown: send `engine.shutdown`, drop stdin (EOF is also a
  graceful exit), wait `shutdown_grace` (5 s default), then force-kill via
  the child API.
- Unexpected exit: pending requests fail with `engine_unavailable` (process
  exit never implies operation success), then bounded restart — max 3
  attempts, exponential backoff 250 ms → 4 s; exhaustion settles in
  `failed`. The streak only resets after the restarted engine stays ready
  for `stable_after` (5 s default), so a flapping ready/crash loop remains
  bounded.
- A readiness watchdog kills a spawned child that never reports
  `engine.ready` within `ready_timeout` (10 s default), feeding the same
  bounded restart path.
- Malformed engine output is skipped, counted, and surfaced as a health
  signal — it never kills the reader.

## Placeholder notes

- `../frontend/dist/index.html` is a stub so `cargo check`/`cargo test` work
  without a Node toolchain; task 4 replaces it with the Svelte build.
- `icons/*.png` are generated placeholders; real icons ship with packaging
  (task 9), which also wires CI `externalBin` naming.
