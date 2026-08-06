# Kondi Project Specification

> Machine-readable living spec. Single source of truth for current types, defaults, keys, and flags.
> For architectural rationale and deep "why" explanations, see `ARCHITECTURE.md`.
>
> **Last updated:** 2026-08-05

---

## 1. Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Tauri 2.x (Rust backend) |
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS |
| State | In-memory `CouncilDataStore` (primary) + localStorage (cache) + React hooks |
| LLM access | Unified router → API clients (HTTP) + CLI binary proxies (Claude, Codex) |
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
      step-validation.ts         # Pre-run validation — per-step problems, run gate (§5a-6)
      input-template.ts          # Shared {{input}}/{{file}} template rendering (§5a-2)
      output-parsers.ts          # isOpenAIModel(), stream-json parsing
    council/
      types.ts                   # Phases, entry types, roles, modes, artifacts
      factory.ts                 # createCouncilFromSetup() — default values
      store.ts                   # Council localStorage store (key: mcp-councils)
      context-store.ts           # Per-council artifact CRUD (context, decision, plan, directive, outputs)
      ledger-store.ts            # Chunked ledger storage (ledger-index-{id}, ledger-chunk-{id}-{n})
      deliberation-orchestrator.ts  # Deliberation state machine
      coding-orchestrator.ts     # Coding workflow state machine
      llm-adapter.ts             # Thin wrapper — delegates to llm-router.ts
      prompts.ts                 # Prompt construction for all roles and step types
      validation.ts              # LLM output parsing/validation
    config/
      models.ts                  # ModelProvider type, all model definitions
    services/
      llm-router.ts              # Unified LLM router — ALL completions dispatch through here
      claudeCliClient.ts         # anthropic-cli: spawns `claude --print` with --resume sessions
      codexCliClient.ts          # openai-cli: spawns `codex exec --json` with resume sessions
      anthropicClient.ts         # anthropic-api: direct HTTP to api.anthropic.com
      openaiClient.ts            # openai-api: direct HTTP to api.openai.com
      codexClient.ts             # Legacy Codex HTTP client (validation only)
      geminiClient.ts            # Google Gemini API client
      openaiCompatibleClient.ts  # DeepSeek, xAI, Ollama (OpenAI-compatible)
      mcpClient.ts               # MCP server connection + proxy management
      proxyService.ts            # MCP proxy lifecycle (start/stop/sync to CLI configs)
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
| `openai-cli` | Subscription | Codex | gpt-5.5 (default), gpt-5.5-pro, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, gpt-5.3-codex, gpt-5.2-codex |
| `deepseek` | API key | — | deepseek-v4-pro (default), deepseek-v4-flash |
| `google` | API key | — | gemini-2.5-pro, gemini-2.5-flash |
| `xai` | API key | — | grok-3, grok-3-mini |
| `zai` | API key | — | glm-5.1, glm-4.6, glm-4.5-flash (Z.AI Coding Plan, OpenAI-compatible) |
| `moonshot` | API key | — | Moonshot AI (Kimi) — `https://api.moonshot.ai/v1`; kimi-k2.6 (default, featured, vision), kimi-k2.7-code, kimi-k3 (1M ctx flagship) (OpenAI-compatible; full CORS, no relay needed) |
| `nvidia-router` | API key | — | NVIDIA NIM — hosted at `https://integrate.api.nvidia.com/v1` by default; `nvidia/nemotron-3-super-120b-a12b` (default), `nvidia/nemotron-3-ultra-550b-a55b`, `deepseek-ai/deepseek-v4-pro`, `z-ai/glm-5.2`, `nvidia/llama-3.3-nemotron-super-49b-v1.5`, `openai/gpt-oss-120b`, `nvidia/nemotron-3-nano-30b-a3b` (OpenAI-compatible; base URL overridable via `VITE_NVIDIA_ROUTER_URL` / `NVIDIA_ROUTER_URL` for a local NIM/router deployment) |
| `ollama` | Local | — | llama3.1, qwen2.5-coder, mistral |
| `router` (pseudo) | — | — | Smart Routing profiles: model id `route:<profile>` (see §3a) |

Legacy provider names (`anthropic`, `openai`) are resolved via `resolveProvider()` in `config/models.ts`. `zai`/`moonshot`/`nvidia-router` dispatch through the shared `OpenAICompatibleClient` (`openaiCompatibleClient.ts`), like deepseek/xai/ollama.

Type: `ModelProvider = 'anthropic-api' | 'anthropic-cli' | 'openai-api' | 'openai-cli' | 'deepseek' | 'google' | 'xai' | 'zai' | 'moonshot' | 'nvidia-router' | 'ollama'`

`ModelDefinition` gained an optional `routingCapabilities?: string[]` field — richer capability tags (`planning`, `coding`, `fast-coding`, `code-review`, `summarization`, …) consumed by the Smart Router; the registry derives them from `capabilities` + `tier` when absent.

`openai-cli` / `CODEX_MODELS` model IDs are kept current against the installed Codex binary (verified v0.139.0). `codex update` may bump the set; refresh `OPENAI_CLI_MODELS` (`config/models.ts`) and `CODEX_MODELS` (`codexClient.ts`) when it does. The stale `gpt-5.1`, `gpt-5.1-codex-max`, and `gpt-5.1-codex-mini` SKUs were removed from the catalog, the Codex client list, and the CLI→API fallback map; all council/pipeline defaults that pointed at `gpt-5.1-codex-max` (CouncilLibrary, StepConfigPanel, templates) now point at `gpt-5.5`.

`MOONSHOT_MODELS` (`config/models.ts`) holds 3 models per the platform.kimi.ai docs (2026-07): `kimi-k2.6` (default, featured, vision), `kimi-k2.7-code` (+ highspeed coding), `kimi-k3` (1M-token-context flagship). The legacy `moonshot-v1` SKUs are not in the catalog and sunset 2026-08-31 per Moonshot's own deprecation notice. `moonshotClient` (`openaiCompatibleClient.ts`) hits `https://api.moonshot.ai/v1` directly — it has full CORS support, so unlike NVIDIA NIM it needs no `http_relay_stream` detour.

`NVIDIA_MODELS` (`config/models.ts`) holds 7 curated models, verified live against `GET https://integrate.api.nvidia.com/v1/models` and tested through the app's real request shape (streaming, with and without tools): `nvidia/nemotron-3-super-120b-a12b` (default, featured), `nvidia/nemotron-3-ultra-550b-a55b` (featured), `deepseek-ai/deepseek-v4-pro`, `z-ai/glm-5.2`, `nvidia/llama-3.3-nemotron-super-49b-v1.5`, `openai/gpt-oss-120b`, `nvidia/nemotron-3-nano-30b-a3b`. All carry 0 cost rates + `costDisplay: 'NIM'` (NVIDIA API keys are credit-based, not per-token USD). Deliberately excluded despite appearing in the live `/models` list (verified broken 2026-07): `moonshotai/kimi-k2.6` (404 "Function not found"), `meta/llama-4-maverick-17b-128e-instruct` (request hangs), `qwen/qwen3.5-397b-a17b` (hangs on any real completion, streaming or non-streaming — tiny probes pass), `minimaxai/minimax-m3` (non-streaming works but streaming returns an instant "Internal server error", and chat always streams). Listed-but-broken is common on NIM: test STREAMING with real token counts before adding a model. The `nvidiaRouterClient` (`services/openaiCompatibleClient.ts`) and the CLI `nvidia-router` path (`cli/llm-caller.ts`) default to the hosted `https://integrate.api.nvidia.com/v1` (was a local `http://localhost:8001/v1` router); `VITE_NVIDIA_ROUTER_URL` (webview) / `NVIDIA_ROUTER_URL` (CLI) still override for a local NIM/router deployment. Provider display label is "NVIDIA NIM" (was "NVIDIA Router") in `useProviderConfig.ts`, `RoleAssignment.tsx`, and `ChatArea.tsx`; the short label "NVIDIA" is unchanged. NIM's API sends no CORS headers (Z.AI/DeepSeek do), so the webview cannot call it directly — webview NIM requests route through the `http_relay_stream` Tauri command (Rust reqwest, HTTPS-only), which streams response bytes over an IPC channel as they arrive; `relayFetch` in `openaiCompatibleClient.ts` adapts the channel to a fetch `Response` for the OpenAI SDK (`relayViaBackend` client flag, set only for the hosted NIM URL). A buffered variant (`http_relay`) exists for one-shot use but must NOT be used for chat: buffering the full body trips the 90s no-first-byte watchdog on long generations. The CLI path calls NIM directly (Node has no CORS). Default model for `nvidia-router` (`DEFAULT_MODELS` in `llm-router.ts` and `cli/llm-caller.ts`) is `nvidia/nemotron-3-super-120b-a12b`.

