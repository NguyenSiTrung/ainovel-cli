#!/bin/sh
# Build the Go engine sidecar(s) for Tauri externalBin packaging.
#
# Output: desktop/src-tauri/binaries/ainovel-engine-<triple>[.exe]
#         plus a .sha256 checksum next to each binary (verifiable with
#         `shasum -a 256 -c` / `sha256sum -c` from that directory).
#
# The file names MUST match what the shell resolves at runtime
# (desktop/src-tauri/src/paths.rs):
#   1. AINOVEL_SIDECAR env override (dev only)
#   2. ainovel-engine-<target-triple>[.exe] next to the app executable
#      (the Tauri externalBin bundled name)
#   3. ainovel-engine[.exe] next to the app executable
#
# Usage:
#   scripts/build-sidecars.sh                  # all release-one targets
#   scripts/build-sidecars.sh aarch64-apple-darwin [more triples]
#
# Version metadata (same ldflags as .goreleaser.yml, so the desktop sidecar
# and the standalone CLI carry identical version provenance):
#   DESKTOP_VERSION  default: git describe --tags --always (e.g. 0.1.0 / v0.2.1-3-gabc)
#   DESKTOP_COMMIT   default: git rev-parse --short HEAD, else "unknown"
#   DESKTOP_DATE     default: git commit date (YYYY-MM-DD), else today
#
# Plain `go build ./cmd/ainovel-cli` stays fully supported; this script only
# adds cross-compilation + metadata injection on top.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
out_dir="$root/desktop/src-tauri/binaries"
main_pkg="./cmd/ainovel-cli"

GO_BIN="${GO_BIN:-go}"
if ! command -v "$GO_BIN" >/dev/null 2>&1; then
    if [ -x "$HOME/.local/go/bin/go" ]; then
        GO_BIN="$HOME/.local/go/bin/go"
    elif [ -x "/usr/local/go/bin/go" ]; then
        GO_BIN="/usr/local/go/bin/go"
    fi
fi
# ── version metadata defaults ────────────────────────────────────────────────
if [ -z "${DESKTOP_VERSION:-}" ]; then
    DESKTOP_VERSION=$(git -C "$root" describe --tags --always 2>/dev/null || echo dev)
fi
if [ -z "${DESKTOP_COMMIT:-}" ]; then
    DESKTOP_COMMIT=$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)
fi
if [ -z "${DESKTOP_DATE:-}" ]; then
    DESKTOP_DATE=$(git -C "$root" log -1 --date=short --format=%cd 2>/dev/null || date +%Y-%m-%d)
fi

# ── target matrix (GOOS/GOARCH per Rust-style triple) ───────────────────────
target_go() {
    case "$1" in
        aarch64-apple-darwin)       echo "darwin arm64" ;;
        x86_64-apple-darwin)        echo "darwin amd64" ;;
        x86_64-pc-windows-msvc)     echo "windows amd64" ;;
        x86_64-unknown-linux-gnu)   echo "linux amd64" ;;
        *) echo "unsupported target triple: $1 (see scripts/build-sidecars.sh)" >&2; return 1 ;;
    esac
}

all_targets="aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc x86_64-unknown-linux-gnu"
targets=${*:-$all_targets}

mkdir -p "$out_dir"

failures=0
for triple in $targets; do
    pair=$(target_go "$triple") || { failures=$((failures + 1)); continue; }
    goos=${pair% *}
    goarch=${pair#* }
    exe=""
    case "$goos" in windows) exe=".exe" ;;
    esac
    name="ainovel-engine-$triple$exe"

    echo "==> building $name (GOOS=$goos GOARCH=$goarch, version=$DESKTOP_VERSION commit=$DESKTOP_COMMIT date=$DESKTOP_DATE)"
    (cd "$root" &&
        GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 "$GO_BIN" build \
            -trimpath \
            -ldflags "-s -w -X main.version=$DESKTOP_VERSION -X main.commit=$DESKTOP_COMMIT -X main.date=$DESKTOP_DATE" \
            -o "$out_dir/$name" "$main_pkg")

    # Checksum in `shasum -c` / `sha256sum -c` compatible format.
    if command -v shasum >/dev/null 2>&1; then
        (cd "$out_dir" && shasum -a 256 "$name" > "$name.sha256")
    else
        (cd "$out_dir" && sha256sum "$name" > "$name.sha256")
    fi
    cat "$out_dir/$name.sha256"
done

if [ "$failures" -gt 0 ]; then
    echo "build-sidecars: $failures target(s) failed" >&2
    exit 1
fi
