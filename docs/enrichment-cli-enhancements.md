# Kondi CLI Pipeline Enrichment: Three-Feature Roadmap

## Overview

CLI pipeline authors today run multi-step, multi-model jobs with no visibility into which model was selected, what tokens are accumulating, or what costs are being incurred — and when a 12-step pipeline fails at step 8 they must restart from scratch. This roadmap closes three distinct gaps: live cost observability, richer conditional branching as a first-class primitive, and fault-tolerant checkpoint/resume support. All three features are grounded in the existing executor, orchestrator, and router architecture and require no new external dependencies beyond Node.js built-ins.

---

## Market Research

### (a) Competitive Landscape

CLI pipeline authors building multi-model orchestration workflows today operate in a space surrounded by adjacent tools, none of which fully addresses the multi-model council model Kondi uses:

**GitHub Actions** is the most widespread event-driven DAG runner for software pipelines. It offers structured step-level logging and a well-understood YAML step schema, but it provides **zero LLM cost visibility** — there is no built-in mechanism to surface token spend or per-model cost during a run. Branching is done with `if:` expressions on step-level outcomes, but those expressions operate on exit codes and string outputs, not on structured JSON fields. There is no checkpoint/resume primitive; a failed workflow reruns from the beginning of the failed job. Kondi's multi-model council model is entirely outside what GitHub Actions was designed for.

**Prefect, Temporal, and Apache Airflow** are the canonical checkpointing and DAG-with-branches platforms. All three support **durable execution** (task-level retry and resume), first-class conditional branching on typed outputs, and observability dashboards. Temporal in particular offers deterministic workflow replay that makes Kondi's Feature 3 look modest by comparison. However, none of these platforms has a concept of a "council" step — they orchestrate functions, not multi-persona LLM deliberations. Integrating them with Kondi would require wrapping each council step as an opaque function call, losing the ledger/phase visibility that makes Kondi's pipeline model distinct. Their branching DSLs (Prefect's `@task` + `if/else`, Airflow's `BranchPythonOperator`) require writing Python/Go code, not inline JSON expressions — a higher barrier for pipeline authors who work in JSON config files.

**LangGraph and LangChain pipelines** are the closest LLM-native analogs. LangGraph explicitly supports graph-based branching with typed state channels, per-node streaming callbacks, and (via LangSmith) per-call token and cost telemetry. LangChain's callback system (`LLMStartHandler`, `LLMEndHandler`) provides exactly the per-call observability that Kondi's Feature 1 would add. The gap: neither tool has Kondi's multi-role council model (manager/consultant/worker personas with structured deliberation phases), neither runs council orchestration as a reusable pipeline step, and neither integrates with the CLI-based providers (`anthropic-cli`, `openai-cli`) that Kondi routes through. LangGraph's cost telemetry requires LangSmith (a hosted SaaS product); Kondi's Feature 1 keeps cost visibility local and zero-dependency.

**Key differentiator:** No existing tool combines (1) multi-model council steps with distinct persona roles, (2) a CLI-first execution model with provider-level routing, and (3) a JSON-based pipeline schema. Kondi's three roadmap features close the observability, branching, and resilience gaps that make it competitive with these tools for teams that need the council model.

---

### (b) User Needs

Three concrete friction points motivate these features for CLI pipeline authors running Kondi today:

**No live cost visibility.** A Kondi pipeline step running a full `DeliberationOrchestrator` council with three personas on a large-context task can consume tens of thousands of tokens per call, per round, across multiple rounds. With the Smart Router selecting models dynamically (a `route:<profile>` model may resolve to `claude-opus-4` or `gpt-5.5` depending on the phase), the actual per-call cost is invisible until the pipeline finishes and `kondi-execution-report.json` is written. For a 12-step pipeline using Opus-class models, a pipeline author has no actionable signal to abort a runaway cost spike before it completes. This is especially acute in council pipelines because a single persona call that returns an unexpectedly long output cascades into downstream rounds with inflated context windows.

**No first-class conditional branching on structured outputs.** When a council step produces a JSON output (`outputType: 'json'`) with fields like `{ "confidence": 0.85, "proceed": true }`, there is no built-in pipeline primitive to branch on `confidence > 0.8` without writing an external shell script (`script` step calling `jq`). The existing `condition` step supports only string-pattern matching (`contains`, `regex`, `equals`) on the rendered text output, which requires the pipeline author to embed structured data in a string and then match against it — a fragile anti-pattern. This friction forces authors toward external scripting for what should be a configuration-level concern.

