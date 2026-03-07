# Kondi Project Specification

> Machine-readable living spec. Single source of truth for current types, defaults, keys, and flags.
> For architectural rationale and deep "why" explanations, see `ARCHITECTURE.md`.
>
> **Last updated:** 2026-03-06

---

## 1. Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Tauri 2.x (Rust backend) |
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS |
| State | In-memory `CouncilDataStore` (primary) + localStorage (cache) + React hooks |
| LLM access | Direct API clients + CLI wrappers (Claude Code, Codex) |
| MCP transport | stdio (local), HTTP+SSE (proxy), built-in servers |

---

## 2. Repo Layout

```
mcp-connect-mvp/
  src-tauri/src/commands.rs      # Rust backend (~4800 lines) — Tauri commands
  src/
    pipeline/
      types.ts                   # PipelineStepType, step configs, Pipeline schema
      executor.ts                # PipelineExecutor — stage/step dispatch, artifact flow
      store.ts                   # Pipeline localStorage store (key: mcp-pipelines, version 5)
      output-parsers.ts          # isOpenAIModel(), stream-json parsing
    council/
      types.ts                   # Phases, entry types, roles, modes, artifacts
      factory.ts                 # createCouncilFromSetup() — default values
      store.ts                   # Council localStorage store (key: mcp-councils)
      context-store.ts           # Per-council artifact CRUD (context, decision, plan, directive, outputs)
      ledger-store.ts            # Chunked ledger storage (ledger-index-{id}, ledger-chunk-{id}-{n})
      deliberation-orchestrator.ts  # Deliberation state machine
      coding-orchestrator.ts     # Coding workflow state machine
      llm-adapter.ts             # Provider routing (LLMAdapter class)
      prompts.ts                 # Prompt construction for all roles and step types
      validation.ts              # LLM output parsing/validation
    config/
      models.ts                  # ModelProvider type, all model definitions
    services/
      anthropicClient.ts         # Anthropic API direct calls
      openaiClient.ts            # OpenAI API direct calls
      codexClient.ts             # Codex CLI wrapper
      geminiClient.ts            # Google Gemini API client
      openaiCompatibleClient.ts  # DeepSeek, xAI, Ollama (OpenAI-compatible)
      mcpClient.ts               # MCP server connection management
      proxyService.ts            # MCP proxy lifecycle
    hooks/
      useProviderConfig.ts       # Provider selection, API keys, default model
  cli/
    run-pipeline.ts              # CLI entry point
    claude-caller.ts             # Spawns `claude --print --verbose --output-format stream-json`
    codex-caller.ts              # Spawns `codex exec --json`
    node-platform.ts             # Node.js PlatformAdapter (fs, child_process)
    localStorage-shim.ts         # In-memory Storage polyfill for CLI
    session-export.ts            # Export CLI session for GUI import
  kondi-mcp-proxy/src/           # Node.js MCP proxy process
docs/
  ARCHITECTURE.md                # Deep architectural rationale (24KB)
  GUIDE.md                       # User guide (34KB)
```

---

## 3. LLM Providers

| Provider ID | Auth | CLI Tool | Key Models |
|------------|------|----------|------------|
| `anthropic-api` | API key | — | claude-sonnet-4-5-20250929, claude-haiku-4-5-20251001 |
| `anthropic-cli` | Subscription | Claude Code | claude-opus-4-6, claude-sonnet-4-5-20250929, claude-opus-4-5-20251101 |
| `openai-api` | API key | — | gpt-4o, gpt-4o-mini, o1-preview |
| `openai-cli` | Subscription | Codex | gpt-5.3-codex, gpt-5.2-codex, gpt-5.2 |
| `deepseek` | API key | — | deepseek-reasoner, deepseek-chat |
| `google` | API key | — | gemini-2.5-pro, gemini-2.5-flash |
| `xai` | API key | — | grok-3, grok-3-mini |
| `ollama` | Local | — | llama3.1, qwen2.5-coder, mistral |

Legacy provider names (`anthropic`, `openai`) are resolved via `resolveProvider()` in `config/models.ts`.

