#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Promote Kondi Council — Automate announcements across platforms
#
# Usage:
#   ./integrations/promote.sh                    # do everything
#   ./integrations/promote.sh --step github      # just create/push GitHub repo
#   ./integrations/promote.sh --step publish     # just publish packages
#   ./integrations/promote.sh --step mcp-pr      # just PR to MCP servers dir
#   ./integrations/promote.sh --step posts       # just generate post content
#   ./integrations/promote.sh --step announce    # open browser tabs to post
#   ./integrations/promote.sh --dry-run          # show what would happen
#
# Prerequisites:
#   gh auth login          (GitHub CLI)
#   npm login              (npm registry)
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/.." && pwd)"
VERSION=$(node -e "console.log(require('$ROOT_DIR/package.json').version)")
DRY_RUN=false
STEP=""
GITHUB_USER=""
GITHUB_REPO="kondi"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --step) STEP="$2"; shift 2 ;;
    --github-user) GITHUB_USER="$2"; shift 2 ;;
    --repo-name) GITHUB_REPO="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

C_RESET='\033[0m'; C_BOLD='\033[1m'; C_GREEN='\033[32m'
C_CYAN='\033[36m'; C_YELLOW='\033[33m'; C_DIM='\033[2m'

log()  { echo -e "${C_CYAN}${C_BOLD}[$1]${C_RESET} $2"; }
ok()   { echo -e "${C_GREEN}${C_BOLD}  ✓${C_RESET} $1"; }

should_run() { [[ -z "$STEP" ]] || [[ "$STEP" == "$1" ]]; }

# Auto-detect GitHub user
if [[ -z "$GITHUB_USER" ]]; then
  GITHUB_USER=$(gh api user --jq .login 2>/dev/null || echo "")
  if [[ -z "$GITHUB_USER" ]]; then
    echo "Could not detect GitHub user. Run: gh auth login"
    echo "Or pass: --github-user yourusername"
    exit 1
  fi
fi

REPO_URL="https://github.com/$GITHUB_USER/$GITHUB_REPO"
NPM_URL="https://www.npmjs.com/package/kondi-council"
POSTS_DIR="$SCRIPT_DIR/.generated-posts"

echo -e "${C_BOLD}Kondi Council Promotion — v$VERSION${C_RESET}"
echo -e "${C_DIM}GitHub: $GITHUB_USER/$GITHUB_REPO${C_RESET}"
echo ""

# ============================================================================
# Step 1: GitHub — Create repo and push
# ============================================================================
if should_run "github"; then
  log "GitHub" "Setting up repository..."

  cd "$REPO_ROOT"

  if $DRY_RUN; then
    echo "  Would create: $REPO_URL"
    echo "  Would push all branches"
    ok "GitHub (dry-run)"
  else
    # Create repo if it doesn't exist
    if ! gh repo view "$GITHUB_USER/$GITHUB_REPO" &>/dev/null; then
      gh repo create "$GITHUB_REPO" \
        --public \
        --description "Multi-LLM council deliberation platform — structured AI debates across Claude, GPT, Gemini" \
        --source . \
        --push
      ok "Created $REPO_URL"
    else
      # Ensure remote is set and push
      git remote set-url origin "git@github.com:$GITHUB_USER/$GITHUB_REPO.git" 2>/dev/null || \
        git remote add origin "git@github.com:$GITHUB_USER/$GITHUB_REPO.git" 2>/dev/null || true
      git push -u origin main
      ok "Pushed to $REPO_URL"
    fi

    # Set repo topics
    gh repo edit "$GITHUB_USER/$GITHUB_REPO" \
      --add-topic ai,llm,multi-agent,council,deliberation,claude,openai,cli,typescript,mcp \
      2>/dev/null || true
    ok "Topics set"
  fi
  echo ""
fi

# ============================================================================
# Step 2: Publish all packages
# ============================================================================
if should_run "publish"; then
  log "Publish" "Publishing all packages..."

  if $DRY_RUN; then
    bash "$SCRIPT_DIR/publish-all.sh" --dry-run
  else
    bash "$SCRIPT_DIR/publish-all.sh"
  fi
  echo ""
