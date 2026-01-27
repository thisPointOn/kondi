#!/usr/bin/env bash
# Dev helper to launch mock MCP server and Tauri dev in one go.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "Starting mock MCP server (http://localhost:3000)..."
node test-mcp-server.js &
SERVER_PID=$!

cleanup() {
  echo "Shutting down mock server (pid $SERVER_PID)..."
  kill "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Launching Tauri dev (Ctrl+C to exit)..."
npm run tauri dev