Type: `ModelProvider = 'anthropic-api' | 'anthropic-cli' | 'openai-api' | 'openai-cli' | 'deepseek' | 'google' | 'xai' | 'ollama'`

---

## 4. Council System

### Modes
`CouncilMode = 'debate' | 'build' | 'review' | 'synthesis' | 'socratic' | 'freeform' | 'deliberation'`

Pipeline steps always use `'deliberation'` mode.

### Roles
`DeliberationRole = 'manager' | 'consultant' | 'worker' | 'reviewer'`

### Turn Strategies
`TurnStrategy = 'round-robin' | 'react' | 'popcorn' | 'volunteer' | 'moderator' | 'parallel' | 'relevance'`

### 4a. Deliberation Orchestrator

Deterministic state machine. Phases:
```
created → problem_framing → round_independent → round_interactive →
round_waiting_for_manager → (loop or) deciding → directing → executing →
reviewing → (revising loop or) completed
```

Optional phases: `planning` (before directing), `paused`, `cancelled`, `failed`

Entry types: `problem_statement`, `analysis`, `proposal`, `response`, `context_acceptance`, `context_rejection`, `manager_question`, `manager_redirect`, `round_summary`, `decision`, `plan`, `work_directive`, `work_output`, `review`, `revision_request`, `re_deliberation`, `cancellation`, `error`

### 4b. Coding Orchestrator

Extends the deliberation lifecycle with code-specific phases:
```
created → problem_framing → decomposing → implementing → code_reviewing →
testing → (debugging loop or) completed
```

Additional entry types: `decomposition`, `module_directive`, `module_output`, `code_review`, `test_result`, `debug_fix`

**UI parity requirement:** All `Record<Phase, ...>` and `Record<EntryType, ...>` maps in UI components MUST include entries for BOTH orchestrators. Missing entries crash the React tree (no error boundary). Affected files: `PhaseIndicator.tsx`, `LedgerEntryCard.tsx`, `LedgerTimeline.tsx`, `DeliberationView.tsx`.

---

## 5. Pipeline Steps

### Step Types

| Type | Orchestrator | Default Personas | Output | Notes |
|------|-------------|-----------------|--------|-------|
| `council` | Deliberation | Manager + Consultant(s) + Worker | General output | Open deliberation, full tools, worker saves `_output.md` |
| `code_planning` | Deliberation | Manager + Consultant(s) + Worker | Plan document | Planning prompts, PLAN_TOOLS only, worker saves `_plan.md` |
| `coding` | Coding | Manager + Worker + Reviewer | Code files | Worker saves `_code.md`, has testCommand, maxDebugCycles |
| `review` | Deliberation | Manager + Consultant(s) + Worker | Review document | Worker saves `_review.md` |
| `enrich` | Deliberation | Manager + Consultant(s) + Worker | Enriched content | Worker saves `_enrichment.md` |
| `analysis` | Deliberation (lightweight) | Manager + Worker personas | Decision or output artifact | 0 rounds, 0 revisions, suppressPersona=true |
| `agent` | Deliberation (lightweight) | Single Worker persona | Output artifact | 0 rounds, 0 revisions, suppressPersona=true |
| `gate` | None | None | Approval | Pauses for user confirmation |
| `script` | None | None | stdout | Runs a shell command, captures stdout as artifact |
| `condition` | None | None | Evaluation result | Evaluates expression against input; actions: continue, skip_next_stage, stop |

`PipelineStepType = 'council' | 'code_planning' | 'analysis' | 'agent' | 'coding' | 'review' | 'enrich' | 'gate' | 'script' | 'condition'`

### 5a-1. OutputType

`OutputType = 'string' | 'file' | 'directory' | 'json'`

| Type | Behavior |
|------|----------|
| `string` | Text content passed directly to downstream steps |
| `file` | File path — downstream steps instructed to read the file |
| `directory` | Directory path — downstream steps instructed to read all files |
| `json` | Structured JSON — downstream steps can access fields via `{{input.fieldName}}` templates |

### 5a-2. Input Template Syntax