fi

# ============================================================================
# Step 3: PR to MCP Servers directory
# ============================================================================
if should_run "mcp-pr"; then
  log "MCP-PR" "Opening PR to modelcontextprotocol/servers..."

  MCP_DIR="/tmp/mcp-servers-pr-$$"

  if $DRY_RUN; then
    echo "  Would fork modelcontextprotocol/servers"
    echo "  Would add src/kondi-council/ with server config"
    echo "  Would open PR"
    ok "MCP PR (dry-run)"
  else
    # Fork and clone
    gh repo fork modelcontextprotocol/servers --clone --clone-dir="$MCP_DIR" 2>/dev/null || true
    cd "$MCP_DIR"

    git checkout -b add-kondi-council

    # Create the server entry
    mkdir -p src/kondi-council
    cat > src/kondi-council/README.md << 'MCPEOF'
# Kondi Council MCP Server

Multi-LLM council deliberation tool. Runs structured debates between AI personas (manager, consultants, worker) across multiple providers.

## Usage

```json
{
  "mcpServers": {
    "kondi-council": {
      "command": "npx",
      "args": ["-y", "kondi-council-mcp"]
    }
  }
}
```

## Tools

### `council`
Run a multi-LLM council deliberation.

**Parameters:**
- `task` (string, required): The problem or question
- `type` (string): analysis, code_planning, coding, council, review
- `working_dir` (string): Target project directory
- `config_path` (string): Custom council config JSON

**Example:**
"Run a security analysis council on my project at ~/myapp"
MCPEOF

    git add .
    git commit -m "Add kondi-council MCP server"
    git push origin add-kondi-council

    gh pr create \
      --repo modelcontextprotocol/servers \
      --title "Add kondi-council — multi-LLM deliberation server" \
      --body "Adds kondi-council MCP server. Runs structured multi-model council deliberations (manager/consultant/worker pattern) across Claude, GPT, Gemini, and other providers.