**No recovery path after mid-run failures.** A pipeline that crashes at step 8 of 12 — due to a network timeout, a provider rate limit, or a process kill — must be fully restarted. Steps 1–7 re-spend their entire LLM budget from scratch. For pipelines running council steps with premium models, this can mean re-spending hours of wall-clock time and substantial API costs. The absence of a checkpoint/resume primitive makes Kondi pipelines brittle for any run that exceeds the reliability window of its slowest provider, which is a fundamental barrier to running long-form research or code-generation pipelines in production.

---

### (c) Industry Trends

Three macro trends in the LLM tooling space make these features timely:

**LLM cost optimization pressure.** As multi-model orchestration moves from prototype to production, cost control has become a primary engineering concern. The emergence of "router" products (OpenRouter, Martian, Not Diamond) that select models by cost/quality tradeoff reflects industry demand for spend visibility and optimization. The OpenTelemetry for LLM calls initiative (OpenLLMetry, Arize Phoenix, LangSmith) is standardizing per-call token and cost instrumentation as table-stakes observability. Kondi's Feature 1 aligns with this trend by surfacing the same per-call metadata (model, tokens, estimated cost) that these tools track — but locally, without a hosted backend, which is appropriate for CLI-first developer workflows.

**Structured multi-model orchestration as a pattern.** The judge/worker/reviewer pattern — where different model instances play distinct roles in a structured deliberation — has become a recognized architectural primitive in LLM systems. Papers and frameworks covering LLM-as-judge, multi-agent debate, and council deliberation (Anthropic's Constitutional AI feedback loops, Google's mixture-of-agents research) validate Kondi's council model as architecturally sound. The industry is converging on typed state machines for orchestration (LangGraph's state channels, CrewAI's task delegation, AutoGen's conversation threading), which reinforces the case for Feature 2's `decision` step as a first-class branching primitive rather than a workaround.

**Growing expectation of pipeline durability.** Temporal's growth, the widespread adoption of Prefect's task-level retry semantics, and GitHub Actions' move toward reusable workflow fragments all signal that developers expect DAG runners to be durable by default. For LLM pipelines specifically, the cost of re-running a failed step is qualitatively different from re-running a deterministic function — it is non-deterministic, expensive, and time-consuming. This creates strong demand for checkpoint/resume support in any LLM pipeline runner operating at production scale, making Feature 3 a correctness-table-stakes feature rather than a nice-to-have.

---

## Feature 1 — Real-Time Progress & Cost Telemetry
**Effort: M**

### User Value

Today the CLI prints only a one-liner when each persona finishes (`"Done (X tokens, Y.Xs)"`) and a total token count per step in `kondi-execution-report.json` after the job finishes. A pipeline author running a 12-step council job has no idea whether the current step is consuming 5k tokens or 500k tokens until it is too late to abort. There is no per-call model identity (especially important when Smart Router `route:<profile>` picks models dynamically), no per-step cost accumulation, and no final cost table. This feature surfaces that information live to `stderr` so authors can make informed decisions mid-run.

### Implementation Approach

**Where LLM results are currently discarded:**

In `run-pipeline.ts` (the CLI entry point), the `invokeAgent` callback wraps `callLLM()` and already receives the full `AgentResponse` — including `result.tokensUsed` and `result.latencyMs` — at line 532. It logs a single line and returns `{ ...result, sessionId }`. The `tokensUsed` value in the response propagates to the ledger entry inside the orchestrator (`DeliberationOrchestrator.invokeAgentSafe()` and `CodingOrchestrator.invokeAgentSafe()`), but the executor callback in `run-pipeline.ts` never re-emits this data as a structured telemetry event. Post-step, `onStepComplete` in `run-pipeline.ts` (line 598) receives only the step-level `artifact` (which carries `artifact.metadata?.tokensUsed` — a single aggregate for the whole step), not per-call breakdowns.

**What `llm-router.ts` provides:**