| Pattern | Description |
|---------|-------------|
| `{{input}}` | All previous artifacts joined |
| `{{input[N]}}` | Specific artifact by index |
| `{{input.fieldName}}` | JSON field from last artifact (dot-path walk) |
| `{{input[N].fieldName}}` | JSON field from specific artifact |
| `{{file}}` | All output file paths joined |
| `{{file[N]}}` | Specific artifact's file path |

### 5a-3. Script Step Config

```typescript
interface ScriptStepConfig {
  type: 'script';
  command: string;        // Shell command — $KONDI_INPUT has previous step output
  inputTemplate: string;  // Template that renders into $KONDI_INPUT
  outputType?: OutputType; // Default: 'string'
}
```

The rendered input is exported as `$KONDI_INPUT` (shell-escaped) before the command runs. This avoids shell injection from step outputs.

### 5a-4. Condition Step Config

```typescript
type ConditionMode = 'contains' | 'regex' | 'equals';
type ConditionAction = 'continue' | 'skip_next_stage' | 'stop';

interface ConditionStepConfig {
  type: 'condition';
  expression: string;       // What to match
  mode: ConditionMode;      // How to match
  inputTemplate: string;    // What to match against
  trueAction: ConditionAction;
  falseAction: ConditionAction;
}
```

When a condition step triggers `skip_next_stage`, the executor skips the immediately following stage (marks all its steps as 'skipped') and continues with the stage after that. When it triggers `stop`, the pipeline completes gracefully — remaining stages are marked as 'skipped' and the pipeline status is 'completed'.

### 5a. CouncilSetup Defaults (from `factory.ts`)

| Parameter | Default |
|-----------|---------|
| `maxRounds` | 4 |
| `maxRevisions` | 3 |
| `minRounds` | 1 |
| `directoryConstrained` | true |
| `summaryMode` | `'hybrid'` |
| `summarizeAfterRound` | 2 |
| `contextTokenBudget` | 80000 |
| `consultantErrorPolicy` | `'retry'` |
| `maxRetries` | 2 |
| `requirePlan` | false |
| `consultantExecution` | `'sequential'` |
| `saveDeliberationMode` | `'full'` |
| `maxDebugCycles` | 5 |
| `maxReviewCycles` | 2 |
| `bootstrapContext` | true (when workingDirectory is set) |
| Worker `suppressPersona` | true |
| Manager `suppressPersona` | true |
| Reviewer `suppressPersona` | true |
| Consultant `suppressPersona` | false |
| Worker `writePermissions` | true |
| Default `temperature` | 0.7 |

### 5b. Pipeline Store Schema

Key: `mcp-pipelines` — version 5.

Step configs: `CouncilStepConfig | LlmStepConfig | GateStepConfig | ScriptStepConfig | ConditionStepConfig`

Legacy `LlmStepConfig` (flat `model/provider/systemPrompt`) is auto-migrated to `CouncilStepConfig` via `migrateLlmConfig()`.

Input template variables: `{{input}}` (all previous artifacts), `{{input[N]}}` (specific artifact by index), `{{file}}` (all output file paths), `{{file[N]}}` (specific file path).

---

## 6. MCP Integration

### Transports
- **stdio**: Local server processes managed by Tauri
- **HTTP+SSE**: Remote servers via MCP proxy (`kondi-mcp-proxy/`)
- **Built-in**: `builtinServers.ts` (filesystem, search)

### Proxy
- Config stored at `~/.local/share/kondi/proxies/{id}.json`
- Rust `start_proxy` spawns Node.js proxy process
- OAuth connections: 300s timeout for browser flow, 5 retries on 401, stop+restart proxy if stuck in `needs_reauth`

### Per-Step Server Access
`allowedServerIds?: string[]` on step config, persona, and role assignment. `undefined` = all servers.

---

## 7. CLI Pipeline Runner

Entry point: `npx tsx cli/run-pipeline.ts <pipeline.json> [options]`

### Flags
| Flag | Purpose |
|------|---------|
| `--working-dir <path>` | Override pipeline working directory |
| `--model <model>` | Override model for all LLM steps |
| `--name <name>` | Select pipeline by name (multi-pipeline files) |
| `--dry-run` | Print structure without executing |

