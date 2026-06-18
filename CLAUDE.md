# Kondi — Multi-LLM Council Pipeline Platform

Tauri desktop app (Rust + React/TypeScript) that orchestrates multi-model "councils" as pipeline workflow steps. Each step spawns a deliberation with Manager/Consultant/Worker roles across any LLM provider.

## Key Paths

| What | Path |
|------|------|
| Tauri backend | `mcp-connect-mvp/src-tauri/src/commands.rs` |
| Pipeline types & executor | `mcp-connect-mvp/src/pipeline/types.ts`, `executor.ts` |
| Council types & orchestrators | `mcp-connect-mvp/src/council/types.ts`, `deliberation-orchestrator.ts`, `coding-orchestrator.ts` |
| Council factory (defaults) | `mcp-connect-mvp/src/council/factory.ts` |
| LLM routing (unified) | `mcp-connect-mvp/src/services/llm-router.ts` |
| Model availability probe | `mcp-connect-mvp/src/services/modelProbe.ts` |
| Model catalog sync (live /models lists) | `mcp-connect-mvp/src/services/modelCatalogSync.ts` |
| Smart Router (per-phase model selection) | `mcp-connect-mvp/src/router/` (`index.ts`, `resolve.ts`, `profile-options.ts`, `profiles.ts`) |
| Claude CLI client | `mcp-connect-mvp/src/services/claudeCliClient.ts` |
| Codex CLI client | `mcp-connect-mvp/src/services/codexCliClient.ts` |
| MCP proxy service | `mcp-connect-mvp/src/services/proxyService.ts` |
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

9. **No credential fallover between CLI and API.** When a persona specifies `provider: 'anthropic-cli'`, the system must NEVER fall back to `anthropic-api` (or vice versa). All completions go through `llm-router.ts` which dispatches to the correct client based on provider ID. CLI providers (`anthropic-cli`, `openai-cli`) spawn their CLI binaries; API providers use direct HTTP. The `upsertProfile()` function resets failure state when credentials change to prevent stale `failCount` from blocking fresh tokens.

10. **All LLM completions go through `llm-router.ts`.** Chat, council, and pipeline all call `chatCompletion()` or `simpleCompletion()` from the unified router. No call site may import or call a provider client directly for completions. CLI providers use session resumption (`--resume` / `resume --last`) for multi-turn chat; council/pipeline calls are stateless one-shot.

11. **MCP tools for CLI providers go through local proxies.** CLI binaries can't use Kondi's MCP connections directly. The router calls `mcpClient.ensureProxiesForServers()` before LLM calls to start local proxy processes that bridge auth. Proxies are synced to `~/.claude.json` and `~/.codex/config.toml` so the CLI binaries discover them.

12. **Server persistence: Tauri store is source of truth.** User-added servers are persisted via `save_server_config` (Rust backend → `~/.local/share/kondi/servers.json`). localStorage is a cache that gets rebuilt from Tauri on startup. The startup flow loads Tauri first, merges localStorage second, registers built-ins third, then auto-reconnects — this order prevents race conditions that overwrite localStorage with incomplete data.

13. **Routed profiles are pseudo-models, resolved in `llm-router` before dispatch.** The "Smart Router" (`src/router/`) exposes six budget profiles as selectable models with id `route:<profile>` and provider `'router'` (`ROUTED_PROFILE_OPTIONS`). When `chatCompletion()`/`simpleCompletion()` see a routed model, they call `resolveRoutedModel(profile, phase, prompt)` to get a concrete `{provider, model}`, then dispatch normally. Pass `routePhase` (a `LedgerPhase`) from the call site — orchestrator invokers derive it from `persona.preferredDeliberationRole` via `roleToPhase()` (manager→dispatch, consultant→discuss, worker→execute, reviewer→reflect); chat defaults to `discuss`. **Pure helpers (`isRoutedModel`, `roleToPhase`, `ROUTED_PROFILE_OPTIONS`) live in `router/profile-options.ts`** — import those from selectors/CLI, NOT `router/resolve.ts` (which pulls in webview-only `simpleCompletion` + `auth-profiles`). The CLI has its own resolution in `cli/llm-caller.ts`. The learned NN tier from kondi-chat is intentionally not ported (needs offline-trained weights). **Profiles are user-manageable** (Settings → Routing, `RouterProfilesSettings.tsx`): `router/profile-store.ts` persists custom/edited profiles (localStorage `kondi-router-profiles`) layered over `BUILTIN_PROFILES`; `getEffectiveProfile()`/`getMergedProfiles()`/`getProfileOrder()` expose the merge. `resolve.ts` resolves via `getEffectiveProfile()` (custom > built-in), so added/edited profiles route everywhere. Dropdowns call `getRoutedProfileOptions()` (dynamic, merged) and re-render on `ROUTER_PROFILES_EVENT` via the `useRouterProfilesVersion()` hook — wired in ChatArea, AddPersonaModal (also covers the pipeline step picker), and RoleAssignment. So added/edited profiles appear in every model dropdown live, no reload.

