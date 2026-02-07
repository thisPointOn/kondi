# Kondi

**Multi-agent deliberation platform for AI-powered decision making.**

Kondi connects multiple AI agents to your tools via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) and orchestrates structured deliberation between them. Instead of relying on a single AI to solve a problem, Kondi assembles a council of agents with distinct roles — Manager, Consultants, and Worker — that collaborate through a deterministic workflow to produce higher-quality decisions and deliverables.

---

## Why Kondi?

Most AI tools give you one model, one perspective, one shot. Kondi takes a different approach:

- **Structured multi-agent deliberation** — A Manager frames the problem, multiple Consultants analyze it from different angles (security, UX, architecture, etc.), debate each other's positions, and a Worker executes the final decision. Every step is audited in an append-only ledger.

- **Provider-agnostic** — Mix and match models in the same council. Put Claude Opus as Manager, GPT-4o as one Consultant, DeepSeek as another. Each agent uses whichever model fits its role best. Supports Anthropic, OpenAI, and DeepSeek via both API keys and CLI subscriptions (Claude Code, Codex).

- **MCP-native tool access** — Agents can use any MCP server you connect: code search, databases, APIs, file systems. The built-in proxy handles OAuth, token refresh, and authentication so your agents can reach authenticated services without exposing credentials.

- **Deterministic workflow, not random chat** — Deliberation follows a well-defined state machine with phases, rounds, convergence criteria, and artifact versioning. The Manager can't skip to a decision before minimum rounds are met. Context proposals from Consultants are formally reviewed and accepted or rejected. Everything is traceable.

- **Desktop-native** — Built on Tauri (Rust + React). No cloud infrastructure needed. Your API keys and tokens stay on your machine.

---

## How the Council Works

A deliberation session follows this workflow:

```
Problem Framing ──→ Independent Analysis ──→ Interactive Rounds ──→ Decision
       │                    │                        │                  │
    Manager            Consultants              Consultants          Manager
  frames problem     analyze solo,            debate, refine,      synthesizes
  into structured    each from their          build on each        all input into
  context doc        focus area               other's ideas        final decision
                                                                       │
                                                                       ▼
                                              Execution ◄── Directive ◄─┘
                                                  │
                                               Worker
                                            produces the
                                             deliverable
                                                  │
                                                  ▼
                                     Review ──→ Revise? ──→ Complete
                                       │
                                    Manager
                                  evaluates against
                                  acceptance criteria
```

### Roles

| Role | Responsibility | Count |
|------|---------------|-------|
| **Manager** | Frames problem, evaluates rounds, decides when consultants have converged, reviews final output | 1 |
| **Consultant** | Analyzes from a specialized focus area, proposes context changes, debates other consultants | 1+ |
| **Worker** | Executes the Manager's directive, produces the deliverable, revises on feedback | 1 |

### Key Mechanics