### Routing
`callLLM()` checks `isOpenAIModel(model)`:
- OpenAI models → `callCodex()` → `codex exec --json`
- All others → `callClaude()` → `claude --print --verbose --output-format stream-json`

### Critical Gotchas
1. **`--allowedTools` is variadic** — never pass prompt as positional arg; always pipe via stdin
2. **Must set `CLAUDECODE=undefined` in env** when spawning nested Claude CLI
3. **`--print` requires `--verbose`** when using `--output-format stream-json`
4. **Codex resume**: `codex exec resume <thread_id>` — no `--sandbox`/`--full-auto` flags on resume
5. **Per-persona session persistence** via `personaSessionIds` Map (cleared on new council/step)

### Output
- Execution report: `<working-dir>/kondi-execution-report.json`
- Session export: `kondi-session-<pipeline-id>.json` (importable by GUI)

---

## 8. LLM Adapter Routing

`LLMAdapter` in `llm-adapter.ts` routes by provider ID and model name:

| Detection | Client | Default Model |
|-----------|--------|---------------|
| provider contains `anthropic` or model contains `claude` | `anthropicClient` | claude-sonnet-4-5-20250929 |
| provider = `openai-cli` | `codexClient` | gpt-5.2-codex |
| provider contains `openai` or model contains `gpt` | `openaiClient` | gpt-4o |
| provider = `deepseek` or model contains `deepseek` | `deepseekClient` | (from params) |
| provider = `google` or model contains `gemini` | `geminiClient` | gemini-2.5-flash |
| provider = `xai` or model contains `grok` | `xaiClient` | (from params) |
| provider = `ollama` | `ollamaClient` | (from params) |
| Fallback | `anthropicClient` | claude-sonnet-4-5-20250929 |

**Conversation ID isolation**: Each council persona call MUST get a unique conversation ID (`council-<uuid>`). Sharing IDs causes context accumulation and failures in round 2+.

---

## 9. Data Storage

All state goes through `CouncilDataStore` (`council/storage-cleanup.ts`) — an in-memory `Map<string,string>` with no size limit. Browser `localStorage` is a best-effort cache; quota errors are silently ignored. The CLI uses the same pattern via `localStorage-shim.ts`.

### Key Namespaces

| Key Pattern | Store | Contents |
|-------------|-------|----------|
| `mcp-pipelines` | pipeline/store.ts | Pipeline[] (version 5) |
| `mcp-councils` | council/store.ts | Council[] |
| `mcp-servers` | hooks/useServers.ts | Server configs |
| `mcp-api-keys` | hooks/useProviderConfig.ts | Encrypted API keys |
| `mcp-theme` | hooks/useTheme.ts | Theme preference |
| `kondi-provider` | hooks/useProviderConfig.ts | Active provider ('claude' or 'chatgpt') |
| `kondi-provider-id` | hooks/useProviderConfig.ts | Default provider ID |
| `kondi-provider-models` | hooks/useProviderConfig.ts | Per-provider model selection |
| `kondi-anthropic-model` | hooks/useProviderConfig.ts | Selected Anthropic model |
| `kondi-openai-model` | hooks/useProviderConfig.ts | Selected OpenAI model |
| `kondi-global-working-directory` | hooks/useProviderConfig.ts | Global working directory |
| `kondi-input-history` | components/ChatArea.tsx | Chat input history |
| `context-{councilId}` | council/context-store.ts | Current ContextArtifact |
| `context-history-{councilId}` | council/context-store.ts | ContextArtifact[] (all versions) |
| `context-patches-{councilId}` | council/context-store.ts | ContextPatch[] |
| `decision-{councilId}` | council/context-store.ts | DecisionArtifact |
| `plan-{councilId}` | council/context-store.ts | PlanArtifact |
| `directive-{councilId}` | council/context-store.ts | DirectiveArtifact |
| `outputs-{councilId}` | council/context-store.ts | OutputArtifact[] |
| `ledger-index-{councilId}` | council/ledger-store.ts | LedgerIndex |
| `ledger-chunk-{councilId}-{n}` | council/ledger-store.ts | LedgerEntry[] (chunked) |