`simpleCompletion()` in `llm-router.ts` (line 268) returns `SimpleCompletionResult { content, tokensUsed, latencyMs }`. The `tokensUsed` field is a rough character-based estimate from `estimateTokens()` (`Math.ceil(text.length / 4)`). The model used is the same model passed in by the call site (available as `persona.model` in the invokeAgent callback). The provider is `persona.provider`. A cost estimate can be computed by combining model identity with a simple static rate table (cost per 1M tokens) — `services/cost.ts` already has `getModelCostRates` precedent for this.

**Uniform interception without patching either orchestrator:**

Both `DeliberationOrchestrator` and `CodingOrchestrator` call the same `invokeAgent` callback injected from the executor. This means **the `invokeAgent` wrapper in `run-pipeline.ts` is the single interception point for all LLM calls from both orchestrators** — no orchestrator-level changes are required. The implementation approach is:

1. **`run-pipeline.ts`**: Augment the `invokeAgent` wrapper to emit a telemetry event to `process.stderr` immediately after `callLLM()` returns. The event includes: current step name (from `stepTimers` context), persona name, `persona.provider`, `persona.model`, `result.tokensUsed`, and an estimated cost (rate-table lookup). Also accumulate these events in a `telemetryEvents[]` array for the final summary.

2. **`run-pipeline.ts`**: After pipeline completion (success or failure), print a final cost table to `stderr` summarizing: total calls, total estimated tokens, total estimated cost, and a per-model breakdown.

3. **`run-pipeline.ts`**: Add an `onAgentComplete` structured event to `PipelineExecutorCallbacks` in `executor.ts` (a new optional callback `onAgentComplete?: (stepId: string, persona: Persona, tokensUsed: number, latencyMs: number, model: string) => void`) and wire it from `run-pipeline.ts`. Both orchestrators call `config.invokeAgent`, so both trigger the same callback without modification.

4. **`executor.ts`**: The new `onAgentComplete` callback is added to `PipelineExecutorCallbacks` (interface at line 53). The executor calls it from within its own `invokeAgent` wrapper at the point where `callLLM()` returns — this is the natural aggregation point since the executor constructs this callback and both orchestrators receive it.

**Files to modify:** `mcp-connect-mvp/cli/run-pipeline.ts`, `mcp-connect-mvp/src/pipeline/executor.ts`

**Files to read-only reference:** `mcp-connect-mvp/src/services/llm-router.ts` (for return type shape), `mcp-connect-mvp/src/services/cost.ts` (for rate-table patterns)

### SPEC.md Impact

**Section 7 "CLI Pipeline Runner"** requires an update to the Flags table to document the new `--no-telemetry` flag (opt-out) and to add a new subsection "Real-Time Telemetry" describing the stderr event format and the final cost table structure.

**Section 8 "Unified LLM Router"** should note that the `invokeAgent` wrapper in the CLI executor is the designated hook point for per-call telemetry observation — callers must not add separate telemetry tracking in individual orchestrators.

---

## Feature 2 — `decision` Step Type for Conditional Flow
**Effort: S–M**

### User Value

Pipeline authors today have two ways to branch: a `condition` step (which evaluates a string expression with `contains`/`regex`/`equals` modes against a rendered text input) and external scripting. Neither allows access to structured JSON field values from the previous step's output for branching logic. If a previous `analysis` step produces `{ "confidence": 0.85, "recommendation": "proceed" }` with `outputType: 'json'`, there is no built-in way to branch on `confidence > 0.8` without writing a shell script. The `decision` step fills this gap as a first-class pipeline primitive: it evaluates a JavaScript expression in a `vm` sandbox against the parsed JSON from the previous step, producing `continue`, `skip_next_stage`, or `stop` — the same routing actions already supported by `condition`.

### Implementation Approach

**Schema change in `pipeline/types.ts`:**

Three changes are needed:

1. Add `'decision'` to `PIPELINE_STEP_TYPES` (line 11) and `STEP_TYPE_LABELS` (line 19).

2. Add a new `DecisionStepConfig` interface parallel to `ConditionStepConfig`:

```typescript
export interface DecisionStepConfig {
  type: 'decision';
  /** A JavaScript expression evaluated against the input. Must return true/false. */
  expression: string;
  /** Template that renders previous step outputs as the `input` variable in scope. */
  inputTemplate: string;
  /** Action when expression evaluates to truthy */
  trueAction: ConditionAction;
  /** Action when expression evaluates to falsy or throws */
  falseAction: ConditionAction;
  /** Include pipeline's initial input as additional context, regardless of stage */
  includePipelineInput?: boolean;
}
```

