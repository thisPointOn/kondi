# Kondi

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Multi-agent deliberation and coding platform with MCP tool access.**

Kondi assembles councils of AI agents — each with distinct roles, personalities, and model assignments — and orchestrates structured workflows between them. Every agent can use any [MCP](https://modelcontextprotocol.io/) server you connect, councils can mix models from different providers in the same session, and all decisions flow through a deterministic state machine with a full audit trail.

Built on Tauri (Rust + React). Runs locally. Keys never leave your machine.

---

## Why Kondi

Most AI tools give you a single model behind a chat box. Kondi gives you a **boardroom**.

- **Multi-model councils** — Put Claude, GPT, Gemini, DeepSeek, and Grok in the same deliberation. Each persona uses whatever model fits its role. A security-focused consultant on Claude Opus, a cost-optimized worker on Haiku, a creative wildcard on GPT-5.2 — all in the same workflow.

- **Structured deliberation, not just chat** — Seven council modes (deliberation, debate, build, review, synthesis, socratic, freeform) with deterministic orchestration. The deliberation mode runs a full state machine: problem framing, independent analysis, interactive rounds, decision, directive, execution, and review. Every step is auditable.

- **Real tool access** — Agents don't just talk about doing things. Through MCP, they read files, query databases, post to Slack, commit to Git, search the web, and call any API you connect. Nine built-in platform servers ship with 120+ tools ready to use.

- **Pipelines** — Chain councils into multi-stage workflows with gates for human approval. Research council feeds into coding orchestrator feeds into review council. Artifacts flow between stages with provenance tracking.

- **Local-first** — No cloud dependency. Your API keys, OAuth tokens, and conversation history stay on your machine. CLI providers (Claude Code, Codex, Gemini CLI) route through your existing subscriptions.

---

## Features at a Glance

| Feature | What It Does |
|---------|-------------|
| [Multi-Provider LLM Support](#multi-provider-llm-support) | 8 providers, 30+ models, CLI and API paths |
| [Chat](#chat) | Multi-chat with file attachments, tool calling, per-chat working directories |
| [MCP Server Integration](#mcp-server-integration) | Connect any MCP server — remote, local, or from the built-in library |
| [Built-in Platform Servers](#built-in-platform-servers) | 9 servers with 120+ tools for social media, Git, and more |
| [Council System](#council-system) | Council modes (council, code_planning, coding, review, enrich, analysis, agent) with persona templates; generate a council from chat |
| [Structured Deliberation](#structured-deliberation) | Deterministic state machine with context versioning and audit trail |
| [Coding Orchestrator](#coding-orchestrator) | Spec decomposition, parallel implementation, code review, test, debug loop |
| [Pipelines](#pipelines) | Multi-stage workflows chaining councils, coding, LLM calls, and human gates |
| [CLI Pipeline Runner](#cli-pipeline-runner) | Run pipelines headlessly from the terminal |
| [Search Service](#search-service) | Bundled SearXNG web search and content extraction |
| [Built-in Tools](#built-in-tools) | File access and shell commands, always available |

---

## Multi-Provider LLM Support

Each persona in a council can use a different provider and model. Eight providers with two access paths:

| Provider | CLI (Subscription) | API (Key) |
|----------|-------------------|-----------|
| **Anthropic** | Opus 4.6, Sonnet 4.5, Haiku 4.5, Opus 4.5, Sonnet 4 | Sonnet 4.5, Haiku 4.5, Sonnet 4 |
| **OpenAI** | GPT-5.3 Codex, GPT-5.2 Codex, GPT-5.1 Codex Max/Mini | GPT-4o, GPT-4o Mini, GPT-4 Turbo, o1 Preview/Mini |
| **DeepSeek** | -- | R1 (reasoning), Chat |
| **Google** | Gemini CLI | Gemini 2.0 Flash, Gemini 1.5 Pro/Flash |
| **xAI** | -- | Grok-2, Grok-2 Mini |
| **Ollama** | -- | Any locally-running model (auto-discovered) |

CLI providers spawn the locally installed binary (`claude --print`, `codex exec`) as a subprocess and use your existing subscription — no API key needed. OAuth tokens from CLI tools only work through their own binaries (server-side client attestation), so the app proxies through them rather than calling the API directly. Multi-turn chat sessions use `--resume` (Claude) / `resume --last` (Codex) to maintain conversation state without resending history. The app auto-detects installed CLIs at startup and validates connectivity. Ollama models are discovered automatically when the Ollama server is running.

## Chat

- Streaming markdown responses with syntax-highlighted code blocks
- **MCP tool calling** — connected server tools execute inline with expandable result blocks
- **File attachments** — drag-and-drop support for 30+ file types
- **Shell-like input history** — Up/Down arrow to cycle through previous messages
- **Tool autocomplete** — type `@` to browse and insert available tools
- **Per-chat working directories** — each chat can target a different project folder
- **Context compression** — changing working directory mid-chat automatically compresses previous messages
- **Multi-chat** — up to 20 persistent conversations with recency sorting
- **Per-session model switching** — change provider/model without affecting your defaults

## MCP Server Integration

Connect agents to any MCP server through four paths:

- **Remote servers** via SSE/HTTP — enter a URL, Kondi probes for auth requirements automatically
- **Local servers** via stdio — launch npm packages, Python scripts, or any executable
- **Built-in server library** — browse and one-click install popular servers (GitHub, Slack, PostgreSQL, Notion, Linear, Brave Search, and more)
- **GitHub install** — paste a GitHub repo URL to auto-fetch, install, and connect

**Authentication proxy**: For OAuth-protected servers, Kondi spawns a local Node.js proxy per server that handles PKCE browser flows, dynamic client registration, token refresh, and retry logic. Proxy config stored at `~/.local/share/kondi/proxies/`.

**Credential management**: Built-in servers display token input fields directly in the Tools panel. Enter your API key or bot token, save, and connect — no env vars or config files needed.

**CLI tool sync**: Connected MCP servers are automatically proxied to localhost and synced to Claude Code (`~/.claude.json`) and Codex (`~/.codex/config.toml`) tool configurations. The unified router calls `ensureProxiesForServers()` before each LLM call to guarantee proxies are running and synced. CLI-based agents connect to the local proxy endpoints transparently.

## Built-in Platform Servers

Nine MCP servers ship with Kondi, providing 120+ tools across social platforms, messaging, and version control. Each server starts disconnected — add your API token in the Tools panel and connect.

### X / Twitter (13 tools)
Post tweets, search, get mentions, like/unlike, retweet, look up users, view followers and following.

### Discord (13 tools)
Send/edit/delete messages, list channels and guilds, manage reactions, create threads, pin messages, list members.

### Slack (16 tools)
Post/update/delete messages, search messages, list channels and users, manage reactions and pins, get thread replies.

### LinkedIn (10 tools)
Create/get/delete posts, view profile and connections, manage comments and likes, get organization info.

### Facebook (12 tools)
Post to pages, manage comments and reactions, view page/post insights, publish photos, get page info.

### Instagram (11 tools)
Publish photos, view/reply to comments, search hashtags, get account and post insights, manage stories.

### Reddit (14 tools)
Submit posts and comments, search, view subreddit info and rules, vote, get user profiles, save content.

### Telegram (15 tools)
Send messages/photos/documents, edit/delete/forward messages, send polls and locations, manage chat settings.

### Git (15 tools)
Full local git operations: status, log, diff, show, branch, checkout, add, commit, push, pull, stash, blame, remote, tag, merge.

## Council System

Councils are groups of AI personas that collaborate on a task. Each persona has a name, avatar, color, system prompt, LLM assignment, stance (advocate/critic/neutral/wildcard), domain expertise, interaction style, temperature, verbosity, and optional MCP server restrictions.

**15 built-in persona templates** across four categories:

| Category | Templates |
|----------|-----------|
| **Strategic** | Devil's Advocate, Optimist, Pragmatist, Visionary, Customer Voice |
| **Technical** | Security Hawk, Performance Nerd, Simplicity Advocate, Scale Thinker |
| **Creative** | Wild Card, Editor, Audience Advocate |
| **Domain Expert** | Finance Mind, Legal Eagle, Data Scientist |

**Seven council modes:**

| Mode | Pattern |
|------|---------|
| **Deliberation** | Structured Manager -> Consultants -> Worker workflow with phases |
| **Debate** | Personas argue opposing positions |
| **Build** | Collaborative — personas add to each other's ideas |
| **Review** | One presents, others critique |
| **Synthesis** | Each gives perspective, then combine |
| **Socratic** | One questions, others defend |
| **Freeform** | Natural conversation |

**Turn strategies**: round-robin, react, popcorn, volunteer, moderator, parallel, relevance.

## Structured Deliberation

The deliberation orchestrator is a deterministic state machine:

```
Problem Framing -> Independent Analysis -> Interactive Rounds -> Decision -> Directive -> Execution -> Review
      |                   |                      |                |           |           |          |
   Manager           Consultants            Consultants        Manager     Manager     Worker    Manager
```

**Phases:**

1. **Problem Framing** — Manager creates the shared context document (v1)
2. **Independent Analysis** — Round 1: each consultant analyzes independently
3. **Interactive Rounds** — Round 2+: consultants see and engage with each other's analysis
4. **Deciding** — Manager synthesizes all input into a final decision
5. **Directing** — Manager writes a concrete work directive for the worker
6. **Executing** — Worker carries out the directive (optionally with file write permissions)
7. **Reviewing** — Manager evaluates output, accepts or sends back for revision

**Context versioning**: Consultants propose patches to the shared context document. The Manager accepts or rejects each one, incrementing the version. All proposals are recorded. Enable **Evolve Context** to automatically append consultant findings and worker results to the context document as the deliberation progresses (v1 → v2 → v3...).

**Append-only ledger**: Every agent invocation, phase transition, and artifact change is recorded with timestamps, token counts, latency, and cost estimates.

**Configuration**: min/max rounds, max revisions, execution order (parallel/sequential), context token budget, decision criteria, expected output, soft word limits per response.

**Live controls**: Pause/resume, force decision (skip remaining rounds), abort, send a message while paused.

## Coding Orchestrator

A specialized orchestrator for software implementation:

```
Decompose Spec -> Implement Modules -> Code Review -> Test -> Debug Loop
      |                  |                 |          |         |
   Manager           Worker(s)          Reviewer   Build+Test  Worker
```

1. **Decompose** — Manager breaks the spec into modules with files, interfaces, dependencies, and per-worker directives
2. **Implement** — Workers implement their assigned modules with file write permissions
3. **Code Review** — Reviewer evaluates output with severity ratings (critical/major/minor)
4. **Test** — Runs install + build + test commands; captures stdout/stderr/exit codes
5. **Debug** — Worker fixes failures in a loop (configurable max cycles)

**Auto-detection**: If no commands are configured, the orchestrator scans the working directory for tooling:
- **Install**: pnpm -> yarn -> npm (lockfile priority), pip, go mod, Makefile
- **Build**: package.json scripts, tsconfig, Cargo.toml, go.mod, Makefile
- **Test**: vitest/jest/mocha, cargo test, go test, pytest, Makefile

**Safeguards**: Git snapshot before changes, dependency verification before build, build verification before tests.

## Pipelines

Chain councils, coding steps, LLM calls, and human checkpoints into automated workflows:

```
+--------------+     +--------------+     +---------+     +--------------+
|  Council:    |---->|   Coding:    |---->|  Gate:  |---->|  Council:    |
|  Research &  |     |  Implement   |     |  User   |     |  Review &    |
|  Plan        |     |  Solution    |     |  Approve|     |  Finalize    |
+--------------+     +--------------+     +---------+     +--------------+
```

**Step types:**
- **council / code_planning / coding / review / enrich** — full deliberation (or coding) councils
- **analysis / agent** — the same deliberation workflow as a smaller council (no skipped phases)
- **script** — run a shell command, capture stdout
- **condition** — evaluate an expression and `continue` / `skip_next_stage` / `stop` / **`loop_to_stage`** (rewind to an earlier stage and re-run, bounded by a max-loops budget — for iterative refine→review loops)
- **gate** — pause for human approval

Stages run sequentially; steps within a stage run in parallel. Artifacts flow between steps via template variables (`{{input}}`, `{{input.field}}`, `{{input[N]}}`, `{{file}}`). Each artifact includes provenance headers so downstream steps know where context came from. Output types: `string`, `json` (field-addressable downstream), `file`, `directory`.

**Pipeline builder**: Visual stage/step layout, drag-to-reorder, per-step persona/model/tool/directory configuration, output type annotations (string, file, directory).

## CLI Pipeline Runner

Run pipelines headlessly from the terminal:

```bash
npx tsx cli/run-pipeline.ts <pipeline.json> [--working-dir <path>] [--model <model>] [--dry-run]
```

- Uses the same orchestrators as the GUI
- Auto-routes to Claude CLI or Codex CLI based on model name
- Colored terminal output with timestamps
- JSON execution report on completion
- Session export (`.kondi-session.json`) for import back into the GUI
- Per-persona session persistence within council steps

## Built-in Tools

Always available without any MCP server:

| Tool | Description |
|------|------------|
| `read_file` | Read file contents (relative or absolute paths) |
| `write_file` | Create or overwrite a file |
| `list_directory` | List files and folders with metadata |
| `run_command` | Execute a shell command in the working directory |

All operations scoped to a configurable working directory. Enable **Directory Constrained** mode to confine agent **writes** to that directory (reads are still allowed for context). Containment is hard-enforced, not advisory: the working dir is `git init`-isolated so the Claude CLI can't adopt a parent repo as its project, and a `PreToolUse` hook denies any write resolving outside the dir (the Codex CLI uses its native `workspace-write` sandbox). Agents can read the codebase for grounding but cannot escape the working directory.

## Search Service

Bundled SearXNG-backed search MCP server with Docker lifecycle management:

- `web_search` — Search the web across categories (general, news, images, science, social media) with time range and language filters
- `web_fetch` — Fetch a URL and extract readable content via Mozilla Readability

Start/stop/restart from the Services panel. Requires Docker.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Runtime | Tauri 2.9 (Rust) |
| Frontend | React 19, TypeScript, Vite 7 |
| Backend | Rust (tokio, reqwest, serde) |
| MCP Proxy | Node.js, Express |
| Search Server | Node.js, SearXNG, Readability |
| Styling | Tailwind CSS, PostCSS |

---

## Installation

### Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| [Node.js](https://nodejs.org/) | 18+ | Frontend, proxy, CLI runner |
| [Rust](https://www.rust-lang.org/tools/install) | 1.77.2+ | Tauri backend |
| [Tauri CLI](https://v2.tauri.app/start/prerequisites/) | 2.x | `cargo install tauri-cli` |
| System deps | -- | See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) |

**Linux (Debian/Ubuntu):**
```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

**macOS:**
```bash
xcode-select --install
```

**Windows:**
Install [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

### Install a Release (recommended)

Download the installer for your platform from the
**[latest GitHub Release](https://github.com/thisPointOn/kondi/releases/latest)** — no build required:

| Platform | File | Install |
|----------|------|---------|
| **Windows** | `Kondi_*_x64-setup.exe` (or `_x64_en-US.msi`) | Double-click → install. |
| **macOS** (Apple silicon) | `Kondi_*_aarch64.dmg` | Open the `.dmg`, drag **Kondi** to Applications. |
| **Linux** (portable) | `Kondi_*_amd64.AppImage` | `chmod +x Kondi_*.AppImage && ./Kondi_*.AppImage` |
| **Linux** (Debian/Ubuntu) | `Kondi_*_amd64.deb` | `sudo apt install ./Kondi_*.deb` |
| **Linux** (Fedora/RHEL) | `Kondi-*-1.x86_64.rpm` | `sudo dnf install ./Kondi-*.rpm` |

> **Releases are currently unsigned** (code-signing certs not yet configured), so the OS
> warns on first launch. The app is safe — these steps dismiss the warning:
>
> - **Windows:** SmartScreen → **More info → Run anyway**.
> - **macOS:** a plain double-click may say *"Kondi is damaged and can't be opened"*
>   (Gatekeeper quarantine on unsigned apps). Either **right-click the app → Open → Open**,
>   or clear the quarantine flag once:
>   ```bash
>   xattr -dr com.apple.quarantine /Applications/Kondi.app
>   ```
> - **Linux:** none. The `.deb`/`.rpm` pull in their deps (`libwebkit2gtk-4.1-0`,
>   `libgtk-3-0`); for the `.AppImage` those libs must be present, plus FUSE
>   (`sudo apt install libfuse2`) — or run it with `--appimage-extract-and-run`.

**Notes:**
- macOS ships **Apple-silicon only** right now; an Intel (`x64`) `.dmg` isn't built yet.
- Signing/notarization (removes the warnings entirely) is documented in
  [`docs/RELEASING.md`](docs/RELEASING.md) — add the certs as repo secrets and it's automatic.

### Build from Source

```bash
git clone git@github.com:thisPointOn/kondi.git
cd kondi/mcp-connect-mvp

# Install frontend dependencies
npm install

# Build the MCP proxy (spawned when connecting to authenticated servers)
cd kondi-mcp-proxy && npm install && npm run build && cd ..

# Development mode (hot-reload)
npm run tauri:dev

# Production build
npm run tauri build
# Output: src-tauri/target/release/bundle/ (.deb, .rpm, .AppImage on Linux)
```

### (Optional) Built-in MCP Servers

The built-in platform servers (X, Discord, Slack, etc.) are bundled at `~/.local/share/kondi/mcp-servers/` on install. For development, they resolve from the repo root. Each server needs `npm install && npm run build` if building from source.

### (Optional) Search Service

```bash
cd kondi-search-mcp
docker-compose up -d   # Start SearXNG on port 8888
npm install && npm run build
```

Connect from the Services panel in the app.

---

## Quick Start

1. **Launch** — `npm run tauri:dev` from `mcp-connect-mvp/`
2. **Configure a provider** — Settings -> LLM Providers -> add an API key or sign in via CLI
3. **Chat** — Start a conversation. Connected MCP tools execute inline.
4. **Connect tools** — MCP Servers panel -> add servers or use built-ins
5. **Create a council** — Sidebar -> Councils -> New Council
6. **Add personas** — Pick from templates or create custom (minimum: 1 Manager + 1 Worker)
7. **Define the task** — Problem statement, decision criteria, expected output
8. **Run** — Launch the deliberation and watch the ledger fill in real-time
9. **Build a pipeline** — Chain councils into multi-stage workflows with human gates

---

## Configuration

### LLM Providers

| Provider | What You Need |
|----------|--------------|
| **Anthropic CLI** | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in |
| **Anthropic API** | API key from [console.anthropic.com](https://console.anthropic.com/) |
| **OpenAI CLI** | [Codex CLI](https://github.com/openai/codex) installed and logged in |
| **OpenAI API** | API key from [platform.openai.com](https://platform.openai.com/) |
| **DeepSeek** | API key from [platform.deepseek.com](https://platform.deepseek.com/) |
| **Google** | [Gemini CLI](https://ai.google.dev/gemini-api/docs/cli-tool) installed, or API key |
| **xAI** | API key from [console.x.ai](https://console.x.ai/) |
| **Ollama** | [Ollama](https://ollama.com/) running locally on port 11434 |

API keys are stored locally and only sent to the provider's own endpoint. CLI providers use the tool's existing authenticated session.

### Working Directory

Set globally in Settings or per-chat/per-council/per-pipeline. Enable **Directory Constrained** to prevent agents from accessing files outside the specified path. The working directory determines the root for `read_file`, `write_file`, `list_directory`, and `run_command`.

---

## Project Structure

```
kondi/
|-- mcp-connect-mvp/               # Main desktop application
|   |-- src/                        # React/TypeScript frontend
|   |   |-- council/                # Deliberation + coding orchestrators
|   |   |   |-- deliberation-orchestrator.ts
|   |   |   |-- coding-orchestrator.ts
|   |   |   |-- types.ts            # Council, persona, deliberation types
|   |   |   |-- prompts.ts          # Agent prompt generation
|   |   |   |-- ledger-store.ts     # Append-only audit trail
|   |   |   |-- context-store.ts    # Versioned artifacts
|   |   |   |-- store.ts            # Council CRUD (localStorage-backed)
|   |   |   +-- llm-adapter.ts      # Thin wrapper → llm-router
|   |   |-- pipeline/               # Pipeline types, executor, build/test detection
|   |   |-- services/               # LLM clients, MCP, OAuth, local tools
|   |   |   |-- llm-router.ts       # Unified LLM router (all completions dispatch here)
|   |   |   |-- claudeCliClient.ts  # anthropic-cli: spawns claude --print with sessions
|   |   |   +-- codexCliClient.ts   # openai-cli: spawns codex exec with sessions
|   |   |-- components/             # React UI (chat, council, pipeline, settings)
|   |   +-- config/models.ts        # All model definitions and pricing
|   |-- cli/                        # Headless CLI pipeline runner
|   |   |-- run-pipeline.ts         # Entry point
|   |   |-- claude-caller.ts        # Claude Code CLI adapter
|   |   +-- codex-caller.ts         # Codex CLI adapter
|   |-- src-tauri/                  # Rust backend
|   |   +-- src/commands.rs         # Process management, OAuth, proxy, file ops
|   +-- kondi-mcp-proxy/            # OAuth auth proxy (Node.js/Express)
|-- kondi-x-mcp/                    # X/Twitter MCP server (13 tools)
|-- kondi-discord-mcp/              # Discord MCP server (13 tools)
|-- kondi-slack-mcp/                # Slack MCP server (16 tools)
|-- kondi-linkedin-mcp/             # LinkedIn MCP server (10 tools)
|-- kondi-facebook-mcp/             # Facebook MCP server (12 tools)
|-- kondi-instagram-mcp/            # Instagram MCP server (11 tools)
|-- kondi-reddit-mcp/               # Reddit MCP server (14 tools)
|-- kondi-telegram-mcp/             # Telegram MCP server (15 tools)
|-- kondi-git-mcp/                  # Git MCP server (15 tools)
|-- kondi-search-mcp/               # SearXNG search MCP server
+-- docs/                           # Documentation
    |-- GUIDE.md                    # Comprehensive user guide
    +-- ARCHITECTURE.md             # Technical architecture
```

---

## Documentation

- **[User Guide](docs/GUIDE.md)** — Walkthrough of every feature, from chat to pipelines
- **[Architecture](docs/ARCHITECTURE.md)** — Technical design, data flow, and extension points

---

## License

Kondi is released under the **MIT License** in its entirety — backend, frontend,
bundled MCP servers, CLI, and integrations. See [LICENSE](LICENSE) and [LICENSING.md](LICENSING.md) for details.