### Storage Architecture (`council/storage-cleanup.ts`)

`CouncilDataStore` is a singleton in-memory `Map` that all stores use for reads and writes:
- `getItem(key)`: checks in-memory Map first, falls back to localStorage (promotes to Map on hit)
- `setItem(key, value)`: always succeeds in Map; localStorage write is try/catch silenced
- `removeItem(key)`: removes from both Map and localStorage

**Stores using `councilDataStore`**: `context-store.ts`, `ledger-store.ts`, `council/store.ts`, `pipeline/store.ts`, `session-import.ts`.

**No data destruction.** Deliberation history is never purged. After each pipeline step extracts its artifact, `stripCompletedCouncil(councilId)` trims only the localStorage copy of the `mcp-councils` entry to keep the cache small. The authoritative data remains in the Map.

---

## 10. Known Gotchas & Fixed Bugs

> Append-only. Never remove entries unless the root cause is verified as fully eliminated.

1. **Raw JSON in deliberation output**: `run_claude_streaming` Rust result extraction only handled `.as_str()`. Fixed: non-string handling + JS-side `parseStreamJsonOutput()` fallback.
2. **Missing consultant contributions**: `addPersona()` didn't create role assignments. Fixed: auto-create consultant role assignment in `addPersona()`, clean up in `removePersona()`.
3. **Proxy OAuth red dots**: 30s timeout fires during OAuth browser flow; proxy fails after fresh OAuth due to token propagation delay. Fixed: 180s timeout for proxy, 5 retries, stop+restart proxy if stuck in `needs_reauth`.
4. **CLI session sharing in councils**: `chatViaCli()` shared `currentConversationId` across all persona calls. Fixed: unique `council-<uuid>` conversation ID per call.
5. **Abort leaves pipeline "running"**: `abort()` only set a boolean flag. Fixed: immediately sets pipeline to 'failed' and marks running steps as 'failed'.
6. **Error attribution in deliberation**: Both catch blocks attributed errors to "manager". Fixed: errors during consultant phases attribute to consultant, worker phases to worker.
7. **localStorage quota exceeded**: Browser's 5MB localStorage cap caused pipeline failures ("Failed to save pipelines to storage", "Failed to save ledger chunk"). Fixed: all stores now route through `CouncilDataStore` — an in-memory Map with no limit. localStorage is a best-effort cache; quota errors are silently ignored. No data is ever destroyed.
8. **OAuth callback 60s timeout**: Users taking >60s got null tokens. Fixed: 300s (5 minutes).
9. **CLI exit code 1 with no detail**: `run_claude_streaming` returned generic error with empty stderr. Fixed: includes stdout when stderr is empty; stdin piping for long messages (>100K chars).
10. **Default provider not settable**: Startup auto-detection changed `selectedProviderId`. Fixed: only ProviderSettings "Set Default" button writes `kondi-provider-id`.
11. **Coding step worker describes instead of implementing**: Worker prompts said "text-only agent" even with `writePermissions=true`. Fixed: all worker/manager prompts check write permissions.
12. **Provider validation no retry**: Fixed: auto-retry after 15s, dismissible yellow banner.
13. **CLI resume missing `--print`**: Without `--print`, CLI runs interactive mode causing tool rejections. Fixed: always pass `--print`.

---

## 11. Development Workflows

### Dev Mode
```bash
cd mcp-connect-mvp
npm run tauri dev          # Starts Rust backend + Vite dev server
```

### Build
```bash
npm run tauri build        # Production build
```

### CLI Pipeline
```bash
cd mcp-connect-mvp
npx tsx cli/run-pipeline.ts path/to/pipeline.json --working-dir /tmp/output
```

### Git Distribution
- **Private repo** (`private` remote): `git@github.com:thisPointOn/kondi-dev.git` — full source
- **Public repo** (`public` remote): `git@github.com:thisPointOn/kondi.git` — distribution
- **Public push**: Uses orphan branch to avoid leaking old commits with secrets
  ```bash
  git checkout --orphan public-push && git add -A && git commit -m "..." && \
  git push public public-push:main --force && git checkout main && git branch -D public-push
  ```
