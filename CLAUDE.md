# Kondi — Multi-LLM Council Pipeline Platform

Tauri desktop app (Rust + React/TypeScript) that orchestrates multi-model "councils" as pipeline workflow steps. Each step spawns a deliberation with Manager/Consultant/Worker roles across any LLM provider.

## Key Paths

| What | Path |
|------|------|
| Tauri backend | `mcp-connect-mvp/src-tauri/src/commands.rs` |
| Pipeline types & executor | `mcp-connect-mvp/src/pipeline/types.ts`, `executor.ts` |
| Council types & orchestrators | `mcp-connect-mvp/src/council/types.ts`, `deliberation-orchestrator.ts`, `coding-orchestrator.ts` |
| Council factory (defaults) | `mcp-connect-mvp/src/council/factory.ts` |
| LLM routing | `mcp-connect-mvp/src/council/llm-adapter.ts` |
| CLI pipeline runner | `mcp-connect-mvp/cli/run-pipeline.ts` |
| Full spec (read when modifying architecture) | `docs/SPEC.md` |

## Critical Rules

1. **All `Record<Phase|EntryType, ...>` maps in UI must cover BOTH orchestrators.** `DeliberationOrchestrator` and `CodingOrchestrator` use different phases and entry types. Missing entries crash the React tree (no error boundary). Files: `PhaseIndicator.tsx`, `LedgerEntryCard.tsx`, `LedgerTimeline.tsx`, `DeliberationView.tsx`.

2. **Council calls must use isolated conversation IDs.** Each persona call needs a unique `council-<uuid>` conversation ID. Sharing IDs accumulates context across personas and causes failures in round 2+.

3. **CLI `--allowedTools` is variadic.** Never pass the prompt as a positional arg to `claude` CLI — always pipe via stdin. Positional args get consumed by `--allowedTools`.

4. **Nested CLI spawns must set `CLAUDECODE=undefined` in env.** Without this, inner Claude processes inherit the outer session and conflict.

5. **Worker prompts must check `writePermissions`.** When `writePermissions=true`, instruct the worker to USE TOOLS to write files. The "text-only agent" framing causes workers to describe code instead of implementing it.

6. **All stores route through `CouncilDataStore` (in-memory primary, localStorage cache).** `storage-cleanup.ts` exports `councilDataStore` — an in-memory `Map<string,string>` with no size limit. `localStorage` is a best-effort mirror; quota errors are silently ignored. This prevents the browser's 5MB localStorage cap from crashing pipelines. Files using it: `context-store.ts`, `ledger-store.ts`, `council/store.ts`, `pipeline/store.ts`, `session-import.ts`. No council data is ever destroyed — `stripCompletedCouncil` only trims the localStorage copy after artifact extraction; in-memory data remains accessible.

7. **`isCouncilType()` excludes gate, script, and condition.** These three step types are not council-based. Script runs a shell command (requires `platform.runCommand`). Condition evaluates an expression and can `skip_next_stage` or `stop`. Both use `inputTemplate` for input but have no council/personas.

8. **JSON output type enables `{{input.fieldName}}` templates.** When a step's `outputType` is `'json'`, downstream steps can access individual fields via `{{input.fieldName}}` or `{{input[N].fieldName}}` (dot-path walk). The content must be valid JSON.

9. **No credential fallover between CLI and API.** When a persona specifies `provider: 'anthropic-cli'`, the system must NEVER fall back to `anthropic-api` (or vice versa). Every `.chat()` call must pass `provId`/`provider` through to the client so `resolveApiKey()` receives a `preferredProfileId`. Files: `llm-adapter.ts`, `gui-caller.ts`, `useChats.ts`, `ChatArea.tsx`. The `upsertProfile()` function resets failure state when credentials change to prevent stale `failCount` from blocking fresh tokens.

## Self-Update Protocol

Any LLM agent modifying this codebase: when you change any of the following, update `docs/SPEC.md` to match:
- Step types, orchestrator phases, or entry types
- Council defaults (rounds, revisions, token budget)
- Provider IDs or LLM adapter routing logic
- localStorage key namespaces
- CLI flags or runner behavior
- New systemic bugs fixed

If available, run `/update-spec` to verify SPEC.md is current against source files.
