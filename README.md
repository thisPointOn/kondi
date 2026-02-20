# Kondi

**Multi-agent deliberation and coding platform with MCP tool access.**

Kondi assembles councils of AI agents with distinct roles — Manager, Consultants, Workers, Reviewers — and orchestrates structured workflows between them. Agents can use any [MCP](https://modelcontextprotocol.io/) server you connect, mix models from different providers in the same council, and produce auditable deliverables through a deterministic state machine.

Built on Tauri (Rust + React). Runs locally. Keys stay on your machine.

---

## Features

### Multi-Provider LLM Support

Each persona in a council can use a different provider and model. Kondi supports six providers with two access paths each:

| Provider | CLI (Subscription) | API (Key) |
|----------|-------------------|-----------|
| **Anthropic** | Claude Opus 4.6, Sonnet 4.5, Haiku 4.5, Opus 4.5, Sonnet 4 | Sonnet 4.5, Haiku 4.5, Sonnet 4 |
| **OpenAI** | GPT-5.2, GPT-5.2 Codex, GPT-5.1 Codex Max/Mini | GPT-4o, GPT-4o Mini, GPT-4 Turbo, o1 Preview/Mini |
| **DeepSeek** | — | DeepSeek R1 (reasoning), DeepSeek Chat |
| **Google** | Gemini CLI | Gemini 2.0 Flash, Gemini 1.5 Pro/Flash |

CLI providers route through locally installed tools (`claude`, `codex`, `gemini`) and use your existing subscription. API providers use direct API keys. The app auto-detects installed CLIs at startup and validates connectivity.

### Chat

- Streaming responses with markdown rendering and syntax-highlighted code blocks
- MCP tool calling — connected server tools appear in the sidebar and execute inline
- File attachments (drag-and-drop, 30+ file types detected)
- Conversation persistence (up to 20 chats) with rolling summaries for context efficiency
- Per-session model switching without changing defaults
- Tool autocomplete (type `/` to browse available tools)

### MCP Server Integration

Connect agents to any MCP server:

- **Remote servers** via SSE/HTTP — enter a URL, Kondi probes for auth requirements automatically
- **Local servers** via stdio — launch npm packages, Python scripts, etc.
- **Built-in server library** — browse and one-click install popular servers (GitHub, Slack, PostgreSQL, Notion, Linear, Brave Search, and more)
- **GitHub install** — paste a GitHub repo URL to auto-fetch, install, and connect an MCP server

**Authentication proxy** (`kondi-mcp-proxy`): For servers requiring auth, Kondi spawns a local Node.js proxy per server that handles OAuth (PKCE with browser-based flow and dynamic client registration), API keys, Bearer tokens, or custom headers. Tokens refresh automatically. Proxy config stored at `~/.local/share/kondi/proxies/`.

Connected MCP servers are automatically synced to Claude Code and Codex CLI tool configurations so CLI-based agents can call them directly.

### Council System

Councils are groups of AI personas that collaborate on a task. Seven council modes:

| Mode | Description |
|------|-------------|
| **deliberation** | Structured Manager → Consultants → Worker workflow (see below) |
| **debate** | Personas argue opposing positions |
| **build** | Collaborative — personas add to each other's ideas |
| **review** | One presents, others critique |
| **synthesis** | Each gives perspective, then combine |
| **socratic** | One questions, others defend |
| **freeform** | Natural conversation |

Turn strategies: round-robin, react, popcorn, volunteer, moderator, parallel, relevance.

### Personas

Each persona has:

- Name, avatar (emoji or URL), color
- LLM provider + model assignment
- System prompt, stance (advocate/critic/neutral/wildcard), domain expertise
- Interaction style (debate/build/question/synthesize/review)
- Temperature, verbosity, mute toggle
- Per-persona MCP server access list

**15 built-in templates** across four categories: Strategic (Devil's Advocate, Optimist, Pragmatist, Visionary, Customer Voice), Technical (Security Hawk, Performance Nerd, Simplicity Advocate, Scale Thinker), Creative (Wild Card, Editor, Audience Advocate), Domain Expert (Finance Mind, Legal Eagle, Data Scientist).

### Structured Deliberation

The deliberation orchestrator is a deterministic state machine with these phases:

```
Problem Framing → Independent Analysis → Interactive Rounds → Decision → Directive → Execution → Review
      │                   │                      │                │           │           │          │
   Manager           Consultants            Consultants        Manager     Manager     Worker    Manager
```

**Phases:**

1. **problem_framing** — Manager creates the shared context document (v1)
2. **round_independent** — Round 1: each consultant analyzes independently
3. **round_interactive** — Round 2+: consultants see and engage with each other
4. **deciding** — Manager synthesizes all input into a final decision
5. **directing** — Manager writes a concrete work directive
6. **executing** — Worker carries out the directive (optionally with file write permissions)
7. **reviewing** — Manager evaluates output, accepts or sends back for revision

**Context versioning**: Consultants propose patches to the shared context; the Manager accepts or rejects each one, incrementing the version. All proposals are recorded.

**Ledger**: Every agent invocation, phase transition, and artifact change is recorded in an append-only audit trail with timestamps, token counts, and latency.

**Configuration**: min/max rounds, max revisions, consultant execution order (parallel/sequential), context token budget, consultant error policy (retry/skip/fail), decision criteria, expected output description, soft word limits per response.

**User controls during deliberation**: pause/resume, force decision (skip remaining rounds), abort, send a message while paused.

### Coding Orchestrator

A specialized orchestrator for software implementation tasks:

```
Decompose Spec → Implement Modules → Code Review → Test → Debug Loop
      │                  │                 │          │         │
   Manager           Worker(s)          Reviewer   Build+Test  Worker
```

1. **decomposing** — Manager breaks the spec into modules with files, interfaces, dependencies, and per-worker directives
2. **implementing** — Workers implement their assigned modules (parallel where possible, with file write permissions)
3. **code_reviewing** — Reviewer evaluates all output with severity ratings (critical/major/minor)
4. **testing** — Runs install + build + test commands; captures stdout/stderr/exit code
5. **debugging** — Worker fixes test failures in a debug cycle loop (configurable max cycles)

**Auto-detection**: If no commands are configured, the orchestrator scans the working directory:
- **Install**: lockfile-first (pnpm → yarn → npm), pip, go mod, Makefile
- **Build**: package.json scripts, tsconfig, Cargo.toml, go.mod, Makefile
- **Test**: vitest/jest/mocha, cargo test, go test, pytest, Makefile

**Safeguards**: Git snapshot before any changes, dependency install before build/test verification, build verification before test runs.

### Pipelines

Chain multiple councils and execution steps into automated workflows:

```
┌─────────────┐     ┌─────────────┐     ┌──────────┐     ┌─────────────┐
│  Council:    │────→│   Coding:   │────→│  Gate:   │────→│  Council:   │
│  Research &  │     │  Implement  │     │  User    │     │  Review &   │
│  Plan        │     │  Solution   │     │  Approve │     │  Finalize   │
└─────────────┘     └─────────────┘     └──────────┘     └─────────────┘
```

**Step types:**
- **planning** — Full deliberation council for research and decision-making
- **coding** — Coding orchestrator for software implementation
- **decisioning** — Direct LLM call for single-model reasoning
- **execution** — Direct LLM call for action/writing steps
- **gate** — Pause for explicit human approval

Stages run sequentially; steps within a stage can run in parallel. Artifacts flow between steps via template variables (`{{input}}`). Each step's output includes provenance headers so downstream steps know where context came from.

**Pipeline builder UI**: Visual stage/step layout, drag-to-reorder, per-step persona/model/tool configuration, working directory scoping.

### CLI Pipeline Runner

Run pipelines headlessly from the terminal:

```bash
npx tsx cli/run-pipeline.ts <pipeline.json> [--working-dir <path>] [--model <model>] [--dry-run]
```

- Uses the same orchestrators as the GUI
- Routes to Claude CLI or Codex CLI based on model name
- Colored terminal output with timestamps
- Writes a JSON execution report on completion
- Export sessions (`.kondi-session.json`) for import back into the GUI

### Built-in Tools

Always available without any MCP server:
- `read_file` / `write_file` — local file access
- `list_directory` — directory listing
- `run_command` — shell command execution in the working directory

All operations scoped to a configurable working directory with optional directory constraint (prevents access outside the path).

### Search Service

Bundled SearXNG-backed search MCP server:
- Docker-managed `kondi-searxng` container
- `web_search` — search the web, return structured results
- `web_fetch` — fetch a URL, extract readable content via Mozilla Readability
- Start/stop/restart from the Services panel in the app

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
| Testing | Vitest |

---

## Installation

### Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| [Node.js](https://nodejs.org/) | 18+ | Frontend, proxy, CLI runner |
| [Rust](https://www.rust-lang.org/tools/install) | 1.77.2+ | Tauri backend |
| [Tauri CLI](https://v2.tauri.app/start/prerequisites/) | 2.x | `cargo install tauri-cli` |
| System deps | — | See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) |

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

### Pre-built Binary (Linux)

Download the `.AppImage` from the latest release and run it directly — no build required.

### Build from Source

```bash
git clone git@github.com:thisPointOn/kondi.git
cd kondi/mcp-connect-mvp

# Install frontend dependencies
npm install

# Build the MCP proxy (spawned automatically when connecting to authenticated servers)
cd kondi-mcp-proxy && npm install && npm run build && cd ..

# Development mode (hot-reload)
npm run tauri:dev

# Production build
npm run tauri build
# Output: src-tauri/target/release/bundle/ (.deb, .rpm, .AppImage on Linux)
```

### (Optional) Search Server

```bash
cd kondi-search-mcp
docker-compose up -d   # Start SearXNG on port 8888
npm install && npm run build
```

Connect to it from the app as a local MCP server.

---

## Configuration

### LLM Providers

On first launch, configure at least one provider:

| Provider | What You Need |
|----------|--------------|
| **Anthropic CLI** | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and logged in |
| **Anthropic API** | API key from [console.anthropic.com](https://console.anthropic.com/) |
| **OpenAI CLI** | [Codex CLI](https://github.com/openai/codex) installed and logged in |
| **OpenAI API** | API key from [platform.openai.com](https://platform.openai.com/) |
| **DeepSeek** | API key from [platform.deepseek.com](https://platform.deepseek.com/) |
| **Google** | [Gemini CLI](https://ai.google.dev/gemini-api/docs/cli-tool) installed, or API key |

API keys are stored locally and only sent to the provider's own endpoint. CLI providers use the tool's existing authenticated session.

### MCP Servers

Connect from the MCP Servers panel:
- **Custom URL** — enter any SSE/HTTP endpoint
- **Server Library** — browse and install from a curated list
- **GitHub URL** — paste a repo URL to auto-install
- **Local stdio** — configure a local command to spawn

OAuth-authenticated servers use a browser-based flow. Tokens stored at `~/.local/share/kondi/proxies/`.

### Working Directory

Set globally in Settings or per-council/per-pipeline. Enable **Directory Constrained** to prevent agents from accessing files outside the specified path.

---

## Quick Start

1. **Launch** — `npm run tauri:dev` from `mcp-connect-mvp/`
2. **Configure a provider** — Settings → LLM Providers
3. **Create a council** — Sidebar → New Council
4. **Add personas** — Pick from templates or create custom (minimum: 1 Manager + 1 Worker)
5. **Define the task** — Describe the problem, expected output, and decision criteria
6. **Start** — Launch the deliberation and watch the ledger fill in real-time

---

## Project Structure

```
kondi/
├── mcp-connect-mvp/                # Main desktop application
│   ├── src/                        # React/TypeScript frontend
│   │   ├── council/                # Deliberation + coding orchestrators
│   │   │   ├── deliberation-orchestrator.ts
│   │   │   ├── coding-orchestrator.ts
│   │   │   ├── types.ts
│   │   │   ├── prompts.ts
│   │   │   ├── ledger-store.ts     # Append-only audit trail
│   │   │   ├── context-store.ts    # Versioned artifacts
│   │   │   ├── store.ts            # Council CRUD
│   │   │   └── llm-adapter.ts      # Provider routing
│   │   ├── pipeline/               # Pipeline execution, build/test/install detection
│   │   ├── services/               # LLM clients, MCP, OAuth, conversation management
│   │   ├── components/             # React UI (chat, council, pipeline, settings)
│   │   └── config/models.ts        # All model definitions
│   ├── cli/                        # Headless CLI pipeline runner
│   │   ├── run-pipeline.ts         # Entry point
│   │   ├── claude-caller.ts        # Claude Code CLI adapter
│   │   └── codex-caller.ts         # Codex CLI adapter
│   ├── src-tauri/                  # Rust backend
│   │   └── src/commands.rs         # Process management, OAuth, proxy, file ops
│   ├── kondi-mcp-proxy/            # Auth proxy (Node.js)
│   └── server/                     # Express.js API server
├── kondi-search-mcp/               # SearXNG-backed search MCP server
├── flowforge/                      # Self-healing LLM workflow library
└── LICENSE
```

---

## License

MIT License. See [LICENSE](LICENSE).
