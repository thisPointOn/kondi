#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/../.."
DIST="$SCRIPT_DIR/dist"

rm -rf "$DIST"
mkdir -p "$DIST"

# Copy CLI
cp -r "$ROOT/cli" "$DIST/cli"

# Copy required source (council system, pipeline types, services)
mkdir -p "$DIST/src/council" "$DIST/src/pipeline" "$DIST/src/services"
cp -r "$ROOT/src/council/"*.ts "$DIST/src/council/"
cp "$ROOT/src/pipeline/types.ts" "$DIST/src/pipeline/"
cp "$ROOT/src/pipeline/executor.ts" "$DIST/src/pipeline/"
cp "$ROOT/src/pipeline/output-parsers.ts" "$DIST/src/pipeline/"
cp "$ROOT/src/services/deliberationSummary.ts" "$DIST/src/services/"

# Copy configs
cp -r "$ROOT/configs" "$DIST/configs"

# Copy package.json and README
cp "$SCRIPT_DIR/package.json" "$DIST/package.json"
cp "$ROOT/cli/README.md" "$DIST/README.md"

echo "Built to $DIST"
echo "To publish: cd $DIST && npm publish --access public"