3. Add `DecisionStepConfig` to the `StepConfig` union (line 243):
```typescript
export type StepConfig = CouncilStepConfig | LlmStepConfig | GateStepConfig | ScriptStepConfig | ConditionStepConfig | DecisionStepConfig;
```

4. Update `isCouncilType()` (line 246) to exclude `decision`:
```typescript
export function isCouncilType(type: PipelineStepType): boolean {
  return type !== 'gate' && type !== 'script' && type !== 'condition' && type !== 'decision';
}
```

**Handler in `executor.ts`:**

The existing `runConditionStep()` method (lines 866–918) is the direct model. Add a `runDecisionStep()` private method and wire it in `runStep()` (the dispatch block at line 554) with:

```typescript
} else if (step.config.type === 'decision') {
  artifact = await this.runDecisionStep(pipelineId, step, previousArtifacts);
}
```

The `runDecisionStep()` method:

1. Renders the `inputTemplate` via `renderInputTemplate()` (the same helper used by all other step types).
2. Attempts to parse the rendered input as JSON. If parsing fails, the sandbox receives `{ input: rawText }` (string fallback).
3. Builds a sandbox object: `{ input: parsedJson }` where `parsedJson` is the result of `JSON.parse(renderedInput)`. The `input` variable matches the `{{input.fieldName}}` template convention already established in `renderInputTemplate()`.
4. Evaluates `config.expression` using Node.js built-in `vm.runInNewContext(expression, sandbox, { timeout: 500 })`. The 500ms timeout prevents infinite loops. A thrown error or non-truthy result triggers `falseAction`.
5. Applies the resulting action (`skip_next_stage` or `stop`) using the same `this.skipNextStage` / `this.stopPipeline` flags that `runConditionStep()` uses (lines 905–909).

**`vm` module — security note:** Node.js `vm.runInNewContext()` provides expression-level isolation (separate variable scope) but does NOT provide OS-level sandboxing. The evaluated code runs in the same Node.js process and can access global objects if the sandbox prototype chain is not frozen. For the CLI use case (pipeline author controls the pipeline JSON), this is an acceptable risk consistent with how `script` steps already allow arbitrary shell commands. The sandbox should be created with `Object.create(null)` as the prototype to prevent prototype chain escapes: `const sandbox = Object.assign(Object.create(null), { input: parsedJson })`.

**Files to modify:** `mcp-connect-mvp/src/pipeline/types.ts`, `mcp-connect-mvp/src/pipeline/executor.ts`

**No new dependencies:** Node.js `vm` module is a built-in — zero new npm packages required.

### SPEC.md Impact

**Section 5 "Pipeline Steps — Step Types table"** requires a new row for `decision`: `| decision | None | None | Evaluation result | Evaluates JS expression against parsed input JSON; actions: continue, skip_next_stage, stop |`

**Section 5 "PipelineStepType"** union string must add `'decision'`.

**A new Section 5a-5 "Decision Step Config"** should be added immediately after 5a-4 (Condition Step Config), documenting the `DecisionStepConfig` interface, the `vm` sandbox contract (`input` variable contains the parsed JSON from the last artifact), the `falseAction` fallback on expression throws, and the security caveat.

**Section 5b "Pipeline Store Schema"** — `StepConfig` union must add `DecisionStepConfig`.

---

## Feature 3 — Checkpoint & Resume for Pipeline Resilience
**Effort: L**

### User Value

A long pipeline that fails at step 8 of 12 currently requires a full restart — every LLM call from steps 1–7 must be re-run, re-spending the entire prior budget. For pipelines running council steps with Opus models, that could mean hours and hundreds of dollars re-spent on already-completed work. This feature serializes the full pipeline state to a checkpoint file after each step completes, and adds a `--resume <checkpoint-file>` CLI flag to skip all already-completed steps and resume from the first non-completed step.

### Implementation Approach

**What constitutes "enough state to resume" — DeliberationOrchestrator:**

The `DeliberationOrchestrator` itself holds only two instance variables: `config` (callbacks, not serializable) and `activeCouncilId`. All deliberation state is stored in `councilStore.deliberationState` which includes: `currentPhase`, `currentRound`, `revisionCount`, `reDeliberationCount`, `activeContextId`, `contextVersion`, `pendingPatches[]`, `roundSummaries{}`, `finalDecisionId`, `currentOutputId`, `workDirectiveId`, `managerEvaluation`, `completionSummary`.

