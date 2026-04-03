#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Build and Publish All Kondi Council Integrations
#
# Usage:
#   ./integrations/publish-all.sh                    # build + publish all
#   ./integrations/publish-all.sh --bump patch       # bump version first
#   ./integrations/publish-all.sh --dry-run          # build only, don't publish
#   ./integrations/publish-all.sh --only npm-package # publish one specific
#
# Prerequisites:
#   npm login                      (for npm packages)
#   pip install build twine        (for PyPI package)
#   twine configured or TWINE_PASSWORD set
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DRY_RUN=false
ONLY=""
BUMP=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --bump) BUMP="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

C_RESET='\033[0m'
C_BOLD='\033[1m'
C_GREEN='\033[32m'
C_CYAN='\033[36m'
C_YELLOW='\033[33m'
C_RED='\033[31m'
C_DIM='\033[2m'

log()  { echo -e "${C_CYAN}${C_BOLD}[$1]${C_RESET} $2"; }
ok()   { echo -e "${C_GREEN}${C_BOLD}  ✓${C_RESET} $1"; }
skip() { echo -e "${C_YELLOW}${C_BOLD}  ⊘${C_RESET} $1 ${C_DIM}(skipped)${C_RESET}"; }
fail() { echo -e "${C_RED}${C_BOLD}  ✗${C_RESET} $1"; }

should_run() {
  [[ -z "$ONLY" ]] || [[ "$ONLY" == "$1" ]]
}

# ── Step 1: Build all ──
if [[ -n "$BUMP" ]]; then
  bash "$SCRIPT_DIR/build-all.sh" --bump "$BUMP"
else
  bash "$SCRIPT_DIR/build-all.sh"
fi

VERSION=$(node -e "console.log(require('$ROOT_DIR/package.json').version)")
echo ""
log "Publish" "Publishing all integrations v$VERSION"
if $DRY_RUN; then
  echo -e "${C_YELLOW}  (dry-run mode — no actual publishing)${C_RESET}"
fi
echo ""

PUBLISHED=0
FAILED=0

# ── npm packages ──
publish_npm() {
  local name="$1"
  local dir="$2"

  if ! should_run "$name"; then
    skip "$name"
    return
  fi

  log "$name" "Publishing to npm..."
  cd "$SCRIPT_DIR/$dir"

  if ! [ -f "package.json" ]; then
    fail "$name — no package.json"
    ((FAILED++)) || true
    return
  fi

  if $DRY_RUN; then
    npm publish --access public --dry-run 2>&1 | tail -5
    ok "$name (dry-run)"
  else
    if npm publish --access public 2>&1; then
      ok "$name → npm"
      ((PUBLISHED++)) || true
    else
      fail "$name — npm publish failed"
      ((FAILED++)) || true
    fi
  fi
}

publish_npm "npm-package"       "npm-package"
publish_npm "mcp-server"        "mcp-server"
publish_npm "n8n-node"          "n8n-node"
publish_npm "langgraph-js"      "langgraph-js"
publish_npm "claude-agent-sdk"  "claude-agent-sdk"
publish_npm "openai-agents-sdk" "openai-agents-sdk"
publish_npm "mastra"            "mastra"

# ── PyPI package ──
if should_run "crewai-bridge"; then
  log "crewai-bridge" "Publishing to PyPI..."
  cd "$SCRIPT_DIR/crewai-bridge"

  if ! [ -f "pyproject.toml" ]; then
    fail "crewai-bridge — no pyproject.toml"
    ((FAILED++)) || true
  elif ! command -v python3 &>/dev/null; then
    fail "crewai-bridge — python3 not found"
    ((FAILED++)) || true
  else
    rm -rf dist/ build/
    if $DRY_RUN; then
      python3 -m build 2>&1 | tail -3
      ok "crewai-bridge (dry-run, built but not uploaded)"
    else
      python3 -m build 2>&1 | tail -3
      if twine upload dist/* 2>&1; then
        ok "crewai-bridge → PyPI"
        ((PUBLISHED++)) || true
      else
        fail "crewai-bridge — twine upload failed"
        ((FAILED++)) || true
      fi
    fi
  fi
else
  skip "crewai-bridge"
fi

# ── Summary ──
echo ""
echo -e "${C_BOLD}════════════════════════════════════${C_RESET}"
if $DRY_RUN; then
  echo -e "${C_BOLD}  Dry run complete (v$VERSION)${C_RESET}"
else
  echo -e "${C_BOLD}  Published: $PUBLISHED  Failed: $FAILED  (v$VERSION)${C_RESET}"
fi
echo -e "${C_BOLD}════════════════════════════════════${C_RESET}"
