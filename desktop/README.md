# AI Novel Desktop

The Tauri 2 desktop application: a Svelte 5 frontend (`frontend/`), a Rust
shell (`src-tauri/`), and the Go engine (`cmd/ainovel-cli` at the repository
root) running as a supervised sidecar process over the `desktop-v1` NDJSON
protocol on private stdin/stdout pipes. Packaging never changes that: the
sidecar is bundled as an external binary and still speaks stdin/stdout only.

Shell internals (command surface, supervisor lifecycle, protocol fixtures)
live in [`src-tauri/README.md`](src-tauri/README.md). Protocol contract:
[`protocols/desktop-v1/`](../protocols/desktop-v1/).

## Layout

```
desktop/
├── frontend/          Svelte 5 + Vite UI (npm)
├── src-tauri/         Rust shell (cargo)
│   ├── binaries/      Cross-compiled sidecars (gitignored; built by scripts/)
│   └── tauri.conf.json  Bundle/externalBin/updater configuration
├── scripts/
│   ├── build-sidecars.sh    Sidecar build matrix + checksums
│   └── updater-manifest.mjs Assembles the updater latest.json from bundles
└── package.json       Pinned @tauri-apps/cli + npm script aliases
```

## Prerequisites

| Tool | Notes |
| --- | --- |
| Go | version from the repository `go.mod` (engine + sidecar) |
| Rust | stable (>= 1.80 per `src-tauri/Cargo.toml`) |
| Node.js 22 + npm | frontend build and the pinned Tauri CLI |
| Linux only | `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev` (see the [Tauri prerequisites](https://tauri.app/start/prerequisites/)) |
| macOS only | Xcode command line tools (dmg + codesign); `iconutil`/`sips` were used to generate `icons/icon.icns` |
| Windows only | WebView2 (preinstalled on modern Windows); msi bundling uses WiX, downloaded automatically by the Tauri CLI |

Install the npm tooling once:

```bash
npm --prefix desktop ci        # pins @tauri-apps/cli (matches the tauri crate minor)
npm --prefix desktop/frontend ci
```

Plain `go build ./cmd/ainovel-cli` keeps working untouched; everything below
only adds packaging on top of it.

## Local development

```bash
npm --prefix desktop run dev
```

That resolves `AINOVEL_SIDECAR` to the host sidecar in
`src-tauri/binaries/` (building it on demand) and runs `tauri dev`.
Manual equivalent when you need explicit control:

```bash
# 1. Build the sidecar for your host (creates src-tauri/binaries/ainovel-engine-<triple>)
npm --prefix desktop run build:sidecars        # or: desktop/scripts/build-sidecars.sh

# 2. Run the shell in dev mode (hot-reloading frontend)
npm --prefix desktop run tauri dev
```

The shell resolves the engine binary in this order
(`src-tauri/src/paths.rs`, mirrored by the build matrix):

1. `AINOVEL_SIDECAR` env var — absolute or cwd-relative path (the dev story).
2. `ainovel-engine-<target-triple>` (`.exe` on Windows) next to the app
   executable — the name Tauri's `externalBin` bundling produces.
3. `ainovel-engine` (`.exe` on Windows) next to the app executable.

Because `tauri dev` does not bundle external binaries, prefer
`AINOVEL_SIDECAR` in dev:

```bash
AINOVEL_SIDECAR=desktop/src-tauri/binaries/ainovel-engine-$(rustc -vV | sed -n 's/host: //p') \
  npm --prefix desktop run tauri dev
```

Supported triples: `aarch64-apple-darwin`, `x86_64-apple-darwin`,
`x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu`.

## Sidecar debugging

* Engine **stderr** is forwarded to the shell log tagged `sidecar::stderr`;
  the engine itself additionally writes `desktop.log` inside the project
  directory. Engine **stdout** carries only protocol lines — anything
  malformed is counted and sampled via `desktop_status`
  (`malformedOutputLines`) and never crashes the reader.
* `desktop_status` (or the in-app diagnostics view) reports supervisor
  health (`stopped|starting|ready|restarting|exited|failed`), session id,
  restart counters, and `lastError`.
* One-shot startup smoke without a lingering window:

  ```bash
  AINOVEL_DESKTOP_SMOKE_EXIT=1 \
  AINOVEL_SIDECAR=desktop/src-tauri/binaries/ainovel-engine-<triple> \
    desktop/src-tauri/target/debug/ainovel-desktop
  ```

  It waits for `engine.ready`, round-trips `engine.ping`, and shuts down.
* The engine refuses to start (`engine.error`) when `~/.ainovel/config.json`
  is missing — run the interactive TUI once to configure providers. The
  smoke step in CI seeds `config.example.jsonc`; no provider network calls
  happen during `engine.ready`/`engine.ping`.

## Test commands (the four gates)

```bash
# Go engine
go vet ./... && go test -count=1 ./...          # add GOWORK=off if a go.work is active

# desktop-v1 protocol schemas + fixtures
cd protocols/desktop-v1 && npm ci && node validate.mjs

# Rust shell
cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml
# (No sidecar needed: build.rs generates a placeholder externalBin stub for
#  the host triple on fresh checkouts; building real sidecars is only
#  required to actually run or package the app.)

# Frontend
cd desktop/frontend && npm ci && npm run typecheck && npm test && npm run build
```

## Packaging

### Sidecar build matrix

`desktop/scripts/build-sidecars.sh [triple ...]` cross-compiles
`cmd/ainovel-cli` with `CGO_ENABLED=0` (pure Go — no cross toolchains
needed) into `src-tauri/binaries/`, one file per triple, plus a
`shasum -a 256 -c` / `sha256sum -c` compatible `.sha256` next to each binary.

Version metadata is injected with the exact ldflags `.goreleaser.yml` uses,
so the desktop sidecar and the standalone CLI share version provenance:

```text
-X main.version=$DESKTOP_VERSION -X main.commit=$DESKTOP_COMMIT -X main.date=$DESKTOP_DATE
```

Defaults come from git (`describe --tags --always`, `rev-parse`, commit
date); CI sets them explicitly (tag builds: tag without the `v` prefix;
other builds: the `tauri.conf.json` version). The same value is injected
into the app bundle via `tauri build --config '{"version": "..."}'`, so
sidecar and shell always report the same version.

### Bundling

```bash
npm --prefix desktop run build:sidecars
cd desktop && npx tauri build --target <triple>       # omit --target for host-only
```

`src-tauri/tauri.conf.json` configures:

* `bundle.externalBin: ["binaries/ainovel-engine"]` — Tauri finds
  `binaries/ainovel-engine-<triple>[.exe]` and copies it next to the app
  executable (triple name kept), which is exactly what `paths.rs` resolves.
* `bundle.targets: ["app", "dmg", "msi", "nsis", "appimage", "deb"]` —
  macOS dmg, Windows msi + NSIS, Linux AppImage + deb.
* `bundle.createUpdaterArtifacts: true` — updater archives + minisign
  `.sig` files. **This requires `TAURI_SIGNING_PRIVATE_KEY` at bundle
  time.** For a local bundle without a key, disable it:

  ```bash
  npx tauri build --config '{"version": "0.1.0", "bundle": {"createUpdaterArtifacts": false}}'
  ```

Installers land in `src-tauri/target/<triple>/release/bundle/{dmg,macos,msi,nsis,appimage,deb}/`.

### Checksums

Every sidecar gets a `.sha256` at build time; CI re-verifies each checksum
(`shasum -a 256 -c`) **before** invoking `tauri build`. The release job
additionally publishes `desktop-release-checksums.txt` covering every
released artifact (installers, updater archives, signatures,
`latest.json`).

## Signing and notarization

All credentials come from repository secrets — nothing signing-related is
committed. When a secret is absent the build degrades gracefully and
produces unsigned (macOS: ad-hoc signed) installers.

| Variable | Purpose |
| --- | --- |
| `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` | macOS signing certificate (base64 p12) |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: ...` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | notarization credentials (or use `APPLE_API_KEY`/`APPLE_API_ISSUER`) |
| `WINDOWS_CERTIFICATE_THUMBPRINT` + `WINDOWS_CERTIFICATE_PASSWORD` | Authenticode signing of msi/NSIS |
| `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) | minisign key signing updater archives |

Without `TAURI_SIGNING_PRIVATE_KEY`, CI generates an **ephemeral throwaway
key** so bundling still succeeds and updater metadata is still produced —
those artifacts cannot be verified against any published key and are
placeholders only.

## Updater (placeholder for release one)

`createUpdaterArtifacts` makes `tauri build` emit per-platform updater
archives (`*.app.tar.gz`, `*.msi.zip`/`*.nsis.zip`, `*.AppImage`) plus
`.sig` files. `desktop/scripts/updater-manifest.mjs` assembles the
Tauri v2 `latest.json` (platform keys `darwin-aarch64`, `darwin-x86_64`,
`linux-x86_64`, `windows-x86_64`) from a directory of artifacts; the
release job attaches it next to the installers.

The **update endpoint is intentionally not configured**: the app does not
yet include the updater plugin, and no real update server exists. When one
does, host `latest.json` somewhere stable, embed the matching minisign
public key via `tauri-plugin-updater`, and point the app at the endpoint —
the manifest format produced here will not change.

## Release steps

1. Land on `main`; the [Desktop workflow](../.github/workflows/desktop.yml)
   runs all gates plus four packaging jobs on every pull request and push.
2. Tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. The workflow: builds all four sidecars → verifies checksums → bundles on
   macOS arm64/x64, Windows x64, Linux x64 → runs the startup smoke on
   host-native jobs → uploads per-target artifacts → attaches installers,
   updater artifacts, `latest.json`, and `desktop-release-checksums.txt`
   to the GitHub release (creating it only if the GoReleaser `Release`
   workflow hasn't already).
4. Download `desktop-release-checksums.txt` and verify:
   `shasum -a 256 -c --ignore-missing desktop-release-checksums.txt`.
5. Run the manual native smoke checklist (below) on each platform before
   announcing the release.

## Native smoke: automated vs manual

Two smoke gates run in CI on the host-native packaging runners (macOS arm64,
Windows x64, Linux x64 — see the `package` job); both are entirely LLM-free:

1. **Startup smoke** — boots the actual app binary with the sidecar placed
   next to it (the externalBin bundled layout), waits for `engine.ready`,
   round-trips `engine.ping`, and shuts down (`AINOVEL_DESKTOP_SMOKE_EXIT`).
2. **Protocol smoke** (`desktop/scripts/protocol-smoke.mjs`) — speaks
   desktop-v1 NDJSON directly on the sidecar's stdio and asserts, across two
   engine sessions:
   * create/open a project (`project.create` / `project.open` recovery),
   * save a chapter (`chapter.save`) and observe the `chapter.updated` event,
   * inspect (`chapter.list`, `chapter.read`, `project.snapshot`,
     `logs.replay`, `project.replay_events` with original sequences),
   * abort semantics on an idle project (`run.abort` → `stopped:false`),
   * export (`chapter.export` → file written, content asserted),
   * restart: fresh session id, sequence reset to 1, replay memory reset,
     chapter content persisted across the restart,
   * event sequences strictly monotonic, no `engine.error`, clean exit 0.

   The script seeds a minimal `meta/book.json` on disk (exporter input that
   real projects get from generation/import) — everything asserted still
   flows through the protocol. Run it locally any time:

   ```bash
   npm --prefix desktop run build:sidecars
   node desktop/scripts/protocol-smoke.mjs \
     --engine desktop/src-tauri/binaries/ainovel-engine-$(rustc -vV | sed -n 's/host: //p')
   ```

**Manual per-platform checklist (release)** — what cannot be automated
without a provider or GUI infrastructure. Note that `simulation.start` and
`import.start` are NOT LLM-free: both call the configured provider
(`internal/host/host.go` — `Simulate` binds `models.ForRole("architect")`;
import runs litellm analysis), so they belong here, with a real provider
configured — never in CI:

1. Install the app, launch it (engine becomes `ready`).
2. Create a new project; open an existing one; reopen on relaunch.
3. Start a controlled run (`run.start` with a small goal) — observe the
   stream and progress views updating live.
4. Steer mid-run (`run.steer`); abort (`run.abort`); restart the app and
   confirm the run is reported as recoverable (`project.resume`); resume.
5. Optional, provider-backed: `simulation.start` / `import.start` flows.
6. Export a chapter via the UI; confirm the file matches the project content.
7. Check `desktop_status` diagnostics: 0 malformed lines, bounded restarts.

## CI map (`.github/workflows/desktop.yml`)

| Job | What it gates |
| --- | --- |
| `engine` | gofmt, `go vet`, `go test ./...` |
| `protocol` | desktop-v1 schemas + fixtures via `validate.mjs` |
| `shell` | `cargo test` on Linux/Windows/macOS |
| `frontend` | typecheck + vitest + production build |
| `package` | sidecar cross-build + checksum verify + `tauri build` + startup/protocol smoke, per target |
| `release` | tag builds: checksums, `latest.json`, GitHub release attach |

Windows and Linux packaging/signing runs **only in CI** — there is no local
cross-bundling of the Rust shell (the Go sidecars do cross-build locally,
which is what the build matrix script verifies).