### 3b. Model Availability Probe (`src/services/modelProbe.ts`)

Per-model availability tracking so dropdowns never offer a model the account/plan can't use (e.g. a ChatGPT Codex account rejecting `gpt-5.3-codex`). Status persists in localStorage `kondi-model-status` (`{ [modelId]: { status: 'ok'|'broken'|'soft-fail'|'untested', error?, checkedAt } }`).

- **Policy — hide only proven-broken.** `filterVisibleModels()` drops a model ONLY when its status is `broken`. Untested, last-known-good, and soft-failed (auth/network) models stay visible. `classifyModelError()` maps an error to `broken` (model not supported/found/invalid, 404, 400-with-"model"), `auth` (401/403/credentials → blame the provider, not the model), or `soft` (timeout/network/429 → keep).
- **Trigger 1 — automatic.** `chatCompletion()` wraps its dispatch; on throw it calls `recordModelCallFailure(model, prov, err)` (hides the model iff the error is `broken`), and on success `recordModelCallSuccess(model)` clears a stale flag.
- **Trigger 2 — manual.** "Refresh models" button in `ProviderSettings` → `probeAllModels()` sweeps every configured-provider model with a tiny one-shot `simpleCompletion` (concurrency 4, skips the `router` pseudo-provider), shows progress + an ok/hidden/unverified summary.
- **UI binding.** Selectors call `filterVisibleModels()` and subscribe via `useModelStatus()` (a `useSyncExternalStore` hook): `ChatArea`, `AddPersonaModal`, `RoleAssignment`. The pipeline persona picker reuses `AddPersonaModal`. The catalog in `config/models.ts` is never mutated.

### 3c. Model Catalog Sync (`src/services/modelCatalogSync.ts`)

The API-side equivalent of reading the Codex binary's model list: for API providers, the authoritative model set is the provider's own `GET /models`. The "Refresh models" button runs this alongside the probe — `syncAllCatalogs(providers)` fetches each discoverable provider's live list (via the clients' existing `listModels()` / Ollama `discoverModels()`) and reconciles vs the catalog into `CatalogDiff { confirmed, staleInCatalog, missingFromCatalog }`, persisted to `kondi-catalog-sync`.

