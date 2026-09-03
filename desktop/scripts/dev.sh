#!/bin/sh
# Short dev entry: resolves the host sidecar and runs `tauri dev`.
#
# Usage:
#   npm --prefix desktop run dev [-- <tauri args>]
#   sh desktop/scripts/dev.sh [-- <tauri args>]
#
# Respects a pre-set AINOVEL_SIDECAR; otherwise defaults to
# src-tauri/binaries/ainovel-engine-<host-triple> (built on demand).
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
desk="$root/desktop"

if [ -z "${AINOVEL_SIDECAR:-}" ]; then
    triple=$(rustc -vV | sed -n 's/^host: //p')
    AINOVEL_SIDECAR="$desk/src-tauri/binaries/ainovel-engine-$triple"
    export AINOVEL_SIDECAR
    if [ ! -x "$AINOVEL_SIDECAR" ]; then
        echo "dev: sidecar missing, building $triple..." >&2
        sh "$desk/scripts/build-sidecars.sh" "$triple"
    fi
fi

cd "$desk"
exec npm run tauri -- dev "$@"
