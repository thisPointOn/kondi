# Kondi Architecture

Technical documentation of Kondi's design, data flow, and internal systems.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Runtime Architecture](#2-runtime-architecture)
3. [LLM Provider System](#3-llm-provider-system)
4. [MCP Client and Tool Execution](#4-mcp-client-and-tool-execution)
5. [MCP Proxy System](#5-mcp-proxy-system)
6. [Council Orchestration Engine](#6-council-orchestration-engine)
7. [Pipeline Execution Engine](#7-pipeline-execution-engine)
8. [Storage Architecture](#8-storage-architecture)
9. [CLI Pipeline Runner](#9-cli-pipeline-runner)
10. [Built-in MCP Servers](#10-built-in-mcp-servers)
11. [Design Decisions](#11-design-decisions)
12. [Self-Improvement Loop](#12-self-improvement-loop)

---

## 1. System Overview

Kondi is a Tauri 2.9 desktop application. The frontend is React 19 + TypeScript running in a WebKit WebView. The backend is Rust, handling process management, file I/O, OAuth flows, proxy lifecycle, and system-level operations.

```
+-----------------------------------------------------------+
|  Tauri Shell (Rust)                                       |
|  +-----------------------------------------------------+ |
|  |  WebKit WebView                                      | |
|  |  +-------+ +----------+ +---------+ +-------------+ | |
|  |  | Chat  | | Council  | |Pipeline | | Tools Panel | | |
|  |  | Area  | | Views    | | Builder | |             | | |
|  |  +---+---+ +----+-----+ +----+----+ +------+------+ | |
|  |      |          |            |              |        | |
|  |  +---v----------v------------v--------------v------+ | |
|  |  |           React State + Hooks                   | | |
|  |  |  useChats | useProviderConfig | councilStore    | | |
|  |  +---+-------+------------------+-----------+------+ | |
|  |      |                                      |        | |
|  |  +---v------+   +----------+   +------------v-----+  | |
|  |  | LLM      |   | MCP      |   | Orchestrators    |  | |
|  |  | Clients  |   | Client   |   | (Deliberation,   |  | |
|  |  |          |   |          |   |  Coding)          |  | |
|  |  +---+------+   +----+-----+   +------------------+  | |
|  +------|----------------|-------------------------------+ |
|         |                |                                 |
|  +------v-------+ +-----v-------+  +------------------+   |
|  | Tauri invoke  | | stdio/SSE  |  | MCP Proxy        |   |
|  | (Rust cmds)   | | transport  |  | (Node.js/Express) |  |
|  +------+--------+ +-----+------+  +--------+---------+   |
|         |                |                   |             |
+---------v----------------v-------------------v-------------+
          |                |                   |
    +-----------+    +----------+     +----------------+
    | File I/O  |    | MCP      |     | OAuth Provider |
    | Process   |    | Servers  |     | (Browser PKCE) |
    | Mgmt      |    | (local/  |     +----------------+
    +-----------+    |  remote) |
                     +----------+
```

### Key Boundaries

- **JS <-> Rust**: All system calls (file ops, process spawning, OAuth) go through Tauri `invoke()`. JavaScript never touches the filesystem directly.
- **JS <-> MCP**: Tool calls route through the MCP client which manages connections, tool discovery, and execution via stdio or SSE transport.
- **JS <-> LLM**: Provider clients make direct HTTP calls (API providers) or spawn CLI processes via Tauri commands (CLI providers).

### Packaging and Licensing

The app ships as cross-platform Tauri installers built by `.github/workflows/release.yml` (matrix: macOS arm64/x64 `.dmg`, Linux `.AppImage`/`.deb`/`.rpm` from `ubuntu-22.04`, Windows `.exe`/`.msi`). The `kondi-guard` containment sidecar is a Cargo workspace crate under `src-tauri/kondi-guard`.

License (see `LICENSING.md`): the entire project — the Rust/Tauri backend (`src-tauri/`, including `kondi-guard`) and the frontend and everything else — is **MIT**.

---

## 2. Runtime Architecture

### Tauri Backend (`src-tauri/src/commands.rs`)

The Rust backend (~4,800 lines) exposes commands via `#[tauri::command]`:

| Command Category | Examples |
|-----------------|---------|
| **Process Management** | `start_mcp_process`, `stop_mcp_process`, `run_claude_streaming` |
| **File Operations** | `save_chats`, `load_chats`, `read_file_contents`, `write_file_contents` |
| **OAuth** | `start_oauth_full`, `reauthenticate_proxy` |
| **Proxy Lifecycle** | `start_proxy`, `stop_proxy`, `get_proxy_status` |
| **System** | `list_directory_contents`, `run_shell_command`, `get_app_data_dir` |

### Process Spawning

MCP stdio servers and CLI tools are spawned as child processes via Tokio. The Rust backend:
1. Constructs the command with arguments and env vars
2. Spawns with stdout/stderr pipes
3. Reads output asynchronously
4. Returns structured results to JavaScript

For CLI LLM calls (`run_claude_streaming`), long prompts are piped via stdin to avoid OS `ARG_MAX` limits. The command uses `--output-format stream-json` for structured output parsing.

### Frontend Rendering

React 19 with Vite 7 hot-reload in development. No client-side routing — the sidebar controls a single-page view switcher in `App.tsx`. State management uses React hooks (useState, useRef, useEffect, useMemo) and localStorage for persistence. `Sidebar.tsx` has a **Pipelines** section (expandable list synced from `pipelineStore`, tile-view + new-pipeline actions, plus a collapsed-mode nav button) — Pipelines is the sidebar's only top-level workflow entry point; there is no separate Council section (§6, "Councils Live Inside Pipelines"). Council Views (the diagram box above) is reached only as a drill-in from a pipeline step or a project's council list, never navigated to directly from the sidebar.

---

## 3. LLM Provider System

### Provider Architecture

```
ChatArea / Orchestrator
        |
        v
   callProvider(providerId, messages)
        |
        +---> anthropicClient.chat()  ---> Anthropic API / Claude CLI
        +---> openaiClient.chat()     ---> OpenAI API / Codex CLI
        +---> deepseekClient.chat()   ---> DeepSeek API (OpenAI-compatible)
        +---> xaiClient.chat()        ---> xAI API (OpenAI-compatible)
        +---> geminiClient.chat()     ---> Google Gemini API / Gemini CLI
        +---> ollamaClient.chat()     ---> Ollama localhost (OpenAI-compatible)
```

### Client Files

| File | Providers | Notes |
|------|-----------|-------|
| `anthropicClient.ts` | Anthropic API, Claude CLI | Claude CLI via `run_claude_streaming` Tauri command |
| `openaiClient.ts` | OpenAI API, Codex CLI | Codex CLI via similar Tauri command |
| `openaiCompatibleClient.ts` | DeepSeek, xAI, Ollama | Reuses OpenAI chat completions API format |
| `geminiClient.ts` | Google Gemini API, Gemini CLI | Gemini CLI via Tauri command |

### Provider Detection (`startupValidator.ts`)

On startup:
1. Check for `claude` CLI in PATH -> Anthropic CLI available
2. Check for `codex` CLI in PATH -> OpenAI CLI available
3. Check for `gemini` CLI in PATH -> Google CLI available
4. Probe `localhost:11434` -> Ollama available (discover models via `/api/tags`)
5. Check localStorage for stored API keys -> respective API providers available

Results stored as a validation report with per-provider status.

### API Key Resolution

```
resolveApiKeySync(provider):
  1. Check CLI env var (e.g., ANTHROPIC_API_KEY)
  2. Check auth profile store (localStorage)
  3. Return null if none found
```

### CLI Provider Routing

CLI providers spawn external processes:
- **Claude Code**: `claude --print --verbose --output-format stream-json [--allowedTools ...] [--resume <id>]`
- **Codex**: `codex exec --json [--full-auto]`
- **Gemini**: `gemini --output-format json`

Codex normally runs `--full-auto` (`--sandbox workspace-write`), confining writes to the working dir natively. Settings → General → "CLI Workers" exposes a **"Run Codex without its OS sandbox"** opt-in (localStorage `kondi-codex-no-sandbox`), for hosts whose kernel restricts unprivileged user namespaces and can't start the Codex sandbox (`bwrap` errors). When on, Codex runs `--dangerously-bypass-approvals-and-sandbox` and containment relies only on Kondi git-scoping the working dir (less strict). Claude Code is unaffected — its write containment is a PreToolUse guard hook, not an OS sandbox.

Prompts are piped via stdin (not as positional args) to handle long content and avoid issues with `--allowedTools` being variadic.

Critical env: `CLAUDECODE=undefined` must be set when spawning nested Claude CLI to prevent conflicts.

### Model Configuration (`config/models.ts`)

Each model definition includes:
- `id`, `name`, `provider`
- `contextWindow` — token limit
- `capabilities` — ['text', 'code', 'vision', 'reasoning']
- `inputCostPer1K`, `outputCostPer1K` — for cost estimation
- `tier` — 1 (premium), 2 (standard), 3 (economy)

---

## 4. MCP Client and Tool Execution

### MCPClient (`services/mcpClient.ts`)

The MCP client manages server connections, tool discovery, and tool execution.

```
MCPClient
  |-- servers: Map<id, MCPServer>
  |-- connect(server) -> probe, authenticate, fetch tools
  |-- disconnect(server) -> stop process / close connection
  |-- callTool(serverId, toolName, args) -> execute and return result
  |-- getAllServers() -> MCPServer[]
```

### Connection Flow

```
1. User adds server (URL or stdio command)
2. MCPClient.probeServer(url) -> detect transport, auth requirements
3. If auth needed:
   a. OAuth: spawn proxy, open browser, wait for callback (300s timeout)
   b. API Key: user enters in UI
   c. Bearer: user enters in UI
4. MCPClient.connect(server) -> establish connection
   - stdio: spawn child process via Tauri
   - SSE: HTTP connection to endpoint
   - proxy: connect through local auth proxy
5. MCPClient.fetchTools(server) -> MCP tool introspection
6. Tools available for LLM use
```

### Tool Execution

When an LLM calls a tool:
1. The provider client returns the tool call in its response
2. ChatArea / orchestrator extracts the tool call
3. Routes to `MCPClient.callTool(serverId, toolName, args)` or `localToolsService.execute()` for built-in tools
4. Result is added to the message history
5. LLM sees the result and continues

### Server Persistence

Server configurations (id, name, URL, transport, metadata, auth) are stored in localStorage and restored on app restart. Servers start in `disconnected` state — the user must explicitly connect.

---

## 5. MCP Proxy System

### Why a Proxy?

OAuth-authenticated MCP servers need token management (refresh, retry on 401, browser-based auth flows). The proxy handles this transparently so the MCP client only sees a simple HTTP endpoint.

### Architecture

```
Kondi App
    |
    v
MCPClient ----HTTP----> kondi-mcp-proxy (localhost:PORT)
                              |
                              +-- manages OAuth tokens
                              +-- forwards requests to upstream MCP
                              +-- refreshes on 401
                              +-- re-reads config on each retry
                              |
                              v
                        Upstream MCP Server (remote)
```

### Proxy Lifecycle

1. **Start**: Tauri command `start_proxy` spawns a Node.js process running `kondi-mcp-proxy`
2. **Config**: Proxy reads `~/.local/share/kondi/proxies/{id}.json` containing:
   - Upstream URL
   - OAuth tokens (access_token, refresh_token, expiry)
   - Client credentials (client_id, client_secret)
   - Dynamic registration endpoint (if supported)
3. **Token Refresh**: On 401 response, proxy refreshes the token and retries
4. **Reauth**: If refresh fails, proxy enters `needs_reauth` state; UI prompts for re-authentication
5. **Stop**: Tauri command `stop_proxy` kills the process

### Retry Logic

- **180s timeout** for initial proxy connection (accounts for browser OAuth flow)
- **5 retries** on init POST with 401 (re-reads config each retry for token propagation)
- **Stop + restart** proxy if stuck in `needs_reauth` state

---

## 6. Council Orchestration Engine

### UI Surface: Councils Live Inside Pipelines

There is no standalone Councils screen. A council is the deliberation *engine* driving a pipeline step, not a parallel top-level concept in the UI — the sidebar has a single **Pipelines** entry point, and the council view (`DeliberationView`) is reached only by drilling into a step from a pipeline (or a project's council list); its Back action always returns to the pipeline surface.

This is implemented as a **binding**, not a merge: the `Council` record (personas, ledger, deliberation state) remains its own persisted entity, unchanged in shape. A pipeline step opts into it via `CouncilStepConfig.boundCouncilId` — when set, the step's own `councilSetup` is an empty shell and the bound council is the authority for personas/task/config, both in the builder UI (`BoundCouncilStepPanel` replaces the normal step editor) and at validation time (`validateBoundCouncil` checks the live council, not the shell).

Two council shapes predate the pipeline-only UI and both need a pipeline "home" to remain reachable:
- A **standalone single council** gets a generated one-step pipeline (`pipeline/council-migration.ts`, `council-1s-<councilId>`) bound to it.
- A **multi-step council workflow** (councils chained by `workflowId`, §"Multi-Step Council Workflows" below) already projects itself into a shadow pipeline (`workflow-runner.ts`'s `syncWorkflowPipeline`); that pipeline used to be hidden from pipeline listings and is now shown like any other.

`migrateCouncilsToPipelines()` sweeps existing councils once at startup; `ensurePipelineForCouncil()` covers councils created afterward (chat-generated, or created directly from a project). Both are idempotent, so re-running the sweep (or creating the same council's home twice) is a no-op.

### Launch-Time Model Validation (`model-validation.ts`)

Before a council runs, `validateCouncilModels()` (called in `useCouncilHandlers.onFrameProblem`) checks every persona's model against the catalog (`ALL_MODELS`), the probe status (`isModelBroken`), and the set of configured providers. Any model that is unknown (catalog-removed), proven-broken, or points at an unconfigured provider makes the launch **throw a detailed error** (each offending persona's name, model, provider, and reason) so the user fixes their setup deliberately. Routed pseudo-models (`route:*`) are left for `llm-router` to resolve. An earlier version silently substituted a working fallback model and persisted the swap; that was deliberately removed — substitution can route a council to a different (and differently-priced) model than the user picked (see CLAUDE.md rule #18).

### Deliberation Orchestrator (`deliberation-orchestrator.ts`)

A deterministic state machine with well-defined phase transitions:

```
State Machine:
  created -> problem_framing -> round_independent -> round_interactive (loop) -> deciding -> directing -> executing -> reviewing -> complete
                                                                                                               |              |
                                                                                                               +-- revision --+
```

### State Management

The orchestrator maintains:
- `phase` — current phase
- `round` — current round number
- `consultantIndex` — which consultant is active
- `revisionCount` — how many times the worker has revised
- `context` — versioned shared context document
- `decision`, `directive`, `workerOutput` — phase artifacts
- `status` — running, paused, completed, failed

### Agent Prompt Generation (`prompts.ts`)

Each phase has a dedicated prompt builder:

| Phase | Prompt Builder | Inputs |
|-------|---------------|--------|
| problem_framing | `buildManagerFramingPrompt()` | task, criteria, personas |
| round_independent | `buildConsultantAnalysisPrompt()` | context, task, persona predisposition |
| round_interactive | `buildConsultantResponsePrompt()` | context, previous responses, persona |
| deciding | `buildManagerDecisionPrompt()` | all consultant input, criteria |
| directing | `buildManagerDirectivePrompt()` | decision, expected output |
| executing | `buildWorkerExecutionPrompt()` | directive, write permissions |
| reviewing | `buildManagerReviewPrompt()` | worker output, acceptance criteria |

### LLM Adapter (`llm-adapter.ts`)

Routes orchestrator LLM calls to the appropriate provider:

```
callLlm(model, provider, messages, tools?)
  |
  +-- CLI path: callViaCli(messages, model, tools)
  |     |-- council calls are stateless one-shots (no conversationId,
  |     |   no session resume) -> no state shared between personas
  |
  +-- API path: anthropicClient.chat() / openaiClient.chat() / etc.
```

### Worker Work Order, Signals and Ask-Back

Workers receive a typed **work order** (`work-order.ts`) instead of a bare directive: Objective, Deliverable, Acceptance criteria, Directive, Constraints (tool scope), Verification, Attempt (with prior output/feedback/Q&A), Inputs from earlier steps, deduplicated Source material, and a signalling protocol. The executor supplies a per-run `brief` (task, step, run dir, inputs) so workers see the step's own task rather than a lossy summary chain.

Workers answer with parseable signals (`worker-signals.ts`): they can stop with a question (`## NEEDS INPUT`), declare themselves blocked, or report a verification exit code. Questions go through an **ask-back ladder** (`ask-back.ts`): the manager answers if it can, otherwise the question is escalated to the human (the pipeline step is parked as `waiting_approval` with a `pendingInput`, answered in the GUI or at a CLI TTY), otherwise the worker is told to proceed on its best judgment (stating assumptions). Two questions per phase, then a budget answer. A worker that reports itself blocked is never quality-reviewed: the council re-deliberates once, tries a best-effort revision, and then fails honestly (a failed/paused/cancelled council now fails its pipeline step).

**Verify loop.** Workers with write permissions run the step's test command themselves; before any manager review the orchestrator re-runs it (explicit command, then `testCommand`, then auto-detection for file/directory outputs). A failure becomes a mechanical `revise` carrying the test output (no manager/consultant tokens); a pass is reported to the manager as verification evidence. Text-only workers are never given a verify command.

### Context Versioning (`context-store.ts`)

```
ContextStore
  |-- get(councilId) -> { content, version, patches[] }
  |-- propose(councilId, patch) -> stores proposal
  |-- accept(councilId, patchId) -> applies patch, increments version
  |-- reject(councilId, patchId) -> marks rejected, version unchanged
```

### Ledger (`ledger-store.ts`)

Append-only audit trail:

```typescript
interface LedgerEntry {
  id: string;
  councilId: string;
  timestamp: number;
  phase: DeliberationPhase;
  round: number;
  role: DeliberationRole;      // 'manager' | 'consultant' | 'worker' | 'reviewer'
  personaId: string;
  personaName: string;
  entryType: LedgerEntryType;  // 'framing' | 'analysis' | 'response' | 'decision' | ...
  input: string;               // prompt sent
  output: string;              // response received
  durationMs: number;
  tokenCount: number;
  costEstimate: number;
  error?: string;
}
```

Entries are immutable once written. The UI renders them as a timeline.

### Coding Orchestrator (`coding-orchestrator.ts`)

Uses the same LLM adapter and store infrastructure but different phases:

```
decomposing -> (consult) -> implementing -> code_reviewing -> testing -> debugging -> complete
```

Key differences from deliberation:
- **decomposing** produces a module list (files, interfaces, dependencies)
- **consult** (`consultOnPlan`): between decompose and implement, any assigned consultants run an advisory-only pass over the plan (risks, edge cases, better approaches — no code, no tools). Their guidance is fed into the implementation prompt.
- **implementing** uses write permissions by default
- **code_reviewing** uses severity ratings
- **testing** executes actual commands (install, build, test) via `run_command`
- **debugging** is a loop (fix -> test -> check exit code -> repeat)

**Honest completion** (`mergeAndComplete`): the council is marked `failed` (not `completed`) when the worker produced no module output or self-reported being blocked (`looksLikeFailedDeliverable`) — preventing false "completed" runs. The final output artifact begins with a `## Files produced (N)` list derived from real git changes (not the worker's prose), so the output names exactly what was made.

### Worktree Mode (`pipeline/worktree.ts`)

A council or coding step can opt into working on the real repository instead of an isolated scratch directory. The executor owns the git lifecycle; the orchestrators only learn a different working directory.

```
runCouncilStep (codebaseMode: 'worktree')
  |- precondition: pipeline working dir is a git repo top level (else logged fallback to isolated)
  |- exclude .kondi/ in .git/info/exclude
  |- prepareWorktree  --> <repo>/.kondi/worktrees/<run>-<step>  on branch kondi/<pipeline>/<run>
  |- council runs with workDir(council) = worktreePath   (council record untouched)
  |     worker edits in place, never commits
  |     reviewers receive the DIFF (git add -A -N + stat + patch) instead of trusting prose
  |- executor commits (also on failure)  --> write <runDir>/<step>.patch
  '- remove worktree (kept on failure / keepWorktree); branch always kept
```

Why: the change becomes a first-class artifact (branch, base to head, files, diff) that a later script step can merge or open a PR from, and reviewers judge what actually changed. Workers never commit because a sandboxed CLI worker (Codex) cannot write the main repo's `.git` from inside a worktree; the executor, outside the sandbox, does. The step artifact flows downstream as the diff. See SPEC.md §4a-6.

### Chat Front Door (`services/councilRunService.ts`)

The chat can hand a hard task to a council without the user leaving the conversation. The council runs in the background on the normal pipeline runtime; the chat only owns a live card.

```
ChatArea (button / "/council" / intent / "Second opinion" / convene_council tool)
  |- escalateFromChat: post card message, one active escalation per chat
  v
councilRunService.escalate   (React-free, never throws)
  |- thread summary (tool bodies stripped, 6k cap) + task + focus
  |- generateCouncilSetup -> createCouncilFromSetup -> ensurePipelineForCouncil
  v
runner (registered by App = usePipeline.runBackground)
  v
PipelineExecutor  --callbacks (phase, thinking, stream tail)-->  card updates
  v
Message.councilRun patched in place (useChats.handleChatMessagePatch)
  |- result text lands in the card/message; "Open deliberation" -> COUNCIL_OPEN_EVENT -> council view
```

Design points: the service is decoupled from React via the registered runner, so the same code serves UI entry points and the model-driven `convene_council` tool. That tool is deliberately CHAT-ONLY (merged in only at the chat's provider call), so council workers cannot spawn councils recursively. Councils take minutes, so tool timeouts are per tool (`getToolTimeoutMs`) and escalation progress pings `chatActivity` to keep the chat's idle watchdog from killing the call. Because the council gets a home pipeline, it is a normal, reopenable deliberation, not a throwaway. Detail: SPEC section 4a-7.

### Build/Test/Install Detection

```
detectInstallCommand(workingDir):
  pnpm-lock.yaml?  -> "pnpm install"
  yarn.lock?        -> "yarn install"
  package-lock.json? -> "npm install"
  requirements.txt?  -> "pip install -r requirements.txt"
  go.mod?           -> "go mod download"
  Makefile?         -> "make install" (if target exists)

detectBuildCommand(workingDir): similar pattern
detectTestCommand(workingDir): similar pattern
```

### Multi-Step Council Workflows (`workflow-runner.ts`)

Councils sharing a `workflowId` form an ordered chain (the step rail rendered atop the council view). The runner owns SEQUENCING only — each step's actual deliberation still goes through the same launch path (`useCouncilHandlers.onFrameProblem`: model validation, tool preflight, orchestrator choice) as any standalone council.

```
runWorkflowFrom(startCouncilId, { frameProblem, onStepStart }):
  steps = getWorkflowCouncils(startCouncilId)      # ordered chain (workflowId siblings)
  toRun = steps[startIndex .. end]

  for step in toRun:
    clearStepResults(step.id)                      # ledger + artifacts + deliberationState reset
                                                     # (steps BEFORE startIndex are untouched)

  for step in toRun (in order):
    problem = composeStepProblem(step, priorSteps)  # step.savedProblem + previous step's output
                                                     # rendered via step.inputTemplate, +
                                                     # workflow starting input if includePipelineInput
    onStepStart(step)                               # UI follows the active step
    await frameProblem(step, problem)                # normal council launch; throws stop the run
```

Running a step therefore runs it AND everything after it — editing and "Save & Rerun"-ing a step invalidates that step and every step forward of it, while earlier steps keep their results and keep feeding the rerun. The loop lives in `useCouncilHandlers.onRunWorkflow`, not in `DeliberationView`, so it survives the component remounting as the UI navigates between steps mid-run.

`composeStepProblem`/`renderStepInput` render the step's `inputTemplate` through the SAME `renderCoreTemplate` used by the pipeline executor (`pipeline/input-template.ts` — see §7 below), with `indexBase: 1` (rail numbering) and a bare `{{input}}` meaning only the PREVIOUS step's output (the pipeline's `{{input}}` joins ALL previous artifacts).

Navigation: a one-shot `requestCouncilView`/`consumeCouncilView` signal tells `DeliberationView` to open a step in view mode (its deliberation) instead of auto-opening the setup/edit screen — needed because `deliberationState` isn't persisted to disk, so every council reads phase `'created'` after a restart; auto-setup now additionally requires `status !== 'resolved'` and no saved problem before it will hijack into the edit screen.

---

## 7. Pipeline Execution Engine

### Pipeline Types (`pipeline/types.ts`)

```typescript
interface Pipeline {
  id: string;
  name: string;
  stages: PipelineStage[];
  status: 'draft' | 'running' | 'completed' | 'failed';
}

interface PipelineStage {
  id: string;
  name: string;
  steps: PipelineStep[];
}

interface PipelineStep {
  id: string;
  name: string;
  config: StepConfig;  // StepConfig.type determines the step type
  status: 'pending' | 'running' | 'completed' | 'failed' | 'waiting_approval' | 'skipped';
  artifact?: StepArtifact;
}

// Step types: 'council' | 'code_planning' | 'analysis' | 'agent' | 'coding' | 'review' | 'enrich' | 'gate' | 'script' | 'condition'

interface StepArtifact {
  stepId: string;
  content: string;
  artifactType: 'decision' | 'output' | 'llm_response' | 'approval';
  metadata?: {
    outputType?: 'string' | 'file' | 'directory' | 'json';
    outputPath?: string;
    councilId?: string;
    model?: string;
    tokensUsed?: number;
    stepName?: string;
    stepType?: string;
  };
}
```

### Executor (`pipeline/executor.ts`)

```
PipelineExecutor.run(pipeline):
  for each stage (sequential):
    for each step in stage (parallel where independent):
      switch step.config.type:
        'council':       create council, run deliberation orchestrator (full tools)
        'code_planning': create council, run deliberation orchestrator (PLAN_TOOLS)
        'coding':        create council, run coding orchestrator
        'review':        create council, run deliberation orchestrator
        'enrich':        create council, run deliberation orchestrator
        'analysis':      create council, run deliberation orchestrator (same workflow; manager-only by default — decision IS the output)
        'agent':         create council, run deliberation orchestrator (same workflow; worker-only by default — single tool-using pass)
        'gate':          pause, wait for human approval
        'script':        run shell command, capture stdout
        'condition':     evaluate expression -> continue / skip_next_stage / stop / loop_to_stage (bounded)

      store artifact with provenance
      render input template for downstream steps
```

### Input Template Rendering

The core `{{input}}`/`{{file}}`/JSON-path substitutions live in `pipeline/input-template.ts` (`renderCoreTemplate`, `resolveJsonPath`, `extractJsonBlock`) — shared with the council workflow-runner (§6) so pipeline steps and workflow steps can't drift apart on template semantics. `pipeline/executor.ts`'s `renderInputTemplate` delegates to it with `indexBase: 0` and layers its own provenance headers + `{{memory.*}}` substitution on top.

```
renderTemplate("{{input}}", artifacts):
  -> joins all previous artifacts with provenance headers

renderTemplate("{{input[0]}}", artifacts):
  -> returns first artifact

resolveJsonPath(content, "field.path"):
  -> JSON.parse(content) and walk the path
  -> falls back to extractJsonBlock(content) first if content isn't itself valid JSON
     (recovers from prose/```json-fence-wrapped responses)

Provenance header format:
  [Source: Step Name (step_type)]
  [Output type: string|file|directory]
  [Output path: /path] (if applicable)
  IMPORTANT: This output came from a previous pipeline step...
```

### Abort Handling

`PipelineExecutor.abort()`:
1. Aborts the run-level `AbortController` (`runAbort`). Its signal reaches both orchestrators and races pending gate/question prompts.
2. Marks the pipeline and all running (and `waiting_approval`) steps as `failed` ("Aborted by user").
3. In-flight LLM calls actually stop: each call gets `anySignal([run signal, timeout])`, which the clients honour (SDK request abort; between tool turns for the buffered Anthropic/Gemini transports; for the Claude CLI the `cancel_claude_streaming` Tauri command kills the child process). The orchestrator also races the signal so a transport that ignores it cannot hang the run.
4. The council ends in the `cancelled` phase with a `cancellation` ledger entry (not `failed`, no error entry); aborted runs write no scorecard. Timeouts are different: retried once, then a normal failure.

**Budget breaches are not aborts.** `Pipeline.settings.budget` (USD / tokens / minutes) is tracked by a per-run `BudgetMeter` wrapped around every agent call. Exceeding it fails the breaching step honestly (error entry, `failed` phase), skips the remaining stages, and still writes the scorecard. `finish_call` lets the current call complete; `abort_now` cancels in-flight calls through the same run signal, with the budget error as the reason so it is never mistaken for a user abort. Every persona sees a one-line budget status in its prompt.

### Live Streaming Path

Display only, never the source of results:

```
client (SSE deltas / claude stream-json lines via Channel)
  -> llm-router onEvent -> gui-caller -> AgentInvocation.onEvent
  -> orchestrator onAgentEvent(persona, event, context)
  -> PipelineExecutorCallbacks.onAgentEvent -> useCouncilHandlers tail map (throttled)
  -> DeliberationView ".thinking-stream"
```

The Claude CLI is run with `--include-partial-messages` when a listener is attached, and Rust forwards each stdout line over a Tauri channel; `createStreamJsonAccumulator` turns lines into text / tool-call / tool-result events. The final answer is still parsed from the full output. The CLI runner prints tool calls live instead of a tail.

---

## 8. Storage Architecture

### CouncilDataStore (`council/storage-cleanup.ts`)

All council, pipeline, ledger, and context data routes through `CouncilDataStore` — an in-memory `Map<string,string>` with no size limit. The Map is the primary authority; it is backed by two mirrors: a best-effort `localStorage` cache (for same-session UI observation, quota errors silently ignored) and a **durable disk mirror** that has no quota.

- `getItem(key)`: checks in-memory Map first, falls back to localStorage (promotes to Map on hit)
- `setItem(key, value)`: always succeeds in Map; localStorage write is try/catch silenced; full value is queued to disk
- `setItemDurable(key, value, slim)`: full value to Map + disk; localStorage gets the full value if it fits, else the `slim()` value (used for definitions like councils/pipelines so they survive restart even when live data has pushed the localStorage blob past ~5 MB)
- `setItemPersistent(key, value)`: same as setItem but throws on localStorage failure for data that must survive restarts (pipeline configs)
- `removeItem(key)`: removes from Map, localStorage, and disk

**Stores using `councilDataStore`**: `context-store.ts`, `ledger-store.ts`, `council/store.ts`, `pipeline/store.ts`, `session-import.ts`.

### Durable Disk Mirror

On a restart the in-memory Map starts empty, so without a durable backstop any council whose full output (ledger chunks, deliberation state) didn't fit in the ~5 MB localStorage cache would be gone. The disk mirror holds the FULL value for every council key:

- **Location**: `<dataDir>/council-store/<hex(key)>.kv` (default `~/.local/share/kondi/council-store` on Linux). Each key is hex-encoded into a decodable `.kv` filename. The directory is user-configurable (Settings → General → "Council Deliberation Store", persisted in localStorage `kondi-council-store-dir`); changing it migrates the in-memory data to the new directory.
- **Writes** are debounced (250 ms, last-value-wins) and flushed to disk via the `write_local_file`/`delete_local_file` Tauri commands. `flushDisk()` is public so callers can force durability.
- **Hydration**: `hydrateFromDisk()` is awaited in `main.tsx` BEFORE the first React render, so councils and their full deliberation are present on reopen. It also performs a one-time migration of any pre-existing localStorage-only council data onto disk. If Tauri/disk is unavailable it falls back to localStorage-only.

This durable store (auto-reload of the full deliberation) is distinct from a council's "save deliberation" export (`deliberationSaveService.ts`), which writes human-readable markdown to `<workingDir>/.kondi/outputs/<name>_<timestamp>/` in `full` or `abbreviated` mode.

### Primary Stores

| Store | Backend | Key Pattern | Notes |
|-------|---------|-------------|-------|
| Chat history | Tauri file + localStorage | `mcp-chats` | Tauri primary, localStorage backup |
| Council definitions | CouncilDataStore | `mcp-councils` | JSON array of council objects |
| Ledger entries | CouncilDataStore | `kondi-ledger-{councilId}` | Append-only, per-council, chunked |
| Context artifacts | CouncilDataStore | `kondi-context-{councilId}` | Versioned, per-council |
| Pipeline definitions | CouncilDataStore (persistent) | `mcp-pipelines` (version 5) | JSON array of pipeline objects |
| Council durable mirror | Filesystem | `<dataDir>/council-store/<hex>.kv` | Full council/ledger/context per key; survives restart |
| Provider config | localStorage | `kondi-provider-*` | Keys, models, defaults |
| Chat working dirs | localStorage | `kondi-chat-working-dirs` | JSON object: chatId -> path |
| MCP servers | localStorage | (MCPClient internal) | Server configs with metadata |
| OAuth tokens | Filesystem | `~/.local/share/kondi/proxies/{id}.json` | Per-proxy config files |

### Quota Management

The in-memory CouncilDataStore prevents localStorage's ~5 MB limit from crashing pipelines. After each pipeline step completes, `stripCompletedCouncil(councilId)` trims only the localStorage copy of the `mcp-councils` entry. The authoritative data (ledger, context, decisions) remains in memory for the rest of the session. No deliberation data is ever destroyed.

### Chat Persistence

Chats are saved with content optimization:
- File attachment contents are stripped (only metadata kept)
- Messages over 10,000 characters are truncated
- Maximum 20 chats retained (oldest pruned)
- If total data exceeds 4 MB, the chat list is trimmed to 50%

---

## 9. CLI Pipeline Runner

### Architecture

```
cli/run-pipeline.ts
  |-- loads pipeline JSON
  |-- creates PlatformAdapter (Node.js fs, child_process)
  |-- creates localStorage shim (in-memory)
  |-- initializes same orchestrators as GUI
  |-- routes LLM calls:
       |
       +-- isOpenAIModel(model)?
       |     yes -> cli/codex-caller.ts
       |     no  -> cli/claude-caller.ts
       |
       +-- claude-caller.ts:
       |     spawns: claude --print --verbose --output-format stream-json
       |     pipes prompt via stdin
       |     env: CLAUDECODE=undefined
       |
       +-- codex-caller.ts:
             spawns: codex exec --json
             pipes prompt via stdin
```

### API Providers and the Agent Runtime

For API providers (`anthropic-api`, `openai-api`, `deepseek`, `xai`, `zai`, `moonshot`, `nvidia-router`, `ollama`), `cli/llm-caller.ts` calls `cli/api-tool-caller.ts`, which runs the provider-neutral tool loop from `src/agent-runtime/` (`runToolLoop` + OpenAI-compatible or Anthropic streaming adapter) with four Node local tools (scoped by the orchestrator's abstract allowed tools: Read/Write/Edit/Bash/Glob/Grep map onto them). Paths are realpath-contained: reads and writes outside the working directory are denied, and Bash commands follow rules equivalent to the Claude PreToolUse guard. Headless pipelines on API models can therefore read and write files in the working directory with real token usage. The abort/timeout primitives (`AbortError`, `TimeoutError`, `anySignal`) live in the same package. `llm-router` remains the only completion entry point in the GUI.

### Session Persistence

Within a council step, persona sessions are tracked via `personaSessionIds` Map. This allows resume within the same step but prevents session sharing across different personas.

Sessions are cleared on new council/step boundaries.

### Critical Implementation Details

- `--allowedTools` is variadic — prompt MUST be piped via stdin, never as positional arg
- `--print` is required for both new and resume paths (without it, CLI runs interactive mode)
- `--verbose` is required when using `--output-format stream-json`
- `CLAUDECODE=undefined` must be set in env to prevent nested CLI conflicts
- Codex resume: `codex exec resume <thread_id>` — no `--sandbox`/`--full-auto` flags on resume

---

## 10. Built-in MCP Servers

### Registration (`builtinServers.ts`)

```typescript
interface BuiltinDef {
  id: string;          // e.g., 'kondi-x'
  name: string;        // e.g., 'X / Twitter'
  pkg: string;         // e.g., 'kondi-x-mcp'
  description: string;
  envKey: string;      // e.g., 'KONDI_X_BEARER_TOKEN'
  icon: string;        // emoji
}
```

At startup, `registerBuiltinServers()` creates an `MCPServer` config for each:
- Transport: `stdio`
- Type: `github_mcp_local`
- Status: `disconnected`
- Metadata: `{ builtin: true, managed: true, manifest: { run: { env: { [envKey]: '' } } } }`

### Server Architecture

Each `kondi-*-mcp` package follows the same pattern:

```
kondi-{platform}-mcp/
  src/
    index.ts       # Server entry point, registers all tools
    client.ts      # Platform API client (HTTP or child_process)
    config.ts      # Configuration (env vars, defaults, port)
    types.ts       # TypeScript types for API responses
    tools/
      {tool-name}.ts  # One file per tool, exports register function
```

### Tool Registration Pattern

```typescript
// tools/some-tool.ts
export function registerSomeTool(server: McpServer, config: Config): void {
  server.tool(
    'tool_name',
    'Human-readable description',
    {
      param1: z.string().describe('What this parameter does'),
      param2: z.number().optional().describe('Optional parameter'),
    },
    async ({ param1, param2 }) => {
      const client = new PlatformClient(config);
      const result = await client.someMethod(param1, param2);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
```

### Credential Flow

1. User enters token in Tools panel credential input
2. Value stored in `server.metadata.manifest.run.env[envKey]`
3. On connect, `connectServer()` reads env from manifest
4. Rust backend spawns stdio process with the env var set
5. Server's `config.ts` reads the env var to configure the API client

---

## 11. Design Decisions

### Why Deterministic Orchestration?

Non-deterministic multi-agent systems produce unpredictable results. Kondi's deliberation orchestrator is a state machine with well-defined phase transitions. Every phase has explicit entry/exit conditions, and the audit trail records exactly what happened. This makes results reproducible and debuggable.

### Why Mixed Models?

Different models have different strengths. Claude excels at nuanced reasoning, GPT at code generation, Gemini at multimodal tasks. By letting each persona use a different model, councils leverage the best of each provider rather than being limited to one model's capabilities.

### Why CLI + API Dual Paths?

CLI tools (Claude Code, Codex, Gemini CLI) provide access to models not available via API (Opus 4.6, GPT-5.5 Codex) and use existing subscriptions. API keys provide direct access without CLI installation. Supporting both maximizes model availability and lets users choose based on their existing setup.

### Why Local-First?

API keys and OAuth tokens are sensitive. Kondi stores everything on the user's machine — no cloud accounts, no telemetry, no data leaving the device except direct API calls to the LLM providers the user has explicitly configured. The Tauri/Rust backend provides OS-level file encryption and process isolation.

### Why Per-Server Proxies?

Each OAuth MCP server has different token lifecycle requirements (refresh intervals, scopes, dynamic registration). A per-server proxy isolates these concerns and prevents one server's auth failure from affecting others.

### Why Append-Only Ledger?

Deliberation decisions need accountability. The append-only ledger ensures nothing can be retroactively modified — every agent invocation, every context patch, every phase transition is permanently recorded. This is critical for understanding why a council reached a particular decision.

### Why Context Versioning?

In multi-agent deliberation, the shared context evolves as consultants contribute. Versioning (with explicit accept/reject by the manager) creates a controlled evolution path rather than chaotic concurrent edits. The full version history shows how understanding developed.

### Why Template-Based Artifact Flow?

Pipelines need to pass context between steps without coupling step implementations. Template variables (`{{input}}`, `{{input[0]}}`) provide a clean interface. Provenance headers ensure downstream steps understand the source and type of each artifact, enabling more informed processing.

### Why Quota Recovery?

localStorage's ~5 MB limit is a hard constraint. Multi-council sessions with detailed ledgers can hit it quickly. Rather than failing opaquely, Kondi proactively manages storage by cleaning up old data. This keeps the app functional during long sessions without requiring user intervention.

---

## 12. Self-Improvement Loop

Kondi can measure every pipeline run and, optionally, learn from it. The subsystem lives in `mcp-connect-mvp/src/improve/` and is specified in detail in SPEC.md §4f; this section explains the shape and the reasons.

### Two layers

```
PipelineExecutor (every completed/failed run)
  |-- finishRunHook
  |     |-- buildRunScorecard  (from council ledgers; no LLM)  --> improve store, _scorecard.json, scorecards JSONL
  |     '-- if selfImprove.enabled --> runImprovementCycle
  |                                      retrospective council --> proposals (+ lessons)
  |                                      optional eval (replay + judge)
  |                                      auto-apply  OR  queue for approval
  '-- next run: lessons bundle --> orchestrators --> every persona prompt
```

1. **Measurement is always on** and costs no model calls. Each ledger entry now records the concrete model, token split, retry count, and whether the persona was routed, so a scorecard can attribute cost, latency, revisions and errors to a specific seat and model even when a `route:*` persona resolved to different models per call. Scorecards also give users trends without enabling anything else.
2. **Improvement is opt-in** per pipeline (`Pipeline.settings.selfImprove`). After a run, a retrospective reads the scorecard plus ledger evidence and proposes concrete, cited recipe edits and distilled lessons.

### Why these choices

- **The retrospective is an ordinary council.** It reuses the factory, orchestrator, ledger and drill-in view, so a user can open the retrospective and read the reasoning. It is tagged with the pipeline id so it has a home and never appears as an orphan, and old ones are pruned.
- **Replay never uses a second executor.** To score a proposal, the affected step is re-run on its recorded input (captured per step as a `StepInputRecord`) using the factory plus the deliberation orchestrator directly, tool-less and without a working directory. A second `PipelineExecutor` would create run directories, library entries, memory entries and file writes; going straight to the orchestrator keeps evaluation side-effect free. A blind, position-swapped judge compares the old and new outputs so position bias cancels out; disagreement is neutral. Steps that cannot be replayed safely (coding steps, bound councils) fall back to a cheaper judge-only rating.
- **Approval never blocks a run.** In manual mode, proposals simply wait in the Improvements panel (or CLI review); the run and the CLI process finish normally, and unattended or scheduled runs can never approve anything. In auto mode the mode is re-read at the moment of each apply, so a user can switch back to manual while a cycle is in flight.
- **Edits are guarded against drift.** Each proposal pins the hash of the thing it changes. Applying refuses if the target moved, except when the exact field still holds the value the proposal was computed from (so several proposals from one retrospective can all land). The post-apply hash lets revert refuse rather than clobber later edits. Unbound steps are re-validated by the builder's own validator before saving; bound councils go through the council store's schema validation.
- **Lessons live at the orchestrator level.** Lessons are short operating notes, not recipe edits. They are appended to each persona's prompt at call time, role-scoped, rather than written into step or council definitions. That makes them work uniformly for bound councils (whose records must not be mutated per run) and keeps them cheap to mute or revert. They are also mirrored to the memory directory as a superset of the existing patterns file, so the existing memory template keeps working.

### Seat self-view

Besides lessons, each seat sees its own track record. The scorecard keeps why a step's work was sent back (`reviewFeedback`); on later runs, once a step has at least two prior scorecards and lessons are enabled, the executor derives a short per-role brief (first-try acceptance, average revisions, recurring reviewer objections) and the orchestrators place it in the worker's work order and, for the manager, only in the directive call. This keeps the feedback loop inside the prompt path with no recipe edits (SPEC.md §4a-1).

### Surfaces

The GUI exposes a run-metrics strip in the results view and an Improvements panel in the builder. The CLI exposes `kondi improve` and `kondi pipeline --improve`. All of them share the same cycle and apply code; only the LLM invoker and platform adapter differ.

### Current limits

Coding steps and bound councils are judge-only. Model-swap proposals are off by default and do not yet re-run launch-time model validation. Router-profile and structural proposals are parsed but not applicable yet.
