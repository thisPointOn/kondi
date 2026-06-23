# Kondi Subagents (spec)

## Goal

Let a council persona **delegate part of its work to subagents** — focused, one-shot
helpers that each run on **any** provider/model (Claude, GPT, Gemini, DeepSeek, Grok,
GLM, Ollama, or a routed profile). A worker can fan out research / sub-analysis /
parallel drafts to cheap fast models, then synthesize the final deliverable itself.

This is provider-agnostic by construction: every subagent call goes through
`llm-router.ts` exactly like a persona, so each subagent picks its own model
independently.

## Model

A persona gains an optional `subagents` list:

```ts
interface SubagentSpec {
  id: string;
  name: string;            // e.g. "Researcher", "API-checker"
  provider: string;        // any provider id (incl. 'router')
  model: string;           // any model id (incl. 'route:<profile>')
  systemPrompt?: string;   // optional role framing
  task: string;            // what this subagent should produce; may use {{directive}}
  enabled?: boolean;       // default true
}

// on Persona:
subagents?: SubagentSpec[];
```

## Execution (v1 — worker fan-out)

When a worker persona with `subagents` runs its directive, the orchestrator, BEFORE the
worker's own call:

1. Renders each enabled subagent's `task` (`{{directive}}` → the work directive).
2. Runs all subagents **in parallel**, each via the existing `invokeAgent` callback (so:
   router dispatch, MCP proxies, no CLI↔API fallover — same rules as personas). Each gets
   its own isolated `council-<uuid>` conversation id (rule #2). Tools are off for subagents
   in v1 (they advise/produce text; the worker remains the one that writes).
3. Records each result as a ledger entry attributed to the worker, type `analysis`, phase
   `executing`, content prefixed `[Subagent: <name> · <provider>/<model>] …` (so it's
   visible in the timeline without adding a new entry type — rule #1).
4. Injects the combined findings into the worker's execution prompt as a
   `SUBAGENT FINDINGS` block; the worker synthesizes the final deliverable.

Failures are non-fatal: a subagent that errors is logged and skipped; the worker still runs.

Bounds: at most `N` subagents per persona (default 4), parallel, each with the standard
per-call timeout. No nesting in v1 (a subagent cannot itself spawn subagents).

## Where it plugs in

- `src/council/types.ts` — `SubagentSpec` + `Persona.subagents`.
- `src/council/deliberation-orchestrator.ts` — `runSubagents(council, persona, directive)`
  helper, called at the top of worker execution (`executeWork` / direct-execution path).
  Returns the findings string injected into `buildWorkerExecutionPrompt`'s directive.
- (later) coding orchestrator `implementModules` can reuse the same helper per module.
- UI (follow-up): an "Subagents" editor on the persona/worker config (AddPersonaModal /
  RoleAssignment), each row a model picker (reusing the provider-agnostic selector) + task.

## Roadmap

- **v1 (this pass):** data model + worker fan-out engine + ledger visibility. Subagents
  configured in the persona object (JSON / programmatic); minimal/no dedicated UI yet.
- **v2:** persona-config UI (model picker per subagent, task editor), enable for manager
  (analysis fan-out) and reviewer.
- **v3:** worker-*dynamic* spawning (the worker decides at runtime how many subagents and
  what each does, via a `spawn_subagents` directive the orchestrator executes), and
  optional tool access per subagent.