Beyond `deliberationState`, all artifact content is stored in `councilDataStore` under the per-council key patterns: `context-{councilId}`, `context-history-{councilId}`, `context-patches-{councilId}`, `decision-{councilId}`, `plan-{councilId}`, `directive-{councilId}`, `outputs-{councilId}`, `ledger-index-{councilId}`, and `ledger-chunk-{councilId}-{n}` (n = 0,1,2,...).

A complete checkpoint for a `DeliberationOrchestrator`-backed step requires serializing: the council object from `councilStore`, its `deliberationState`, and all `councilDataStore` keys prefixed with the council ID.

**What constitutes "enough state to resume" — CodingOrchestrator:**

The `CodingOrchestrator` holds: `config`, `activeCouncilId`, `phaseRetryCount` (transient, can reset). All persistent state is in `councilStore.deliberationState` which additionally carries: `moduleDecomposition` (with `modules[]`, `integrationNotes`, `testStrategy`, `buildCommand`, `installCommand`), `moduleOutputs` (`Record<string, string>`), `reviewCycleCount`, `debugCycleCount`. The same `councilDataStore` key sets apply as for the deliberation orchestrator (ledger chunks, context artifacts, output artifacts).

**Checkpoint serialization via `CouncilDataStore`:**

The `councilDataStore` singleton (exported from `storage-cleanup.ts`) provides `getItem(key)` and `setItem(key, value)`. There is no bulk-read API, but all council-related keys follow the patterns listed in SPEC Section 9. To collect a council's full snapshot:

1. Read the council object from `councilStore.get(councilId)` (includes `deliberationState`).
2. Enumerate and read all `councilDataStore` keys matching the per-council patterns for that council ID (context, ledger-index, ledger-chunk-\*, decision, plan, directive, outputs).
3. Serialize the snapshot — `{ pipeline, executionLog, completedStepIds, councilSnapshots: Record<councilId, { council, storeKeys }> }` — to a JSON file on disk via Node.js `fs.writeFileSync`.

The checkpoint file is written **after** `pipelineStore.setStepStatus(pipelineId, step.id, 'completed')` and `callbacks.onStepComplete?.(step.id, artifact)` in `executor.ts` (line 568). This ensures the checkpoint is only written when a step fully completes.

On `--resume`, the checkpoint JSON is loaded, `councilDataStore.setItem(key, value)` is called for all serialized keys to restore in-memory state, and the pipeline's step statuses are restored before `executor.run()` is called. The executor already skips completed steps (`if (step.status === 'completed' || step.status === 'skipped') return;` at line 545), so no changes to the execution loop itself are required for the skip behavior.

