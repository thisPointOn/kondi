#!/usr/bin/env bash
# Build the kondi-guard containment binary and place it where Tauri's
# externalBin expects it (binaries/kondi-guard-<target-triple>). Run before
# `tauri build` on each platform (CI does this per-runner).
set -euo pipefail
cd "$(dirname "$0")"
TRIPLE="${1:-$(rustc -vV | sed -n 's/host: //p')}"
cargo build --release --bin kondi-guard
mkdir -p binaries
EXT=""; case "$TRIPLE" in *windows*) EXT=".exe";; esac
cp "target/release/kondi-guard${EXT}" "binaries/kondi-guard-${TRIPLE}${EXT}"
echo "kondi-guard → binaries/kondi-guard-${TRIPLE}${EXT}"
