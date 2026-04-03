# Kondi Council CLI

Multi-LLM council deliberation system. Runs structured debates between AI personas (manager, consultants, worker) across multiple providers to produce reviewed, high-quality outputs.

## Quick Start

```bash
# Clone and install
git clone <repo-url> kondi
cd kondi/mcp-connect-mvp
npm install

# Link globally (makes `kondi` available everywhere)
npm link

# Run a council
kondi council --task "Review this codebase for security issues" --working-dir ~/my-project
```

## Prerequisites

- **Node.js** 20+
- At least one LLM CLI installed:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude` binary) for Anthropic models
  - [OpenAI Codex CLI](https://github.com/openai/codex) (`codex` binary) for OpenAI models
- Or API keys set as environment variables (see [Providers](#providers))

## Usage

```
kondi council [options]
kondi council <council.json> [options]
kondi pipeline <pipeline.json> [options]
```

### Run with a preset config

```bash
kondi council --config configs/councils/analysis.json \
  --task "Critical security review" \
  --working-dir ~/my-project
```

### Run with an inline task (default personas)

```bash
kondi council --task "Should we use REST or GraphQL?" --type council
```

### Run from a GUI-exported council JSON

```bash
kondi council exported-council.json --working-dir ~/my-project
```

### Auto-discover config

Drop a `council.json` in your project directory, then just:

```bash
cd ~/my-project
kondi council
```

It searches for `council.json` in the current directory, then `~/.config/kondi/council.json`.

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--config <path>` | Path to council config JSON | auto-discover |
| `--task "..."` | Task/problem for the council | from config |
| `--type <type>` | Council type (see below) | `council` |
| `--working-dir <path>` | Target project directory | cwd |
| `--model <model>` | Override model for all personas | per-persona |
| `--provider <provider>` | Override provider for all personas | per-persona |
| `--output <format>` | Output format (see below) | `full` |
| `--output-dir <path>` | Override artifact output directory | `.kondi/outputs/` |
| `--no-session-export` | Skip GUI session export | export enabled |
| `--dry-run` | Preview structure, don't run | - |
| `--quiet` | Suppress progress output | - |
| `--json-stdout` | Print JSON result to stdout | - |

## Council Types

| Type | What It Does |
|------|-------------|
| `council` | General deliberation — consultants debate, manager decides, worker synthesizes |
| `coding` | Implementation with test/debug cycles — worker writes actual code |
| `code_planning` | Produces detailed implementation specs — file paths, interfaces, sequencing |
| `analysis` | Reviews code for issues — security, performance, quality, maintainability |
| `review` | Structured code review with specific feedback |
| `agent` | Single-agent task execution with council oversight |

## Output Formats

| Format | Files Written |
|--------|--------------|
| `full` | `deliberation.md` + `decision.md` + `output.md` |
| `abbreviated` | `summary.md` |
| `output-only` | `output.md` (just the final deliverable) |
| `json` | `council-result.json` (structured, parseable) |
| `none` | No files written |

Artifacts are written to `<working-dir>/.kondi/outputs/<council-name>_<timestamp>/`.

## Preset Configs

Four ready-to-use configs in `configs/councils/`:

### `analysis.json` — Code Analysis

5 personas: Lead Analyst (manager), Security Auditor (o3), Performance Engineer (Claude), Code Quality Reviewer (o3), Report Writer (Claude). Produces prioritized analysis reports with severity ratings.

```bash
kondi council --config configs/councils/analysis.json \
  --task "Full security and quality audit" --working-dir ./src
```

### `code-planning.json` — Implementation Planning

4 personas: Architect (Claude), Systems Thinker (o3), Pragmatist (Claude), Implementer (Claude). Parallel consultants, evolving context. Produces implementation specs.

```bash
kondi council --config configs/councils/code-planning.json \
  --task "Plan adding WebSocket support" --working-dir ./my-app
```

### `coding.json` — Code Implementation

4 personas: Tech Lead (Claude), Code Reviewer (o3), Design Consultant (Claude), Developer (Claude). Worker writes files, runs tests, iterates through debug cycles.

```bash
kondi council --config configs/councils/coding.json \
  --task "Add input validation to all API endpoints" --working-dir ./my-app
```

### `debate.json` — General Debate

5 personas: Moderator (Claude), Advocate (o3), Critic (Claude), Wildcard (o3), Synthesizer (Claude). Structured argument with advocate/critic/wildcard stances. Produces decision documents.

```bash
kondi council --config configs/councils/debate.json \
  --task "Should we migrate from monolith to microservices?"
```

## Writing Custom Configs

Create a JSON file with this structure:

```json
{
  "name": "My Council",
  "task": "Default task description",
  "type": "council",
  "personas": [
    {
      "name": "Manager",
      "role": "manager",
      "provider": "anthropic-cli",
      "model": "claude-sonnet-4-5-20250929",
      "systemPrompt": "You are the decision maker.",
      "traits": ["analytical"],
      "suppressPersona": true
    },
    {
      "name": "Expert",
      "role": "consultant",
      "provider": "openai-cli",
      "model": "o3",
      "systemPrompt": "You are a domain expert.",
      "traits": ["thorough"],
      "stance": "critic",
      "domain": "security"
    },
    {
      "name": "Worker",
      "role": "worker",
      "provider": "anthropic-cli",
      "model": "claude-sonnet-4-5-20250929",
      "systemPrompt": "You produce the final output.",
      "traits": ["precise"],
      "temperature": 0.3,
      "suppressPersona": true
    }
  ],
  "orchestration": {
    "maxRounds": 4,
    "maxRevisions": 3,
    "contextTokenBudget": 80000,
    "summarizeAfterRound": 2,
    "consultantExecution": "parallel",
    "bootstrapContext": true,
    "evolveContext": true
  },
  "output": {
    "format": "full",
    "sessionExport": true
  },
  "expectedOutput": "Description of what the final output should contain.",
  "decisionCriteria": [
    "Criterion 1",
    "Criterion 2"
  ]
}
```

### Persona Roles

| Role | Purpose |
|------|---------|
| `manager` | Frames the problem, evaluates consultant input, makes decisions, directs the worker |
| `consultant` | Provides domain expertise, debates approaches, challenges assumptions |
| `worker` | Produces the final deliverable based on the manager's directive |
| `reviewer` | Reviews worker output for correctness (used in coding type) |

### Persona Options

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name |
| `role` | string | `manager`, `consultant`, `worker`, or `reviewer` |
| `provider` | string | `anthropic-cli`, `openai-cli`, `anthropic-api`, `openai-api`, `google`, `deepseek`, `xai`, `ollama` |
| `model` | string | Model ID (e.g. `claude-sonnet-4-5-20250929`, `o3`, `gpt-4o`) |
| `systemPrompt` | string | Identity and behavior instructions |
| `traits` | string[] | Personality traits guiding behavior |
| `stance` | string | `advocate`, `critic`, `neutral`, or `wildcard` |
| `domain` | string | Area of expertise |
| `temperature` | number | 0-1, higher = more creative |
| `suppressPersona` | boolean | If true, persona identity is not injected into prompts |

### Orchestration Options

| Field | Default | Description |
|-------|---------|-------------|
| `maxRounds` | 4 | Maximum deliberation rounds |
| `maxRevisions` | 3 | Maximum worker revision attempts |
| `contextTokenBudget` | 80000 | Token budget for context window |
| `summarizeAfterRound` | 2 | Compress context after this many rounds |
| `summaryMode` | `hybrid` | `hybrid`, `llm`, or `mechanical` |
| `consultantExecution` | `sequential` | `sequential` or `parallel` |
| `bootstrapContext` | true | Auto-scan working directory for context |
| `evolveContext` | false | Append findings to context each phase |

## Providers

### CLI Providers (spawn binary)

| Provider ID | Binary | Default Model |
|-------------|--------|---------------|
| `anthropic-cli` | `claude` | `claude-sonnet-4-5-20250929` |
| `openai-cli` | `codex` | `gpt-5.2-codex` |

### API Providers (direct HTTP)

Set the corresponding environment variable:

| Provider ID | Env Var | Default Model |
|-------------|---------|---------------|
| `anthropic-api` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5-20250929` |
| `openai-api` | `OPENAI_API_KEY` | `gpt-4o` |
| `google` | `GOOGLE_API_KEY` | `gemini-2.5-flash` |
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| `xai` | `XAI_API_KEY` | `grok-3` |
| `ollama` | (local) | `llama3.1` |

## Automation

### Cron / Scheduled Runs

```bash
# Nightly security review, append JSON results to a log
kondi council --config ~/configs/nightly-review.json \
  --task "Nightly security scan" \
  --working-dir /opt/myapp \
  --output json --quiet --json-stdout >> /var/log/kondi-reviews.jsonl
```

### Pipe JSON output

```bash
kondi council --task "Analyze API" --json-stdout --quiet | jq '.output'
```

### GUI Import

Session exports are automatically written to `~/.local/share/kondi/sessions/`. The Kondi desktop app can import these to browse deliberation results in the GUI.

## How It Works

```
┌─────────────────────────────────────────────────────┐
│                   Council Deliberation               │
│                                                      │
│  1. CONTEXT BOOTSTRAP                               │
│     Scan working directory, build initial context    │
│                                                      │
│  2. DELIBERATION ROUNDS (repeat up to maxRounds)    │
│     ┌──────────┐    ┌─────────────┐                 │
│     │ Manager  │───>│ Consultants │ (sequential or  │
│     │ frames   │    │ debate &    │  parallel)      │
│     │ problem  │<───│ advise      │                 │
│     └──────────┘    └─────────────┘                 │
│          │                                           │
│     Manager evaluates: continue / decide / redirect  │
│                                                      │
│  3. DECISION                                         │
│     Manager commits to approach + acceptance criteria│
│                                                      │
│  4. EXECUTION                                        │
│     ┌──────────┐    ┌──────────┐                    │
│     │ Manager  │───>│ Worker   │ (writes output,    │
│     │ directs  │<───│ executes │  may use tools)    │
│     └──────────┘    └──────────┘                    │
│          │                                           │
│     5. REVIEW (optional, up to maxRevisions)        │
│     Manager reviews output, may request revisions    │
│                                                      │
│  6. ARTIFACTS                                        │
│     Write deliberation.md, decision.md, output.md   │
└─────────────────────────────────────────────────────┘
```

## License

AGPL-3.0-only
