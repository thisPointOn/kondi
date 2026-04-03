#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Build All Kondi Council Integrations
#
# Usage:
#   ./integrations/build-all.sh              # build all
#   ./integrations/build-all.sh --bump patch # bump version, then build all
#   ./integrations/build-all.sh --bump minor
#   ./integrations/build-all.sh --bump major
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION=$(node -e "console.log(require('$ROOT_DIR/package.json').version)")

C_RESET='\033[0m'
C_BOLD='\033[1m'
C_GREEN='\033[32m'
C_CYAN='\033[36m'
C_DIM='\033[2m'

log() { echo -e "${C_CYAN}${C_BOLD}[$1]${C_RESET} $2"; }
ok()  { echo -e "${C_GREEN}${C_BOLD}  ✓${C_RESET} $1"; }

# ── Version bump ──
if [[ "${1:-}" == "--bump" ]]; then
  BUMP_TYPE="${2:-patch}"
  cd "$ROOT_DIR"

  # Bump main package
  NEW_VERSION=$(node -e "
    const [maj,min,pat] = '$VERSION'.split('.').map(Number);
    if ('$BUMP_TYPE' === 'major') console.log((maj+1)+'.0.0');
    else if ('$BUMP_TYPE' === 'minor') console.log(maj+'.'+(min+1)+'.0');
    else console.log(maj+'.'+min+'.'+(pat+1));
  ")

  # Update main package.json
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$ROOT_DIR/package.json','utf8'));
    pkg.version = '$NEW_VERSION';
    fs.writeFileSync('$ROOT_DIR/package.json', JSON.stringify(pkg, null, 2) + '\n');
  "

  VERSION="$NEW_VERSION"
  log "Version" "Bumped to $VERSION"

  # Update all integration package.json files
  for pkg_file in "$SCRIPT_DIR"/*/package.json; do
    if [ -f "$pkg_file" ]; then
      node -e "
        const fs = require('fs');
        const pkg = JSON.parse(fs.readFileSync('$pkg_file','utf8'));
        pkg.version = '$VERSION';
        fs.writeFileSync('$pkg_file', JSON.stringify(pkg, null, 2) + '\n');
      "
      ok "$(basename $(dirname $pkg_file))/package.json → $VERSION"
    fi
  done
  echo ""
fi

log "Build" "Building all integrations v$VERSION"
echo ""

# ============================================================================
# 1. npm-package — Bundle CLI into standalone JS
# ============================================================================
log "npm-package" "Bundling CLI..."

cd "$ROOT_DIR"
npx esbuild cli/kondi.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --outfile="$SCRIPT_DIR/npm-package/dist/kondi.mjs" \
  --define:process.env.KONDI_VERSION=\""$VERSION"\" \
  --minify-syntax \
  2>/dev/null

# Strip any shebangs from bundle, add Node shebang
TMPFILE=$(mktemp)
echo '#!/usr/bin/env node' > "$TMPFILE"
# Remove shebang lines that leaked from source files
sed '/^#!\/usr\/bin\/env/d' "$SCRIPT_DIR/npm-package/dist/kondi.mjs" >> "$TMPFILE"
mv "$TMPFILE" "$SCRIPT_DIR/npm-package/dist/kondi.mjs"
chmod +x "$SCRIPT_DIR/npm-package/dist/kondi.mjs"

# Copy configs
cp -r "$ROOT_DIR/configs" "$SCRIPT_DIR/npm-package/dist/configs" 2>/dev/null || true

BUNDLE_SIZE=$(du -sh "$SCRIPT_DIR/npm-package/dist/kondi.mjs" | cut -f1)
ok "dist/kondi.mjs ($BUNDLE_SIZE)"

# ============================================================================
# 2. MCP Server
# ============================================================================
log "mcp-server" "Building..."

cd "$SCRIPT_DIR/mcp-server"
if [ -f "package.json" ]; then
  npm install --silent 2>/dev/null || true
  npx esbuild index.ts \
    --bundle \
    --platform=node \
    --format=esm \
    --outfile=dist/server.mjs \
    --packages=external \
    2>/dev/null
  ok "dist/server.mjs"
fi

# ============================================================================
# 3. n8n Node
# ============================================================================
log "n8n-node" "Building..."

cd "$SCRIPT_DIR/n8n-node"
if [ -f "package.json" ]; then
  npm install --silent 2>/dev/null || true
  npx esbuild nodes/KondiCouncil.node.ts \
    --bundle \
    --platform=node \
    --format=cjs \
    --outfile=dist/nodes/KondiCouncil.node.js \
    --packages=external \
    2>/dev/null
  ok "dist/nodes/KondiCouncil.node.js"
fi

# ============================================================================
# 4. LangGraph.js
# ============================================================================
log "langgraph-js" "Building..."

cd "$SCRIPT_DIR/langgraph-js"
if [ -f "package.json" ]; then
  npm install --silent 2>/dev/null || true
  npx esbuild index.ts \
    --bundle \
    --platform=node \
    --format=esm \
    --outfile=dist/index.mjs \
    --packages=external \
    2>/dev/null
  ok "dist/index.mjs"
fi

# ============================================================================
# 5. Claude Agent SDK
# ============================================================================
log "claude-agent-sdk" "Building..."

cd "$SCRIPT_DIR/claude-agent-sdk"
if [ -f "package.json" ]; then
  npm install --silent 2>/dev/null || true
  npx esbuild index.ts \
    --bundle \
    --platform=node \
    --format=esm \
    --outfile=dist/index.mjs \
    --packages=external \
    2>/dev/null
  ok "dist/index.mjs"
fi

# ============================================================================
# 6. OpenAI Agents SDK
# ============================================================================
log "openai-agents-sdk" "Building..."

cd "$SCRIPT_DIR/openai-agents-sdk"
if [ -f "package.json" ]; then
  npm install --silent 2>/dev/null || true
  npx esbuild index.ts \
    --bundle \
    --platform=node \
    --format=esm \
    --outfile=dist/index.mjs \
    --packages=external \
    2>/dev/null
  ok "dist/index.mjs"
fi

# ============================================================================
# 7. CrewAI Bridge (Python — just validate)
# ============================================================================
log "crewai-bridge" "Checking..."

cd "$SCRIPT_DIR/crewai-bridge"
if [ -f "kondi_council_crewai/__init__.py" ]; then
  python3 -c "import ast; ast.parse(open('kondi_council_crewai/__init__.py').read())" 2>/dev/null && \
    ok "Python syntax valid" || echo "  ⚠ Python syntax check failed"
fi

# ============================================================================
# 8. Mastra
# ============================================================================
log "mastra" "Building..."

cd "$SCRIPT_DIR/mastra"
if [ -f "package.json" ]; then
  npm install --silent 2>/dev/null || true
  npx esbuild index.ts \
    --bundle \
    --platform=node \
    --format=esm \
    --outfile=dist/index.mjs \
    --packages=external \
    2>/dev/null
  ok "dist/index.mjs"
fi

# ============================================================================
# Done
# ============================================================================
echo ""
log "Done" "All integrations built at v$VERSION"
echo ""
echo -e "${C_DIM}To publish all:${C_RESET}"
echo -e "  ${C_DIM}cd integrations/npm-package && npm publish${C_RESET}"
echo -e "  ${C_DIM}cd integrations/mcp-server && npm publish${C_RESET}"
echo -e "  ${C_DIM}cd integrations/n8n-node && npm publish${C_RESET}"
echo -e "  ${C_DIM}cd integrations/crewai-bridge && python -m build && twine upload dist/*${C_RESET}"
echo -e "  ${C_DIM}...etc${C_RESET}"
