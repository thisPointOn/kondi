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

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/tools/install) (for Tauri)
- At least one LLM provider key (Anthropic API, OpenAI API, or DeepSeek) or a CLI subscription (Claude Code, Codex)

### Install & Run

```bash
cd mcp-connect-mvp
npm install
npm run tauri dev
```

### Optional: Search Server

```bash
# Start SearXNG (Docker)
cd kondi-search-mcp
docker-compose up -d

# Start the MCP search server
npm install
npm run dev
```

---

## License

This project is proprietary. All rights reserved.