- **Rounds** — Configurable min and max rounds. Round 1 is independent (consultants don't see each other). Round 2+ is interactive — in sequential mode, each consultant sees what prior consultants said in the same round.
- **Context Versioning** — The shared context document is versioned. Consultants can propose patches (additions, corrections). The Manager accepts or rejects each patch, incrementing the version.
- **Ledger** — Every agent invocation, phase transition, and artifact change is recorded in an append-only audit trail with timestamps, token counts, and latency.
- **Convergence** — The Manager evaluates after each round: continue deliberating, redirect the conversation, or proceed to a decision. The system enforces minimum rounds before allowing early decisions.

---

## Components

### `mcp-connect-mvp/` — Main Application

The core desktop app. Tauri (Rust backend) + React/TypeScript frontend.

**Features:**
- Multi-turn chat with any supported LLM provider
- Council creation and management with persona configuration
- Deliberation orchestration (the full workflow above)
- Pipeline builder for chaining councils and execution steps
- MCP server connection management with OAuth support
- File attachments, tool calling, response streaming
- Cost estimation and token tracking

### `mcp-connect-mvp/kondi-mcp-proxy/` — MCP Proxy

Node.js proxy that bridges authenticated MCP servers to unauthenticated local clients.

**How it works:**
1. You connect to a remote MCP server that requires OAuth or API keys
2. Kondi spawns a local proxy process that handles the authentication
3. The proxy injects auth headers into every request and streams responses back
4. The frontend connects to the local proxy endpoint — no tokens exposed to the browser

**Supports:** OAuth 2.0 (with browser-based flow), API keys, Bearer tokens, custom headers. Automatic token refresh with configurable retry logic.

### `kondi-search-mcp/` — Search MCP Server

An MCP server that provides web search and content extraction tools to agents.

- Backed by a local [SearXNG](https://docs.searxng.org/) instance
- **web_search** tool — search the web, return structured results
- **web_fetch** tool — fetch a URL, extract readable content (Mozilla Readability), convert to Markdown

### `flowforge/` — Workflow Orchestration Library

Self-healing LLM workflow engine with broad provider support.

- Define multi-step workflows with LLM-powered planning
- Steps are evaluated and automatically retried on failure with corrections
- Provider adapters for Anthropic, OpenAI, Gemini, Ollama, Bedrock, Copilot, Groq, and more
- Checkpoint/resume support for long-running workflows
- Express API for workflow CRUD and execution control

---

## Pipelines

Pipelines let you chain multiple councils and execution steps into automated workflows.

```
┌─────────────┐     ┌─────────────┐     ┌──────────┐     ┌─────────────┐
│  Council:    │────→│  Execution: │────→│  Gate:   │────→│  Council:   │
│  Research &  │     │  Generate   │     │  User    │     │  Review &   │
│  Decide     │     │  Code       │     │  Approve │     │  Finalize   │
└─────────────┘     └─────────────┘     └──────────┘     └─────────────┘
```

**Step types:**
- **Council** — Runs a full deliberation with configurable personas, rounds, and execution
- **Execution** — Direct LLM call with a system prompt and input template
- **Gate** — Pauses for user approval before continuing

Artifacts flow between steps automatically. Each step's output becomes available as `{{input}}` for the next.

---

## Supported Models

| Provider | Models | Access |
|----------|--------|--------|
| **Anthropic API** | Claude 3.5 Sonnet, Claude 3 Opus, Claude 3.5 Haiku | API key |
| **Anthropic CLI** | Claude Opus 4.5, Claude Opus 4, Claude Sonnet 4 | Claude Code subscription |
| **OpenAI API** | GPT-4o, GPT-4 Turbo, o1-preview, o1-mini | API key |
| **OpenAI CLI** | GPT-5.2 Codex, GPT-5.1 Codex, o3 Mini | Codex subscription |
| **DeepSeek** | DeepSeek Chat, DeepSeek Coder | API key (OpenAI-compatible) |

Each persona in a council can use a different provider and model. Mix frontier reasoning models for complex analysis with faster models for routine tasks.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Runtime | Tauri 2.9 (Rust) |
| Frontend | React 19, TypeScript, Vite 7 |
| Backend | Rust (tokio, reqwest, serde) |
| MCP Proxy | Node.js, Express |
| Search Server | Node.js, SearXNG, Readability |
| Workflow Engine | FlowForge (TypeScript, Express) |
| Styling | Tailwind CSS, PostCSS |
| Testing | Vitest |

---

## What Makes Kondi Different

| Feature | Single-Agent Tools | Kondi |
|---------|-------------------|-------|
| **Perspectives** | One model, one viewpoint | Multiple agents with different models, roles, and focus areas |
| **Decision Quality** | Whatever the model outputs | Structured deliberation with rounds, debate, convergence criteria |
| **Traceability** | Chat history | Append-only ledger with artifacts, versions, token counts |
| **Tool Access** | Per-model tool calling | MCP-native — any MCP server, with OAuth proxy for authenticated APIs |
| **Workflow** | Prompt chains | Deterministic state machine with min/max rounds, context versioning, review cycles |
| **Provider Lock-in** | Tied to one provider | Mix Anthropic, OpenAI, and DeepSeek in the same council |
| **Infrastructure** | Cloud-hosted | Desktop-native, keys stay local |

---

## Installation

### Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| [Node.js](https://nodejs.org/) | 18+ | For frontend, proxy, and search server |
| [Rust](https://www.rust-lang.org/tools/install) | 1.77.2+ | For Tauri backend |
| [Tauri CLI](https://v2.tauri.app/start/prerequisites/) | 2.x | Install via `cargo install tauri-cli` |
| System dependencies | — | See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS (webkit2gtk on Linux, Xcode on macOS) |

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

### Clone the Repository

```bash
git clone git@github.com:thisPointOn/kondi.git
cd kondi
```

### Install the Main Application

```bash
cd mcp-connect-mvp
npm install
```

This installs the React frontend, Tauri bindings, and all TypeScript dependencies. The Rust backend compiles automatically on first run.

### Build the MCP Proxy

The proxy is a dependency of the main app — it's spawned automatically when you connect to authenticated MCP servers.

```bash
cd mcp-connect-mvp/kondi-mcp-proxy
npm install
npm run build
```

### (Optional) Install the Search Server

If you want agents to have web search capabilities:

```bash
# 1. Start SearXNG via Docker
cd kondi-search-mcp
docker-compose up -d

# 2. Install and build the MCP search server
npm install
npm run build
```

This starts a local SearXNG instance on port 8888 and builds the MCP server that wraps it.

### (Optional) Install FlowForge

For self-healing workflow orchestration:

```bash
cd flowforge
npm install
npm run build
```

---

## Running

### Development Mode

```bash
cd mcp-connect-mvp
npm run tauri:dev
```

This starts both the Vite dev server (port 5175) and the Tauri desktop window with hot-reload. Changes to React/TypeScript code will hot-reload instantly. Changes to Rust code trigger an automatic recompile.

### Production Build

```bash
cd mcp-connect-mvp
npm run tauri build
```

This produces a native installer for your platform:
- **Linux:** `.deb` and `.AppImage` in `src-tauri/target/release/bundle/`
- **macOS:** `.dmg` in `src-tauri/target/release/bundle/`
- **Windows:** `.msi` and `.exe` in `src-tauri/target/release/bundle/`

### Running the Search Server

```bash
# Make sure SearXNG is running
cd kondi-search-mcp
docker-compose up -d

# Start the MCP server (stdio mode for local use)
npm run start

# Or development mode with auto-reload
npm run dev
```

Then connect to it from within Kondi as a local MCP server.

### Running the Express Server

For pipeline execution and API access:

```bash
cd mcp-connect-mvp
npm run dev:server
```

---

## Configuration

### LLM Providers

On first launch, Kondi will prompt you to configure at least one provider. You can set up:

| Provider | What You Need |
|----------|--------------|
| **Anthropic API** | API key from [console.anthropic.com](https://console.anthropic.com/) |
| **Anthropic CLI** | Active [Claude Code](https://claude.ai/) subscription with `claude` CLI installed |
| **OpenAI API** | API key from [platform.openai.com](https://platform.openai.com/) |
| **OpenAI CLI** | Active Codex subscription with `codex` CLI installed |
| **DeepSeek** | API key from [platform.deepseek.com](https://platform.deepseek.com/) |

API keys are stored locally on your machine and never sent anywhere except the provider's own API endpoint.

### MCP Servers

Connect to MCP servers from the sidebar in the app. Kondi supports:

- **Local servers** via stdio (e.g., the search server above)
- **Remote servers** via SSE/HTTP with automatic proxy authentication
- **OAuth-authenticated servers** — Kondi opens your browser for the auth flow and stores tokens locally at `~/.local/share/kondi/proxies/`

### Working Directory

When creating a council, you can set a working directory. The Worker agent will operate within this directory for file-related tasks. Enable "Directory Constrained" to prevent the Worker from accessing files outside this path.

---

## Quick Start: Your First Council

1. **Launch Kondi** — `npm run tauri:dev` from `mcp-connect-mvp/`
2. **Configure a provider** — Add at least one API key or CLI subscription in Settings
3. **Create a council** — Click "New Council" in the sidebar
4. **Add personas** — Create at least 3 personas (they'll be assigned as Manager, Consultant, Worker)
5. **Assign roles** — In the Setup tab, assign each persona a role and optionally set focus areas for consultants
6. **Define the task** — In the Task tab, describe the problem and expected output
7. **Save & Start** — Save the task, then start the deliberation from the Deliberation tab
8. **Watch it run** — The ledger shows every agent's contribution in real-time as the deliberation progresses through rounds, decision, execution, and review

---

## Project Structure

```
kondi/
├── mcp-connect-mvp/               # Main desktop application
│   ├── src/                        # React/TypeScript frontend
│   │   ├── App.tsx                 # Root component & state management
│   │   ├── council/                # Deliberation engine (13 files)
│   │   │   ├── deliberation-orchestrator.ts  # State machine
│   │   │   ├── types.ts            # All deliberation types
│   │   │   ├── prompts.ts          # Role-specific LLM prompts
│   │   │   ├── ledger-store.ts     # Append-only audit trail
│   │   │   ├── context-store.ts    # Versioned artifacts
│   │   │   ├── store.ts            # Council CRUD
│   │   │   └── llm-adapter.ts      # Provider routing
│   │   ├── pipeline/               # Workflow orchestration
│   │   ├── services/               # LLM clients, MCP, OAuth
│   │   ├── components/             # React UI components
│   │   │   ├── council/            # Deliberation UI
│   │   │   ├── pipeline/           # Pipeline builder UI
│   │   │   └── ChatArea.tsx        # Chat interface
│   │   └── config/                 # Model definitions
│   ├── src-tauri/                  # Rust backend
│   │   └── src/commands.rs         # MCP process management, OAuth, proxy
│   ├── kondi-mcp-proxy/            # Authentication proxy (Node.js)
│   │   └── src/
│   │       ├── proxy.ts            # SSE streaming, message forwarding
│   │       └── auth/               # OAuth, API key, bearer, custom header
│   └── server/                     # Express.js API server
├── kondi-search-mcp/               # Web search MCP server
│   ├── src/tools/                  # web_search, web_fetch tools
│   ├── docker-compose.yml          # SearXNG container
│   └── searxng-config/             # SearXNG settings
├── flowforge/                      # Self-healing workflow library
│   └── src/
│       ├── providers/              # LLM adapters (10+ providers)
│       ├── executor/               # Step execution & self-healing
│       └── planner/                # Interactive workflow planning
└── README.md
```

---

## License

This project is proprietary. All rights reserved.