14. **Broken models are auto-hidden, not removed from the catalog.** `modelProbe.ts` remembers per-model availability (localStorage `kondi-model-status`) so selectors never offer a model the user's account/plan can't use (e.g. a ChatGPT Codex account rejecting `gpt-5.3-codex`). Policy = **hide only proven-broken**: a model is hidden ONLY if a probe/live call definitively failed it (`classifyModelError → 'broken'`: "not supported"/"not found"/invalid/404/400-with-model); untested, last-known-good, and soft-failed (auth/network) models stay visible. Two triggers: (a) AUTOMATIC — `chatCompletion()` wraps its dispatch and calls `recordModelCallFailure(model, prov, err)` on throw (and `recordModelCallSuccess` clears stale flags on success); (b) MANUAL — the "Refresh models" button in `ProviderSettings` calls `probeAllModels()` (tiny one-shot per configured-provider model, concurrency 4). Selectors filter via `filterVisibleModels()` and subscribe via the `useModelStatus()` hook (`ChatArea`, `AddPersonaModal`, `RoleAssignment`; pipeline persona picker reuses `AddPersonaModal`). The catalog (`config/models.ts`) is never mutated. **CLI model IDs (`OPENAI_CLI_MODELS`, `CODEX_MODELS`) are verified against the installed Codex binary (v0.139.0: `gpt-5.5`/`gpt-5.5-pro`/`gpt-5.4`/`gpt-5.4-mini`/`gpt-5.4-nano`/`gpt-5.x-codex`); default `openai-cli` model is `gpt-5.5`.** Refresh these when `codex update` bumps the set.

15. **Claude CLI write containment is enforced by a PreToolUse hook, never by Claude Code's permission flags.** Council workers run the `claude` binary with `bypassPermissions` + full tools, so without a guard they can write ANYWHERE — a worker once resolved a "docs/" directive against the parent kondi git repo and wrote into the real project `docs/`, escaping its `directoryConstrained` working dir. Empirically (headless `--print`): `--permission-mode acceptEdits` still writes escapes, absolute `--allowedTools "Write(//abs/**)"` rules silently fail to match, and `bypassPermissions` disables confinement entirely. The ONLY reliable mechanism is a `PreToolUse` hook (fires under every permission mode). `src/services/cli-workdir-guard.ts` exports `buildWorkdirGuardSettings()` → a `--settings` object whose hook (matcher `Write|Edit|MultiEdit|NotebookEdit|Bash`) resolves the real target path and **denies any write outside the working dir** (root = hook payload `cwd`, fallback `KONDI_WORKDIR` env); Bash redirects/mutations to absolute paths outside the dir are blocked (reads allowed). It is a self-contained base64 `node -e` command (no on-disk file → works from the webview). Installed by BOTH `cli/claude-caller.ts` and `src/services/claudeCliClient.ts`. Do NOT rely on the system-prompt "working directory override" text — it is advisory only.

The "Refresh models" button ALSO runs `modelCatalogSync.ts` for API providers: it fetches each provider's live `GET /models` list (via the clients' existing `listModels()`) and reconciles vs the catalog → `confirmed` / `staleInCatalog` / `missingFromCatalog` (persisted to `kondi-catalog-sync`). This is the API-side equivalent of reading the Codex binary's model list, and is **advisory only** — it surfaces drift but never hides a model itself (the live probe remains the sole authority for hiding, since `/models` lists can be incomplete). Discoverable providers: `anthropic-api`, `openai-api`, `deepseek`, `xai`, `zai`, `nvidia-router`, `ollama` (Google/cloudcode-pa and CLI providers are excluded).

## Self-Update Protocol

Any LLM agent modifying this codebase: when you change any of the following, update `docs/SPEC.md` to match:
- Step types, orchestrator phases, or entry types
- Council defaults (rounds, revisions, token budget)
- Provider IDs or LLM adapter routing logic
- localStorage key namespaces
- CLI flags or runner behavior
- New systemic bugs fixed

If available, run `/update-spec` to verify SPEC.md is current against source files.