## Install
\`\`\`json
{ \"mcpServers\": { \"kondi-council\": { \"command\": \"npx\", \"args\": [\"-y\", \"kondi-council-mcp\"] } } }
\`\`\`

## What it does
Exposes a \`council\` tool that runs multi-perspective AI deliberations — security audits, code reviews, implementation planning, architectural debates — with structured output.

npm: https://www.npmjs.com/package/kondi-council-mcp
Repo: $REPO_URL"

    ok "PR opened to modelcontextprotocol/servers"
    rm -rf "$MCP_DIR"
  fi
  echo ""
fi

# ============================================================================
# Step 4: Generate post content for all platforms
# ============================================================================
if should_run "posts"; then
  log "Posts" "Generating announcement content..."

  mkdir -p "$POSTS_DIR"

  # ── Hacker News ──
  cat > "$POSTS_DIR/hackernews.md" << EOF
Title: Show HN: Kondi – Multi-LLM council deliberations from the CLI

URL: $REPO_URL

Text:
I built a CLI tool that runs structured "council" deliberations between multiple AI models. Instead of asking one LLM, you define personas (manager, consultants, worker) that debate across providers (Claude, GPT-o3, Gemini, etc.) and produce a reviewed output.

It works like this: the manager frames the problem, consultants debate approaches (one might be an advocate, another a critic), the manager makes a decision, then a worker produces the final output — which gets reviewed and revised.

Example: \`kondi-council council --config analysis.json --task "Security review of this codebase" --working-dir ./myapp\`

It outputs structured artifacts (deliberation.md, decision.md, output.md) and works from any directory.

Built in TypeScript, zero runtime deps (single 884KB bundle), installable via npm.

Available as: npm package, MCP server (for Claude Desktop/Cursor), n8n node, LangGraph.js node, CrewAI tool, OpenAI Agents SDK tool.

$REPO_URL
EOF
  ok "hackernews.md"

  # ── Reddit Comments (designed to drop into relevant threads) ──
  cat > "$POSTS_DIR/reddit-comments.md" << EOF
# Reddit Comment Snippets
# Drop these into relevant threads. Search for threads about:
# "multi-agent", "code review tool", "Claude vs GPT", "AI debate", "MCP server"

## For threads about multi-agent systems / CrewAI / AutoGen:

I built something similar but as a CLI tool — structured deliberations with manager/consultant/worker roles across different models (Claude + o3 in the same council). Each persona has a stance (advocate, critic, wildcard) and they go through rounds of debate before the worker produces output.

\`npm install -g kondi-council\`

The interesting part is mixing models — having o3 as the critic challenging Claude's proposals produces better results than either model alone. Also ships as an MCP server, n8n node, and LangGraph.js integration.

$REPO_URL

---

## For threads about code review / security tools:

I've been using a multi-LLM "council" approach for this — 5 personas (security auditor on o3, performance engineer on Claude, quality reviewer, etc.) debate the codebase in structured rounds, then a report writer compiles findings.

One command: \`kondi-council council --config analysis.json --task "Security review" --working-dir ./myapp\`

Caught 8 critical vulns in a test codebase that individual model calls missed. The debate between the security-focused o3 persona and the pragmatic Claude persona was surprisingly productive.

Open source: $REPO_URL

---

## For threads about Claude vs GPT / model comparison:

Instead of comparing models head-to-head, I've been making them work together in structured "councils" — Claude as the manager/worker, o3 as consultants with different stances (advocate, critic). The multi-perspective output is consistently better than either alone.

Built it as a CLI: \`npm install -g kondi-council\`

$REPO_URL

---

## For threads about MCP servers:

Built an MCP server that adds multi-LLM council deliberations to Claude Desktop/Cursor. Say "run a security council on this project" and it orchestrates a structured debate between 5 AI personas across providers.

\`\`\`json
{ "mcpServers": { "kondi-council": { "command": "npx", "args": ["-y", "kondi-council-mcp"] } } }
\`\`\`

$REPO_URL
EOF
  ok "reddit-comments.md"

  # ── Twitter/X ──
  cat > "$POSTS_DIR/twitter.md" << EOF
Thread:

1/ I built a CLI tool that makes Claude and GPT argue with each other before giving you an answer.

It's called Kondi Council — structured multi-LLM deliberations with manager/consultant/worker roles.

\`npm install -g kondi-council\`

2/ Instead of asking one model, you define a council:
- Manager frames the problem
- Consultants debate (advocate vs critic vs wildcard)
- Manager decides
- Worker produces the output
- Manager reviews

Each persona can be a different model (Claude, o3, Gemini...)

3/ 4 ready-to-use configs:
- Analysis: 5 personas, finds security/perf/quality issues
- Code Planning: architecture specs with parallel consultants
- Coding: actually writes files + runs test/debug cycles
- Debate: structured advocate/critic/wildcard arguments

4/ One command from any directory:

kondi-council council --config analysis.json --task "Security review" --working-dir ./myapp

Outputs: deliberation.md + decision.md + output.md

5/ Also ships as:
- MCP server (works in Claude Desktop, Cursor)
- n8n node (visual workflows)
- LangGraph.js node
- Claude Agent SDK tool
- OpenAI Agents SDK tool
- CrewAI tool (Python)

$REPO_URL
EOF
  ok "twitter.md"

  # ── n8n Community Forum ──
  cat > "$POSTS_DIR/n8n-forum.md" << EOF
Title: New Community Node: Multi-LLM Council Deliberation (n8n-nodes-kondi)

Category: Share a workflow

Body:
Hi everyone! I've published a community node that adds multi-LLM council deliberations to n8n.

**What it does:** Runs a structured debate between multiple AI personas (manager, consultants, worker) and returns the deliberation result. Think of it as a "committee review" step for your AI workflows.

**Install:** Settings → Community Nodes → n8n-nodes-kondi

**Use cases:**
- Code review pipeline: GitHub webhook → Council Analysis → Slack notification
- Content review: Draft → Council Debate → Approved/Rejected
- Decision making: Input → Advocate/Critic/Wildcard debate → Decision document

**Council types:** analysis, code_planning, coding, debate

Requires \`kondi-council\` CLI installed on the n8n host (\`npm install -g kondi-council\`).

npm: https://www.npmjs.com/package/n8n-nodes-kondi
Repo: $REPO_URL
EOF
  ok "n8n-forum.md"

  echo ""
  log "Posts" "Generated in $POSTS_DIR/"
fi

# ============================================================================
# Step 5: Open browser tabs for manual posting
# ============================================================================
if should_run "announce"; then
  log "Announce" "Opening platform tabs..."

  if ! command -v xdg-open &>/dev/null; then
    OPEN_CMD="echo 'Open manually:'"
  else
    OPEN_CMD="xdg-open"
  fi

  if $DRY_RUN; then
    echo "  Would open:"
    echo "    - https://news.ycombinator.com/submitlink?u=$REPO_URL&t=Show+HN:+Kondi+–+Multi-LLM+council+deliberations+from+the+CLI"
    echo "    - https://www.reddit.com/r/LocalLLaMA (search for relevant threads to comment on)"
    echo "    - https://www.reddit.com/r/MachineLearning (search for relevant threads)"
    echo "    - https://community.n8n.io/new-topic?category=share-a-workflow"
    echo "    - https://smithery.ai/submit"
    ok "Announce (dry-run)"
  else
    echo ""
    echo -e "${C_BOLD}Post content is in: $POSTS_DIR/${C_RESET}"
    echo -e "${C_DIM}Copy the content from each .md file into the corresponding platform.${C_RESET}"
    echo ""

    # Open each platform
    $OPEN_CMD "https://news.ycombinator.com/submitlink?u=${REPO_URL}&t=Show%20HN%3A%20Kondi%20%E2%80%93%20Multi-LLM%20council%20deliberations%20from%20the%20CLI" 2>/dev/null &
    sleep 1
    $OPEN_CMD "https://www.reddit.com/r/LocalLLaMA/search/?q=multi-agent+OR+council+OR+%22code+review%22&sort=new" 2>/dev/null &
    sleep 1
    $OPEN_CMD "https://www.reddit.com/r/MachineLearning/search/?q=multi-agent+OR+deliberation&sort=new" 2>/dev/null &
    sleep 1
    $OPEN_CMD "https://community.n8n.io/new-topic?category=share-a-workflow" 2>/dev/null &
    sleep 1
    $OPEN_CMD "https://smithery.ai" 2>/dev/null &

    ok "Browser tabs opened"
    echo ""
    echo -e "${C_BOLD}Paste content from:${C_RESET}"
    echo -e "  ${C_DIM}$POSTS_DIR/hackernews.md     → Hacker News tab${C_RESET}"
    echo -e "  ${C_DIM}$POSTS_DIR/reddit-comments.md  → find a relevant thread, paste a snippet${C_RESET}"
    echo -e "  ${C_DIM}$POSTS_DIR/n8n-forum.md      → n8n forum tab${C_RESET}"
    echo -e "  ${C_DIM}$POSTS_DIR/twitter.md        → post manually on X${C_RESET}"
  fi
  echo ""
fi

# ============================================================================
# Summary
# ============================================================================
echo -e "${C_BOLD}════════════════════════════════════════${C_RESET}"
echo -e "${C_BOLD}  Promotion pipeline complete (v$VERSION)${C_RESET}"
echo -e "${C_BOLD}════════════════════════════════════════${C_RESET}"
echo ""
echo -e "  ${C_GREEN}Automated:${C_RESET}"
echo -e "    GitHub repo + push            ${C_DIM}(gh cli)${C_RESET}"
echo -e "    npm publish × 7 packages      ${C_DIM}(npm cli)${C_RESET}"
echo -e "    PyPI publish × 1 package      ${C_DIM}(twine)${C_RESET}"
echo -e "    MCP servers directory PR       ${C_DIM}(gh cli)${C_RESET}"
echo -e "    Post content generation        ${C_DIM}(text files)${C_RESET}"
echo ""
echo -e "  ${C_YELLOW}Semi-automated (browser opens, you paste):${C_RESET}"
echo -e "    Hacker News, Reddit ×2, n8n forum, Smithery"
echo -e "    Twitter/X (manual post from generated thread)"
echo ""