**Serialization complexity risk:** The primary risk is ledger chunk completeness. Ledger chunks (`ledger-chunk-{councilId}-{n}`) are written incrementally as the orchestrator runs; the `ledger-index-{councilId}` key tracks which chunks exist. If the checkpoint is written mid-phase (before a council step's artifact is set), the ledger may be partially written. This is mitigated by writing checkpoints only after a step's `artifact` is confirmed (post `setStepArtifact` + `setStepStatus(..., 'completed')`). However, a failure between `setStepStatus('running')` and `setStepStatus('completed')` will still require re-running the step from scratch — the checkpoint only covers fully-completed steps.

**New CLI flag — `--resume <checkpoint-file>` in `run-pipeline.ts`:**

The `parseArgs()` function (line 87) is extended to parse `--resume <path>`:

```typescript
} else if (args[i] === '--resume' && args[i + 1]) {
  resumeFrom = path.resolve(args[++i]);
}
```

This follows the same `--working-dir` pattern already in `parseArgs()`. The checkpoint file path is passed as a regular flag value — no prompt injection risk since it is a file path, not user content piped to any LLM. This is consistent with constraint (4): prompts are always piped via stdin, not passed as positional args; file paths as flag values are a distinct safe pattern.

When `resumeFrom` is set, the main function loads the checkpoint JSON, calls `restoreCheckpoint(checkpointData)` (a new helper that calls `councilDataStore.setItem()` for all stored keys and updates `pipelineStore` step statuses), then calls `executor.run(pipeline.id)` normally. The executor skips all already-completed steps automatically.

**Files to modify:** `mcp-connect-mvp/cli/run-pipeline.ts`, `mcp-connect-mvp/src/pipeline/executor.ts`

**Files to read:** `mcp-connect-mvp/src/council/storage-cleanup.ts` (councilDataStore API), `mcp-connect-mvp/src/council/store.ts` (councilStore get/set API), `mcp-connect-mvp/src/pipeline/store.ts` (pipelineStore setStepStatus API)

### SPEC.md Impact

**Section 7 "CLI Pipeline Runner — Flags table"** requires a new row: `| --resume <path> | Load a checkpoint file and skip already-completed steps |`

**Section 7** should also add a new subsection "Checkpoint Files" documenting: file location convention (`<working-dir>/kondi-checkpoint-<pipeline-id>.json`), when checkpoints are written (after each step completes), what is serialized (pipeline state + council snapshots), and rollback semantics (steps still in 'running' state at crash time will be re-run on resume).

**Section 9 "Data Storage — Key Namespaces"** requires a new row for the checkpoint file key pattern: `| kondi-checkpoint-{pipelineId} | (file, not localStorage) | Checkpoint written after each step; consumed by --resume |`

---

## Independence Confirmation

Each feature is independently shippable without any other being present. Feature 1 (telemetry) adds a new callback to `PipelineExecutorCallbacks` and wraps the `invokeAgent` handler — it requires no schema changes and no new step types. Feature 2 (decision step) adds a new type to `PIPELINE_STEP_TYPES`, a new config interface, a new executor handler, and an `isCouncilType()` exclusion — it does not touch the telemetry system or checkpoint logic. Feature 3 (checkpoint/resume) adds checkpoint writes in `executor.ts` and a `--resume` flag in `run-pipeline.ts` — it operates on the existing completed-step skip logic already in the executor and does not require the `decision` step type or the telemetry event system. Teams can ship Feature 2 in a single sprint, Feature 1 in one to two sprints, and Feature 3 in two to three sprints in any order.

## Architectural Constraints Checklist

- **No credential fallover.** All three features route LLM calls exclusively through the existing `invokeAgent` callback and `callLLM()` / `llm-router.ts` pipeline. No feature description implies or allows falling back from `anthropic-cli` to `anthropic-api` or vice versa. Feature 1's telemetry reads `persona.provider` as-is and records it verbatim — it does not alter provider selection. ✅

- **Storage through `CouncilDataStore`.** Feature 3's checkpoint writes use `councilDataStore.setItem(key, value)` (the singleton from `storage-cleanup.ts`) to serialize in-memory council state, and `councilDataStore.getItem(key)` to enumerate keys during serialization. The final checkpoint JSON is written to disk via Node.js `fs.writeFileSync` (appropriate for a persistent file), but all in-memory council data flows through `councilDataStore`, not raw `localStorage`. ✅

- **Isolated conversation IDs.** No feature alters persona call routing or conversation ID assignment. Feature 1 observes calls passively via the `invokeAgent` wrapper. Features 2 and 3 do not introduce persona calls. The existing `council-<uuid>` isolation (enforced by the orchestrators) is preserved. ✅

- **stdin piping for CLI args.** Feature 3's `--resume <checkpoint-file>` flag takes a file path value following the `--flag value` pattern already used by `--working-dir`. No prompt content is ever passed as a positional argument. Feature 1 adds a `--no-telemetry` opt-out flag that takes no value. Both follow the established pattern in `parseArgs()`. ✅

- **Both orchestrators covered.** Feature 1 intercepts all LLM calls via the single `invokeAgent` callback that is injected into both `DeliberationOrchestrator` and `CodingOrchestrator` from `executor.ts` — one patch covers both. Feature 3 serializes council snapshots for any council step regardless of which orchestrator ran it; the checkpoint writer reads from `councilStore` and `councilDataStore` key patterns that both orchestrators use identically. ✅

- **`isCouncilType()` exclusion.** Feature 2's `decision` step type is explicitly excluded from `isCouncilType()` in `pipeline/types.ts` (line 246), parallel to the existing exclusions of `gate`, `script`, and `condition`. This ensures `decision` steps are not dispatched to the council orchestration path in `executor.ts`'s `runStep()` method. ✅