- **Discoverable providers:** `anthropic-api`, `openai-api`, `deepseek`, `xai`, `zai`, `moonshot`, `nvidia-router`, `ollama`. Google (cloudcode-pa OAuth) and CLI providers are excluded (no clean public list; verified via binary + probe instead).
- **Advisory only.** It surfaces drift (catalog IDs the API no longer lists; chat-capable IDs the API offers that we don't carry — filtered against a `NON_CHAT` regex to cut embeddings/tts/image/etc. noise) but never hides a model itself. `/models` lists can be incomplete (restricted key scopes, partial catalogs), so the live probe remains the sole authority for hiding. Anthropic/OpenAI keys resolve via `resolveApiKey(provider, PROFILE_IDS.*ApiKey)`; OpenAI-compatible clients use their own configured key.

### 3d. Launch-Time Model Validation (`src/council/model-validation.ts`)

A pre-flight that validates a council's persona models BEFORE the deliberation/coding workflow starts (runs in `useCouncilHandlers.ts` `onFrameProblem`, for both orchestrator paths). `validateCouncilModels(council, configuredProviders)` **throws a detailed `Error`** if any persona model is **unknown** (removed from `ALL_MODELS` after a catalog/codex update), **proven-broken** (`modelProbe.isModelBroken`, §3b), OR whose **provider isn't configured**. The error enumerates each offending persona (name, model, provider, reason) so the user can correct their setup deliberately. Routed pseudo-models (`provider:'router'` / `model:'route:*'`) are left as-is (resolved later in `llm-router`, §3a). **It does NOT substitute** — an earlier version swapped unusable models for a cheap working fallback, but silent substitution can route a council to a different (and differently-priced) model than the user selected, so validation now surfaces the problem and blocks the launch instead. This still prevents a template persona hardcoded to e.g. `openai-api` from crashing a council mid-deliberation on a machine that only has Gemini configured — it just fails fast at launch with a clear, actionable error rather than reassigning the model.

### 3a. Smart Router (`src/router/`)

Ported from kondi-chat (de-Node-ified: seeds in-memory from `ALL_MODELS`, no fs; the intent classifier call is injected and runs through `simpleCompletion`, never a raw fetch — preserves OAuth/MCP-proxy routing). Surfaces seven budget profiles (`balanced`, `quality`, `cheap`, `orchestra`, `best-value`, `zai`, `nvidia`) as selectable pseudo-models `route:<profile>` in every model dropdown (`ROUTED_PROFILE_OPTIONS`); order fixed by `PROFILE_ORDER`.

The `nvidia` profile is single-provider (`allowedProviders: ['nvidia-router']`), all NVIDIA NIM: dispatch → `nvidia/nemotron-3-ultra-550b-a55b`, discuss → `nvidia/nemotron-3-super-120b-a12b`, execute → `z-ai/glm-5.2`, reflect → `deepseek-ai/deepseek-v4-pro`, compress/state_update → `nvidia/nemotron-3-nano-30b-a3b`. Budget numbers (`contextBudget`, `maxIterations`, `loopCostCap`, etc.) mirror the `zai` profile.

- **Selection**: a persona/step/chat with `provider:'router'`, `model:'route:<name>'` flows into `llm-router.ts`, which calls `resolveRoutedModel(profile, phase, prompt)` → concrete `{provider, model}`, then dispatches normally.
- **Phase hint** (`routePhase`, type `LedgerPhase`): threaded from call sites. Council role → phase via `roleToPhase()`: manager→`dispatch`, consultant→`discuss`, worker→`execute`, reviewer→`reflect`; chat defaults to `discuss`. Persona role read from `persona.preferredDeliberationRole`.
- **Tiers** (in `router/index.ts`): profile pin (`rolePinning[phase]`) → intent classifier (cheap LLM picks per phase) → rule fallback (capability/cost heuristics). The learned NN tier from kondi-chat is **not** ported (needs offline-trained weights).
- **Files**: `router/{types,registry,profiles,rules,intent-router,index}.ts` (core), `router/profile-options.ts` (pure helpers, CLI/selector-safe), `router/resolve.ts` (webview resolution via simpleCompletion + auth-profiles). CLI routing lives in `cli/llm-caller.ts` (own resolution, classifier recurses through the CLI caller).
- **Cost**: `services/cost.ts` estimates per-entry/total USD from ledger `tokensUsed` + `getModelCostRates` (blended rate; routed entries are approximate since the concrete model isn't recorded on the ledger). Shown in `DeliberationView` agent breakdown.

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

**Worker directives are re-grounded in the original source material.** The manager's directive reaching the worker is two lossy summarization hops from the step's actual input (input → framing → decision → directive); a worker with nothing else to go on can invent details a trimmed-down directive dropped (observed: a final brief step contradicting the upstream decision). `runFullDeliberation` persists the raw problem via `councilStore.setSavedProblem(councilId, problem)` (`store.ts`) right after its fresh-store fetch, overwriting `deliberation.savedProblem` with the problem this run was actually started with. The private helper `groundInSource(council, directiveContent)` then appends `deliberation.savedProblem` (capped at 24000 chars) to the directive as an "ORIGINAL TASK & SOURCE MATERIAL (authoritative...)" block — applied in `executeWork` (before subagent fan-out) and in the worker revision path (`buildWorkerRevisionPrompt`'s first argument).

### 4b. Coding Orchestrator

Extends the deliberation lifecycle with code-specific phases:
```
created → decomposing → (consultant advisory) → implementing → code_reviewing →
testing → (debugging loop or) completed | failed
```

Additional entry types: `decomposition`, `module_directive`, `module_output`, `code_review`, `test_result`, `debug_fix`

**Respects consultants.** Between decompose and implement, `consultOnPlan()` runs an advisory pass: each assigned consultant reviews the decomposed plan with NO tools (recorded as a consultant `analysis` entry under the `decomposing` phase) and their guidance is folded into the implementation spec. No consultants → no-op. (Previously the coding flow skipped consultant deliberation entirely.)

**Honest completion + files manifest.** `mergeAndComplete()` marks the council phase `failed` (a mapped terminal phase, in the `validNext` of `implementing`/`code_reviewing`/`testing`/`debugging`) instead of `completed` when there are ZERO module outputs OR the merged output is self-reported blockage (`looksLikeFailedDeliverable` — 2+ strong failure markers AND body <4000 chars). So a worker that narrates being blocked (sandbox/tooling/filesystem) yields a FAILED council, not a false success. The output artifact + completion summary both begin with a `## Files produced (N)` section listing the worker's ACTUAL changed files from `git status --porcelain` (`listChangedFiles`), not its prose. `createGitSnapshot` compares `git rev-parse --show-toplevel` against the working dir (trailing-slash-normalized) and `git init`s the working dir as its OWN repo (+ a local git identity) unless it's already the top-level, so both snapshot/rollback and the post-run diff work (matches the CLI path, §7 gotcha 6; see §10 gotcha 22 for why the check is a toplevel comparison and not a bare `is-inside-work-tree` test); `ensureWorkspaceDir` pre-creates `<workingDir>/.kondi/workspace` via the Tauri backend (outside the CLI sandbox) before the worker runs.

**UI parity requirement:** All `Record<Phase, ...>` and `Record<EntryType, ...>` maps in UI components MUST include entries for BOTH orchestrators. Missing entries crash the React tree (no error boundary). Affected files: `PhaseIndicator.tsx`, `LedgerEntryCard.tsx`, `LedgerTimeline.tsx`, `DeliberationView.tsx`.

### 4c. Generate-a-council from chat

Asking chat to "create/spin up/generate a council to …" builds and **opens** one (the user clicks Start — it does NOT auto-run). `council/chat-council-gen.ts`: `isCouncilCreationRequest()` gates on intent (a verb + "council" regex, calibrated to ignore "what is a council"/"city council"); `generateCouncilSetup()` asks a fast model for the council SHAPE only (name, `stepType`, task, persona roles/traits) as strict JSON, then assigns concrete provider/models per role from the user's configured providers (tool-capable CLI worker for coding/enrich/review) — the LLM never picks model ids. `ChatArea` creates the council (`createCouncilFromSetup`, persisted), posts a confirmation, and fires `requestCouncilRun(id, task)` (`councilCreateSignal.ts`). `App` listens for `COUNCIL_RUN_EVENT` → navigates to the council view; `DeliberationView` calls `consumeCouncilRun()` on mount and **pre-fills the task** so the council is ready — the user reviews the setup and starts it.

### 4d. Multi-Step Council Workflows (`council/workflow-runner.ts`)

Councils sharing a `workflowId` (`council/types.ts`) form an ordered chain — the "step rail" (`WorkflowRail.tsx`) shown atop the council view. `council/store.ts` `appendCouncilToWorkflow(councilId)` creates the workflowId on first use and appends a new council after the source; `getWorkflowCouncils(councilId)` returns the ordered chain (a council with no `workflowId` is its own 1-step workflow); both are exposed on `councilStore` as `getWorkflow`/`getWorkflowName`/`appendToWorkflow`.

**Running a step runs it AND every step after it, in order** (`runWorkflowFrom(startCouncilId, { frameProblem, onStepStart })`):
1. `clearStepResults(id)` on every step from the start index to the end — clears the ledger (`ledgerStore.clear`), artifacts (`deleteAllArtifacts`), and `deliberationState` (reset to `undefined`, `status:'active'`) so each reruns fresh. Steps BEFORE the start index are untouched and keep feeding the run.
2. For each step in range, `composeStepProblem(step, priorSteps)` builds the problem text: the step's own `savedProblem` (fallback `topic`), plus — if there are prior steps — the previous step's latest output (`context-store.ts` `getLatestOutput`) rendered through the step's `inputTemplate` contract under a `## INPUT FROM PREVIOUS STEP (name)` header, plus — if `includePipelineInput` is set — the workflow's first step's `savedProblem` under `## WORKFLOW STARTING INPUT`.
3. `callbacks.onStepStart?.(step, index, total)` fires before each step (lets the UI follow along), then `callbacks.frameProblem(step, problem)` runs the normal single-council launch path — same model validation, tool preflight, and orchestrator choice as any council (`useCouncilHandlers.onFrameProblem`). A failing step's error propagates and stops the run.

`renderStepInput` shares `renderCoreTemplate` from `pipeline/input-template.ts` (§5a-2) but with `indexBase: 1` (matches the rail's 1-based step numbering) and rewrites a bare `{{input}}` to `{{input[N]}}` (the PREVIOUS step only) before rendering — unlike the pipeline's `{{input}}`, which joins ALL previous artifacts.

The run loop lives in `useCouncilHandlers.onRunWorkflow` (not the view component) so it survives the per-step view remounts as `DeliberationView` follows the active step. Starting a never-run multi-step council's first step, and "Save & Rerun" on an already-run step mid-workflow, both call `onRunWorkflow`; the latter invalidates that step and everything forward of it only — earlier steps and their outputs are preserved. Single-step councils and councils spawned by a pipeline step are unaffected (they still launch via `frameProblem` directly).

**View-mode navigation**: a one-shot `requestCouncilView(id)`/`consumeCouncilView(id)` signal (`councilSetupSignal.ts`) tells `DeliberationView`'s mount logic to open the target step's deliberation (view mode) instead of auto-opening setup — used when the workflow rail advances between steps mid-run, and when a rail step is clicked while already in view mode. Auto-open of the setup panel is now gated to genuinely NEW councils only: `phase === 'created' && status !== 'resolved' && !deliberation?.savedProblem` — needed because `deliberationState` is not persisted to disk (rule #6), so every council reads phase `'created'` after an app restart; without the extra checks a resolved or in-progress council would hijack into the edit screen on reload.

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
| `analysis` | Deliberation (same workflow) | **Manager only** (default preset) | Decision artifact | 1 persona by default — the manager's `decide()` output IS the step output (0 workers → no execute/review phases); JSON-capable |
| `agent` | Deliberation (same workflow) | Worker only (default preset) | Output artifact | 1 persona by default — a single tool-using pass, no framing/review; concise output |
| `gate` | None | None | Approval | Pauses for user confirmation |
| `script` | None | None | stdout | Runs a shell command, captures stdout as artifact |
| `condition` | None | None | Evaluation result | Evaluates expression against input; actions: continue, skip_next_stage, stop, loop_to_stage |

**No workflow-skipping "lightweight" path.** Every council type — including `agent`/`analysis` — runs the SAME deliberation workflow (frame → rounds → decide → execute → review). A "lightweight" council is just a SMALLER council (e.g. 2 consultants), never one that skips phases. The workflow stays cheap on its own when there's little to deliberate: with 0 consultants it skips the discussion rounds and goes straight to deciding, and round/revision counts cap the depth. The only direct-execution path is the structural manager-less case (a council with no manager can't orchestrate).

**Lightweight steps are pinned to 1 round / 0 revisions.** `isLightweightCouncilType(type)` (`analysis`/`agent`) steps have `maxRounds`/`maxRevisions` fields **disabled** in `StepConfigPanel` and force-normalized to `maxRounds: 1, maxRevisions: 0` on mount (a `useEffect` corrects any older 0/0-era config on load). **`analysis`'s default preset is manager-only** (single `Analyst` persona, `suppressPersona: true`): analysis = DECIDE, and `deliberation-orchestrator.ts` `decide()` already completes the council with the manager's decision as final output whenever `getPersonaByRole(council, 'worker').length === 0` — a second worker persona would just produce a discarded, doubly-billed output. `agent`'s default preset is a single tool-using `worker` persona instead (§5a-1: `writePermissions` gates whether it can actually write files).

`PipelineStepType = 'council' | 'code_planning' | 'analysis' | 'agent' | 'coding' | 'review' | 'enrich' | 'gate' | 'script' | 'condition'`

### 5a-1. OutputType

`OutputType = 'string' | 'file' | 'directory' | 'json'`

| Type | Behavior |
|------|----------|
| `string` | Text content passed directly to downstream steps |
| `file` | File path — downstream steps instructed to read the file |
| `directory` | Directory path — downstream steps instructed to read all files |
| `json` | Structured JSON — downstream steps can access fields via `{{input.fieldName}}` templates |

**File-writing is gated by output type, not capability.** `effectiveWrite(assignment, outputType)` (`deliberation-orchestrator.ts`) returns true ONLY when `assignment.writePermissions` AND `outputType` is `'file'` or `'directory'`. For `'string'`/`'json'` (or a plain deliberation with no output type) it's false — the worker gets the text-deliverable prompt and emits the actual content instead of narrating fake `write_file(...)` calls. (`canUseTools` is no longer consulted here; it remains only for the runtime tool-exec gate.) The `outputType` reaching `effectiveWrite` comes from `council.deliberation.outputType` as persisted by `council/store.ts` `createCouncil()` — that function assembles `deliberation` from an explicit field whitelist, so a new/renamed `DeliberationConfig` field silently reads as `undefined` at runtime unless it's also added there (§10 gotcha 22).

**The gate is enforced at both the prompt-framing and tool-grant layers.** `buildWorkerExecutionPrompt` (`prompts.ts`) only applies the tool-exec framing ("EXECUTE THIS TASK NOW using your available tools") for `agent`/`analysis` stepTypes when `permissions?.writePermissions` is true; otherwise it falls through to the text-deliverable framing — previously a tool-less agent was told to use tools it didn't have and narrated fake tool calls (e.g. claiming it wrote `RELEASE_NOTES.md` when no file existed). The runtime tool grant in `invokeAgentSafe` mirrors this: in worker phases (execution/revision/debug), when `effectiveWrite` is false the allowed-tool set is `READ_ONLY_TOOLS` (`Read`/`Grep`/`Glob` + built-ins) instead of `FULL_TOOLS` (`Edit`/`Write`/`Read`/`Bash`/`Glob`/`Grep`) — so a text-deliverable worker can still research but is never offered `write_file`. `code_planning` is unaffected (always `PLAN_TOOLS`).

### 5a-2. Input Template Syntax

| Pattern | Description |
|---------|-------------|
| `{{input}}` | All previous artifacts joined |
| `{{input[N]}}` | Specific artifact by index |
| `{{input.fieldName}}` | JSON field from last artifact (dot-path walk) |
| `{{input[N].fieldName}}` | JSON field from specific artifact |
| `{{file}}` | All output file paths joined |
| `{{file[N]}}` | Specific artifact's file path |
| `none` | No input from previous steps — the step sees only its own task |

**Shared implementation (`pipeline/input-template.ts`).** `renderCoreTemplate(template, inputs, { indexBase })`, `resolveJsonPath`, and `extractJsonBlock` are the ONE implementation of this contract, used by both the pipeline executor and the council workflow-runner (§4d) so the two can't drift. Each caller keeps its own concerns on top: the executor supplies `indexBase: 0` (artifact position) and layers provenance headers (`display`) + `{{memory.*}}` post-processing; the workflow-runner supplies `indexBase: 1` (step-rail numbering) and rewrites a bare `{{input}}` to an indexed access first, since in a workflow `{{input}}` means only the PREVIOUS step's output, not all prior steps joined. `resolveJsonPath` falls back to `extractJsonBlock` when the raw content isn't itself valid JSON (prose- or fence-wrapped), so `{{input.field}}`/`{{input[N].field}}` recover the same way in both callers. `extractJsonBlock` is no longer exported from `pipeline/executor.ts` — import it from `pipeline/input-template.ts`.

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

The command's `cwd` is `pipeline.settings.workingDirectory || platform.getWorkingDir()` (`runScriptStep`, `pipeline/executor.ts`) — the same directory council steps write files to, so a script step can operate on files a prior council step produced. The platform working directory is only a fallback when the pipeline has no configured working directory.

### 5a-4. Condition Step Config

```typescript
type ConditionMode = 'contains' | 'regex' | 'equals';
type ConditionAction = 'continue' | 'skip_next_stage' | 'stop' | 'loop_to_stage';

interface ConditionStepConfig {
  type: 'condition';
  expression: string;       // What to match
  mode: ConditionMode;      // How to match
  inputTemplate: string;    // What to match against
  trueAction: ConditionAction;
  falseAction: ConditionAction;
  loopTargetStageId?: string; // for 'loop_to_stage': earlier stage to re-run from
  maxLoops?: number;          // loop budget (default 3)
}
```

When a condition step triggers `skip_next_stage`, the executor skips the immediately following stage (marks all its steps as 'skipped') and continues with the stage after that. When it triggers `stop`, the pipeline completes gracefully — remaining stages are marked as 'skipped' and the pipeline status is 'completed'. When it triggers **`loop_to_stage`**, the executor rewinds to `loopTargetStageId`, resets the intervening stages (target…current) to 'pending', and re-runs from there — enabling iterative refine→review→refine loops. **Bounded by `maxLoops` (default 3) per condition step** via an in-run counter (`loopCounts`, keyed by step id); once the budget is exhausted the action falls through per `onLoopExhausted` (default `'continue'`: proceed with the last attempt; `'stop'`: end the pipeline as completed; `'fail'`: throw, failing the step — and the pipeline, under the default failure policy) — see `ConditionStepConfig.onLoopExhausted` below. The target must be an earlier (or the same) stage; a forward/missing target falls through.

**Loop-back feedback rides the back-edge.** When a `loop_to_stage` fires, the condition's evaluated input (`inputContext` — typically a judge/reviewer's verdict) is captured as `loopRequest.feedback`. On the next pass through `run()`, `collectPreviousArtifacts()` appends it as an EXTRA artifact for the loop target: `"THIS IS A RETRY (attempt N). The previous attempt was sent back. Address the feedback below.\n\n<feedback>"`, with `metadata.stepName` set to `Loop feedback from "<condition step name>" (iteration N)`. This is the one case where a step receives input from a step that runs AFTER it in pipeline order.

```typescript
interface ConditionStepConfig {
  // ...
  /** What happens when maxLoops is exhausted and the check STILL fails:
   *  'continue' (default) proceeds with the last attempt, 'stop' ends the
   *  pipeline as completed, 'fail' fails the step (and the pipeline under
   *  the default failure policy). */
  onLoopExhausted?: 'continue' | 'stop' | 'fail';
}
```

### 5a-5. Pipeline Input Sources

`Pipeline.inputSource?: PipelineInputSource` (`{ kind: 'text' | 'file' | 'directory' | 'url', value?: string, instructions?: string }`, `pipeline/types.ts`) generalizes the classic typed `initialInput` seed:

- **`text`** (default when `inputSource` is absent) — the classic `Pipeline.initialInput` string.
- **`file` / `directory`** — `value` is a path; the executor does NOT read it. It builds a synthetic stage-0 artifact instructing the first step to read the path with its own tools (`[Input type: file]` / `[Input directory: ...]` + an explicit "use your tools to read/list" directive).
- **`url`** — `value` is fetched once at run start via `platform.fetchText(url)` (GUI: `http_relay` Tauri command; CLI: Node `fetch`) BEFORE stage 0 runs; a fetch failure fails the run immediately. The fetched body becomes the stage-0 artifact content.
- **`instructions`** (all kinds) — prepended to the stage-0 artifact content: "what the first step should DO with the input."

Implemented in `PipelineExecutor.collectPreviousArtifacts()` (stage-0 special case) and `run()` (up-front URL resolution into `resolvedUrlInput`). The builder's Pipeline Input panel (§5c) edits this via `pipelineStore.update(id, { inputSource })`.

### 5a-6. Pre-Run Validation (`src/pipeline/step-validation.ts`)

`validatePipeline(pipeline, configuredProviders)` returns a `Map<stepId | '__input__', string[]>` of human-readable problems — empty map = ready to run. Powers the ⚠ node badges (§5c) and the run gate: `PipelineBuilder`'s Run button computes `problems` on every render and, if non-empty, refuses to start and shows a dismissible amber banner listing every offending step and its issues (`showRunBlocked`).

Per-type checks (`validateStep`):
- **Council types** (`validateCouncilStep`): no personas configured; a persona missing `model`/`provider`, or whose provider isn't in `configuredProviders` (router-routed personas exempt); consultants configured with `maxRounds === 0` (they'd never speak); no Task AND `inputTemplate === 'none'` (nothing to work from); **`expectedOutput` required only for FULL council types** — `isLightweightCouncilType()` (analysis/agent) steps are exempt since they define their deliverable in the Task.
- **`script`**: no shell command.
- **`gate`**: no approval prompt.
- **`condition`**: no expression; for a `loop_to_stage` action — no `loopTargetStageId`, target stage no longer exists, or **target is not an earlier (or same) stage** than the condition step's own stage.
- **Pipeline input** (`validatePipelineInput`, key `__input__`): a non-`text` `inputSource` with no `value`; a `text` source with empty `initialInput` AND no first-step Task to fall back on.

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

**Pipeline step preset model SKUs are centralized.** `StepConfigPanel.tsx` derives every step type's default persona models from two constants — `DEFAULT_PRIMARY_MODEL = { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic-cli' }` and `DEFAULT_SECONDARY_MODEL = { model: 'gpt-5.5', provider: 'openai-cli' }` — resolved per-persona through `resolveDefaultModel()` (falls back to a configured/available provider) and assembled by a shared `presetPersona(role, name, resolved, opts)` factory (role-keyed avatar/color/traits/`suppressPersona` defaults). This is **the single refresh point** for pipeline-preset SKUs when a model generation bumps (rule 14 in `CLAUDE.md`) — change the two constants, not each `default*Config()` function.

### 5b. Pipeline Store Schema

Key: `mcp-pipelines` — version 5.

Step configs: `CouncilStepConfig | LlmStepConfig | GateStepConfig | ScriptStepConfig | ConditionStepConfig`

Legacy `LlmStepConfig` (flat `model/provider/systemPrompt`) is auto-migrated to `CouncilStepConfig` via `migrateLlmConfig()`.

Input template variables: `{{input}}` (all previous artifacts), `{{input[N]}}` (specific artifact by index), `{{file}}` (all output file paths), `{{file[N]}}` (specific file path).

### 5c. Builder UI: Graph-Only

`PipelineBuilder.tsx` has **no List view** — `StageRow.tsx` was deleted and the graph (`components/pipeline/PipelineGraphView.tsx` + `.css`) is the only pipeline-editing surface, not a read-only projection. The `kondi-pipeline-builder-view` localStorage key (former List/Graph toggle) is **removed**.

Stages are an internal execution detail and are not shown as chrome — the graph renders a plain chain of step nodes, grouped into **layers** (one layer per pipeline stage) only when steps share one:

- **Add Step** (`+ Add Step` under the last layer) appends a new step in its **own sequential stage**. **Sibling add** (a `+` beside a layer's last node) adds a step ALONGSIDE an existing one — same layer/stage, runs per the layer's execution mode.
- **Layer mode chip** — a clickable `sequential`/`parallel` chip next to any multi-step layer toggles `PipelineStage.executionMode`.
- **Editable layer-name labels** — an inline `<input>` above each layer renders/edits `PipelineStage.name` directly (`onRenameLayer`).
- **Faint layer hulls** — a rounded outline drawn behind any layer with 2+ nodes, so "these run together" (and loop targets) stay visually grouped.
- **⚠ validation badges** — every node (and the ▶ Input pseudo-node) shows a ⚠ when `step-validation.ts` (§5a-6) reports problems for it; hover lists them.
- **Node ✕** removes the step (and its now-empty stage, if it was 1-step).
- **⚖ deliberation** — a per-node button (when the step has run and produced a `councilId`) opens that step's full deliberation view. `App.tsx` sets a `councilFromPipeline` flag when navigating there; `DeliberationView`'s **← Back** button (`onBack`, always existed but was never rendered until this change) then returns to the pipeline builder instead of the council library, and clears the flag. Any sidebar navigation away also clears it, so it doesn't stick to the next council opened normally.
- **▶ Input node** — click selects the pipeline input; the side panel switches to the Pipeline Input panel (§5a-5) instead of `StepConfigPanel`.
- **Details drawer** — pipeline name/description/working-directory/schedule fields are hidden behind a `⚙ Details ▸` toggle in the header (`detailsOpen` state), not shown inline by default.
- **Side panel** — mutually exclusive with node selection: a selected step shows `StepConfigPanel` (with its `problems` list atop it, §5a-6); no step selected shows the Pipeline Input panel.

Condition-step actions (§5a-4) are drawn as real edges, not just labels: `loop_to_stage` is an amber dashed back-edge on a left lane, labeled with the loop budget (e.g. `T · loop ≤3`); `skip_next_stage` is a dotted bypass edge on a right lane; `stop` (and a `loop_to_stage`/`skip_next_stage` with no valid target) render as a red badge under the node instead of an edge. Node left-border color reflects the step's `status`.

`getStepIcon()`/`getStepSummary()` now live in and are exported from `PipelineGraphView.tsx` itself (moved when `StageRow.tsx` was deleted). Both `PipelineGraphView` and `PipelineBuilder` are exported from `components/pipeline/index.ts`.

### 5d. PipelineResultsView (finished/partial-run review)

`components/pipeline/PipelineResultsView.tsx` — a read-only surface for reviewing a run after it's no longer live (`PipelineBuilder`'s "View Results" button on a `completed`/`failed` pipeline; `onViewResults`). A still-`running` pipeline instead opens `PipelineExecutionView` (the live progress surface) via the same button.

- **Stage-grouped, collapsible.** Steps are grouped under their producing stage; both stages and individual steps are independently collapsible (`collapsedStages`/`collapsedSteps` sets). **Steps start COLLAPSED** — you expand the ones you want to read; stages start expanded.
- **Explicitly labeled outputs.** Each step's artifact is labeled by `artifactLabel()`: `Decision (manager)`, `Output (worker deliverable)`, `Approval`, or `LLM response`, plus a meta line (`outputType` / token count / char count) and, when present, `📄 saved to <outputPath>`.
- **Stage-output footers.** Each stage ends with a summary line naming every artifact-producing step and what it fed to the next stage (or "final result" for the last stage).
- **Deliberation drill-down.** A step with a `councilId` shows a `⚖ deliberation` button (`onOpenCouncil`) to open its full council view.

### 5e. Pipeline Import (`PipelineLibrary`)

The library header's **Import** button (distinct from **Import CLI Session**, §11) reads a local JSON file and calls `pipelineStore.import(list)` → `importPipelines()` (`pipeline/store.ts`). Accepted shapes: a single exported pipeline object (`{ ...,  stages: [...] }`), an array of pipelines, `{ pipelines: [...] }`, or a harness store dump (`{ "mcp-pipelines": "<json-string>" }`, e.g. `testing/harness/store-dump.json`). **Id collision** — if an incoming pipeline's `id` already exists in the store, it's assigned a fresh `crypto.randomUUID()` instead of overwriting; the pipeline is otherwise imported as-is. A summary dialog reports how many pipelines were imported (or that none were found).

The library itself was rebuilt in the councils-view **table layout** (expandable rows: name/status/stage-count/step-count/updated columns, expanding to description, step chips, working-dir/input-source meta, and action buttons) instead of the old card grid.

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
6. **Write containment is enforced by a PreToolUse hook, NOT by Claude Code permission flags.** Empirically (headless `--print`): `--permission-mode acceptEdits` still writes files outside the working dir, absolute `--allowedTools "Write(//abs/**)"` rules silently fail to match, and `bypassPermissions` disables confinement entirely — a worker escaped and wrote into the parent git repo's `docs/`. The fix (`src/services/cli-workdir-guard.ts`) installs a `PreToolUse` hook via `--settings` (matcher `Write|Edit|MultiEdit|NotebookEdit|Bash`) that resolves the real target path and **denies any write whose resolved path is outside the working dir** (root = `KONDI_WORKDIR` env, fallback hook payload `cwd`); Bash redirects/mutations to absolute paths outside the dir are blocked too (reads allowed). **Three non-obvious mechanics make the hook actually fire** (an inline base64 `node -e` hook silently never ran — verified via the raw claude stream): (a) the guard must be a `.cjs` FILE invoked as two UNQUOTED tokens `<node> <file>` — claude splits the hook command on whitespace with no shell, so a quoted `-e "…"` arg is mangled; (b) the FIRST token must be the ABSOLUTE node binary (`process.execPath`) — claude runs hooks with a sanitized PATH that excludes nvm/volta, so bare `node` is not-found and the hook falls open; (c) allow = `exit 0` silently (an explicit `permissionDecision:'allow'` interfered with in-sandbox writes), deny = emit the deny JSON. `cli/claude-caller.ts` (CLI runner) writes the file + uses `process.execPath`; `src/services/claudeCliClient.ts` (webview) installs it via the `run_command` Tauri backend (writes the script, resolves `command -v node`). Workers keep `bypassPermissions` + full tools; they just cannot escape. The system-prompt "working directory override" text is advisory only. **The `openai-cli` (Codex) path needs no such hook** — `codex-caller.ts` runs `--full-auto` (`--sandbox workspace-write` + `--cd <workingDir>`), whose OS-level sandbox (landlock/seatbelt) already confines writes to the working dir (verified: an out-of-dir write is refused). API providers (deepseek/gemini) have no file tools. **Codex no-sandbox toggle:** Settings → General → "CLI Workers" → "Run Codex without its OS sandbox" (localStorage `kondi-codex-no-sandbox` for the webview, env `KONDI_CODEX_NO_SANDBOX=true` for the CLI) swaps `--sandbox workspace-write`/`--full-auto` for `--dangerously-bypass-approvals-and-sandbox` — for hosts that restrict unprivileged user namespaces (recent Ubuntu/AppArmor) where Codex's bwrap sandbox can't init. Containment then relies ONLY on Kondi git-scoping the working dir (less strict; warned in the UI).

### Output
- Execution report: `<working-dir>/kondi-execution-report.json`
- Session export: `kondi-session-<pipeline-id>.json` (importable by GUI)

---

## 8. Unified LLM Router

All LLM completions flow through `llm-router.ts`. No call site may bypass the router.

```
ChatArea ───→ chatCompletion() ──┐
Council  ───→ simpleCompletion() → chatCompletion() ──→ provider client
Pipeline ───→ simpleCompletion() → chatCompletion() ──┘
```

### Provider Dispatch

| Provider ID | Client | Transport | Session |
|-------------|--------|-----------|---------|
| `anthropic-cli` | `claudeCliClient.ts` | `claude --print` binary | `--resume <sessionId>` for chat |
| `anthropic-api` | `anthropicClient.ts` | Direct HTTP (API key) | Stateless |
| `openai-cli` | `codexCliClient.ts` | `codex exec --json` binary | `resume --last` for chat |
| `openai-api` | `openaiClient.ts` | Direct HTTP (API key) | Stateless |
| `deepseek` | `openaiCompatibleClient.ts` | OpenAI-compatible HTTP | Stateless |
| `google` | `geminiClient.ts` | Gemini API | Stateless |
| `xai` | `openaiCompatibleClient.ts` | OpenAI-compatible HTTP | Stateless |
| `zai` | `openaiCompatibleClient.ts` | OpenAI-compatible HTTP (z.ai Coding Plan) | Stateless |
| `moonshot` | `openaiCompatibleClient.ts` | OpenAI-compatible HTTP (api.moonshot.ai) | Stateless |
| `nvidia-router` | `openaiCompatibleClient.ts` | OpenAI-compatible HTTP (NIM/local) | Stateless |
| `ollama` | `openaiCompatibleClient.ts` | Local HTTP | Stateless |

A `route:<profile>` model (or `provider:'router'`) is resolved to a concrete provider+model by the Smart Router **before** this dispatch (see §3a); `chatCompletion()`/`simpleCompletion()` accept an optional `routePhase` hint for that resolution.

### CLI Provider Details

OAuth tokens from Claude Code and ChatGPT subscriptions only work from their respective CLI binaries — direct HTTP API calls are rejected (server-side client attestation). The router spawns CLI processes via Tauri commands (`run_claude_streaming`, `run_codex_streaming`).

**Session management (chat only):** First call creates a new session; subsequent calls resume it (`--resume <sessionId>` for Claude, `resume --last` for Codex). Session IDs are stored in-memory per `chatId`. Council/pipeline calls are always fresh one-shot processes.

**MCP tools:** CLI binaries can't use Kondi's MCP connections. The router calls `mcpClient.ensureProxiesForServers()` before each LLM call to start local proxy processes. Proxies are synced to `~/.claude.json` and `~/.codex/config.toml` so CLI binaries discover them automatically.

### Context Passing

- **Chat**: CLI session handles history via resume; only the latest user message is sent
- **Council**: Orchestrator assembles full context (ledger history, patches, expected output) into `systemPrompt` + `userMessage` strings — stateless one-shot per call
- **Pipeline**: Same as council — `simpleCompletion()` with full context in the prompt

**Conversation ID isolation**: Each council persona call MUST get a unique conversation ID (`council-<uuid>`). Sharing IDs causes context accumulation and failures in round 2+.

---

## 9. Data Storage

All state goes through `CouncilDataStore` (`council/storage-cleanup.ts`) — an in-memory `Map<string,string>` with no size limit. Browser `localStorage` is a best-effort cache; quota errors are silently ignored. The CLI uses the same pattern via `localStorage-shim.ts`. The store ALSO mirrors the full value of every council/pipeline key to disk (the durable backstop vs the ~5MB localStorage quota — see Storage Architecture below).

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
| `kondi-model-status` | services/modelProbe.ts | Per-model availability (ok/broken/soft-fail) — hides proven-broken models |
| `kondi-catalog-sync` | services/modelCatalogSync.ts | Last live `/models` reconciliation per API provider (advisory drift report) |
| `kondi-council-store-dir` | council/storage-cleanup.ts | User override for the on-disk council store directory (empty = `<dataDir>/council-store`) |
| `kondi-codex-no-sandbox` | services/codexCliClient.ts | Opt-in: run Codex with `--dangerously-bypass-approvals-and-sandbox` instead of `--sandbox workspace-write` |
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

`CouncilDataStore` is a singleton in-memory `Map` (primary), with a localStorage cache AND a durable disk mirror. All stores use it for reads and writes:
- `getItem(key)`: checks in-memory Map first, falls back to localStorage (promotes to Map on hit)
- `setItem(key, value)`: always succeeds in Map; localStorage write is try/catch silenced; the FULL value is also scheduled to disk
- `setItemDurable(key, value, slim)`: full value to Map + disk regardless of localStorage quota; localStorage gets the full value, or `slim()` if that throws — keeps DEFINITIONS (councils, pipelines) surviving a restart even when their live data pushed the blob past the cap
- `setItemPersistent(key, value)` (used by `pipeline/store.ts` only): full value to Map + scheduled disk write; the localStorage mirror is wrapped in try/catch and **never throws on quota** — it used to call `localStorage.setItem()` unguarded, so once other data filled the ~5MB cap, every pipeline save (including the council-workflow shadow-pipeline write) threw `QuotaExceededError` and aborted the caller mid-run. Restart-persistence still comes from the scheduled disk write, not localStorage.
- `removeItem(key)`: removes from Map, localStorage, and disk (`delete_local_file`)

**Disk mirror (durable backstop).** localStorage's ~5MB quota means a full deliberation (ledger chunks + deliberation state) may not fit — on a restart the empty Map would lose anything that didn't. The store mirrors the FULL value of every council/pipeline key to disk at `<dataDir>/council-store/<hex(key)>.kv` (hex-encoded key as filename, via the `write_local_file`/`delete_local_file`/`list_directory`/`read_local_file` Tauri commands). Writes are debounced (250ms, `armFlush`/`flushDisk`) and flushed on `beforeunload`. `hydrateFromDisk()` loads disk → the Map at startup and migrates any pre-existing localStorage council data to disk once; it's `await`ed in `src/main.tsx` (after `initKondiPaths()`) BEFORE the first React render, so councils + full ledger/deliberation survive an app restart. The store dir is user-configurable (Settings → General → "Council Deliberation Store"; `setDiskDir`/`getDiskDir`/`getDiskDirOverride`/`getDefaultDiskDir`; override localStorage key `kondi-council-store-dir`; default `<dataDir>/council-store`, where `<dataDir>` is resolved cross-platform by the Rust `get_kondi_data_dir` command via `kondiPaths.ts`). This auto-reload of the FULL deliberation is SEPARATE from a council's per-council `saveDeliberationMode` (full/abbreviated), which exports human-readable markdown to the WORKING directory (`<workingDir>/.kondi/outputs/...` via `deliberationSaveService`).

**Stores using `councilDataStore`**: `context-store.ts`, `ledger-store.ts`, `council/store.ts`, `pipeline/store.ts`, `session-import.ts`.

**No data destruction.** Deliberation history is never purged. After each pipeline step extracts its artifact, `stripCompletedCouncil(councilId)` trims only the localStorage copy of the `mcp-councils` entry to keep the cache small. The authoritative data remains in the Map and on disk.

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
14. **Council workers escaped the working directory**: With `bypassPermissions`, a Claude CLI worker resolved a "docs/" directive against the parent git repo and wrote into the real project `docs/`, outside its `directoryConstrained` working dir. ROOT CAUSE: the Claude CLI adopts the NEAREST git repo (walking up from cwd) as its project — with the workdir nested in the kondi repo, the worker explored the kondi tree for minutes (→ timeouts) and resolved relative paths against the kondi root (→ escape). Fixed by THREE layers: (a) `run-council.ts` runs `git init` in the workdir so git-root discovery stops there (`git rev-parse --show-toplevel` → the workdir); (b) a `PreToolUse` hook (`src/services/cli-workdir-guard.ts`, §7 gotcha 6) denies any write resolving outside the workdir — installed on both CLI and webview paths; (c) the guard file is written atomically (temp+rename, once/process) so a concurrent call can't read a truncated guard and fail the hook open. The worker still READS outside the workdir (grounded quality); only WRITES are contained.
15. **Text-council artifacts wrapped in file-creation junk**: Weak workers (e.g. gemini) obey the manager's "create a file" directive regardless of worker-prompt overrides, emitting `write_file("path", """…""")` dumps + a "COMPLETION SUMMARY" block around the real answer. Fixed: `sanitizeDeliverable()` (deliberation-orchestrator.ts) extracts the content from XML/triple-quoted/quoted `write_file(...)` forms and strips the summary block — deterministic, model-independent, applied on the no-write `createOutput`/`reviseWork` path.
16. **Settings → Services froze the whole app** (infinite render loop): `SearchServicePanel`'s mount effect depended on the identity of the un-memoized `onStatusChange` prop, and the `useServers` handler rebuilt the servers array (fresh objects) on EVERY status report — so each refresh re-rendered App → recreated the callback → re-fired the effect → spawned `docker info`/`docker inspect` subprocesses, forever. Only triggered when the built-in search MCP server was connected. Fixed two-sided: the panel keeps `onStatusChange` in a ref (refresh logic never depends on callback identity), and `useServers` bails out of `setServers` when the search server's status and tool count are unchanged.
17. **NVIDIA NIM "Connection error" from the webview** (CORS): NIM's hosted API sends NO CORS headers (Z.AI/DeepSeek do), so every direct webview call was blocked by the browser and surfaced as "Connection error" — while curl/Node tests passed. Fixed: `http_relay_stream` Tauri command relays HTTPS requests via reqwest (no CORS) and forwards response bytes over an IPC channel as they arrive; `relayFetch` (openaiCompatibleClient.ts) adapts the channel to a fetch `Response` for the OpenAI SDK. A first buffered-relay attempt "worked" but returned nothing until the full body arrived — real chat generations exceed the 90s no-first-byte watchdog, which killed them; streaming the relay fixed both the watchdog false-positive and live tokens. Related: NIM's `/models` list advertises models that don't work (404 "Function not found", hangs, streaming-only 500s) — the catalog ships only completion-verified models (see §3).
18. **`setItemPersistent` threw `QuotaExceededError`, killing pipeline saves**: found by a live workflow rerun with localStorage near the 5MB cap (59 councils) — any `pipelineStore` save, including the council-workflow shadow-pipeline write, threw and aborted the caller before the executor even started. Fixed: `setItemPersistent` now matches the store's own design (§9) — in-memory cache is primary, localStorage is a best-effort mirror (quota errors warn via `console.warn`, never throw), and restart-persistence comes from the scheduled disk write.
19. **Worker invents facts the directive dropped**: the worker's prompt previously contained ONLY the manager's directive — two lossy summarization hops from the step's actual input — so a step's final brief once contradicted the upstream decision because the directive lost details the worker then invented replacements for. Fixed: `runFullDeliberation` persists the raw problem (`councilStore.setSavedProblem`), and `groundInSource()` re-attaches it (capped 24000 chars) to the worker's directive in both execution and revision, as authoritative source material (§4a).
20. **Tool-less agent/analysis workers narrated fake tool calls**: `buildWorkerExecutionPrompt` applied the "use your available tools" framing to EVERY `agent`/`analysis` step regardless of write permission, so a text-output worker described writing a file (e.g. claimed it wrote `RELEASE_NOTES.md`) instead of emitting the content — no file ever existed. Fixed: the tool-exec framing is now gated on `permissions?.writePermissions`; without it, the prompt falls through to the text-deliverable framing, and the runtime tool grant likewise drops to `READ_ONLY_TOOLS` (no `write_file`) for those workers (§5a-1).
21. **Script steps ran in the wrong directory**: `runScriptStep` always used the platform's working directory, so a script step couldn't see files a prior council step had just written to the pipeline's configured working directory. Fixed: `cwd = pipeline.settings.workingDirectory || platform.getWorkingDir()` (§5a-3).
22. **`createCouncil()`'s field whitelist silently dropped `deliberation` fields**: `council/store.ts` `createCouncil()` builds the persisted `deliberation` object from an explicit list of named fields (not a spread of `params.deliberation`); `outputType`, `savedProblem`, and `evolveContext` were missing from that list, so `factory.ts` (and the pipeline executor) could pass them in but the STORED council always had `deliberation.outputType === undefined` at runtime. Consequence: `effectiveWrite` (§4a/§5a-1, CLAUDE.md rule 5) was permanently `false` for every pipeline-launched council regardless of the step's configured `outputType` — every pipeline worker ran in text mode, so a step with `outputType: 'directory'` emitted its files as ```filename: fenced text blocks instead of writing them (this made the earlier "executor forwards outputType" fix, §5a-1, inert). Fixed: added `outputType`, `savedProblem`, and `evolveContext` to the whitelist. Any NEW `DeliberationConfig` field must be added to this same whitelist or it will silently read as `undefined` downstream.
23. **`createGitSnapshot` adopted a PARENT git repo**: it checked `git rev-parse --is-inside-work-tree`, which is `true` even when the working dir is merely NESTED inside another repo (e.g. an examples workspace living inside the kondi repo itself) — so `git add -A && git commit -m "kondi: pre-pipeline snapshot"` committed the PARENT project's entire tree into the parent's git history (observed: junk snapshot commits on the kondi repo's own main branch sweeping up unrelated uncommitted work). Same failure class as the CLI nearest-repo escape (gotcha 14). Fixed: it now compares `git rev-parse --show-toplevel` against the working dir (trailing-slash-normalized) and `git init`s the working dir as its own repo unless it is itself the top-level (§4b).

---

## 11. Development Workflows

### Pipeline E2E Test Suite (`testing/`)

Feature-verification harness for the pipeline engine, separate from unit tests. `testing/harness/run-all.ts` drives the REAL `PipelineExecutor` + real stores + the Node `PlatformAdapter` (real filesystem) — not mocks. Run: `cd mcp-connect-mvp && NVIDIA_API_KEY=... npx tsx ../testing/harness/run-all.ts`.

- **12 numbered test folders** (`testing/01-linear-chain` … `testing/12-full-council`), each with a `README.md` describing the pipeline shape/assertions and a `result.json` written by the run (pass/fail per assertion + captured artifacts). Coverage: input chaining, parallel-stage `{{input}}`/`{{input[N]}}` joins, `json` outputType + `{{input.field}}` dot-paths (§5a-2), condition `continue`/`stop`/`skip_next_stage`, loop-back feedback + `maxLoops` + `onLoopExhausted: 'fail'` (§5a-4), script steps, all four `inputSource` kinds (§5a-5), gate approve/reject, `failurePolicy` stop vs skip_step, resume-skips-completed-steps, worker file output + `{{file}}` resolution, and a full manager+worker council through the deliberation engine.
- LLM steps call NVIDIA NIM's free-credit `nemotron-3-nano` for genuine model calls; personas named `SCRIPTED:...` are answered by the harness with canned text instead, so control-flow assertions (loops, conditions, failures) stay deterministic regardless of live model output.
- **Known issue (logged, non-fatal):** `council/context-bootstrap.ts` calls the Tauri `invoke()` directly (`run_command`, `read_local_file`) with no Node/CLI fallback, so directory-context bootstrap always fails (caught, doesn't abort the run) when the harness (or the CLI runner) runs a step outside the Tauri webview.

### Dev Mode
```bash
cd mcp-connect-mvp
npm run tauri dev          # Starts Rust backend + Vite dev server
```

### Build
```bash
npm run tauri build        # Production build
```

The npm `tauri` script is plain `tauri` (the `WEBKIT_DISABLE_DMABUF_RENDERER=1` POSIX inline-env — a Linux-runtime-only flag — was removed because it fails on Windows `cmd`; `tauri:dev` keeps it for the Linux dev box). The guard sidecar must be built first: `src-tauri/build-guard.sh` runs `cargo build --release -p kondi-guard` and copies it to `binaries/kondi-guard-<target-triple>` where Tauri's `externalBin` expects it.

### Packaging / CI / Releasing

- **`kondi-guard` is a standalone workspace crate** (`src-tauri/kondi-guard/`, serde_json + std only, `license = MIT`) — split out of the Tauri app crate so building it doesn't run `tauri-build`/GTK or hit the `externalBin` chicken-and-egg. Built via `cargo build -p kondi-guard`.
- **Workflows** live at the repo root `.github/workflows/`: `ci.yml` (typecheck + `vite build` + verify `kondi-guard` compiles) and `release.yml` (multi-platform Tauri bundle on tag). The macOS Intel leg (`macos-13`) is `continue-on-error` (scarce free runners queue for hours).
- **Signing is intentionally OFF** in `release.yml` (the macOS/Tauri `APPLE_*` / `TAURI_SIGNING_*` env vars are COMMENTED OUT). A defined-but-empty `APPLE_CERTIFICATE` makes Tauri's bundler try to import an empty cert and fail the whole macOS build. To enable: add the repo secrets FIRST, then uncomment. `docs/RELEASING.md` documents the signing setup.
- **License:** the entire project is **MIT** — the backend `src-tauri/` (Rust/Tauri, including `kondi-guard`; `Cargo.toml` `license = MIT`, `src-tauri/LICENSE`) and the frontend + everything else (`package.json` `"license": "MIT"`, root `LICENSE`). See `LICENSING.md`. (Previously the frontend was AGPL-3.0-only and the backend MIT; the whole repo was relicensed to MIT.)

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
