# Prepare Distribution Build

Create a clean, Anthropic-TOS-compliant distribution branch with CLI subscription providers removed. This branch is disposable — main is never modified.

## Process

### 1. Branch Setup

- Confirm we are on `main` (or whatever branch the user is currently on) and the working tree is clean. If there are uncommitted changes, STOP and tell the user.
- Create and checkout a new branch: `dist/v<version>` where `<version>` comes from `mcp-connect-mvp/package.json`. If the branch already exists, delete it first.

### 2. Strip CLI Providers

Remove all code paths that route through the Claude Code CLI (`claude` binary) or Codex CLI (`codex` binary) using consumer subscription OAuth tokens. Keep all API-key-based providers intact.

**Files to modify (read each one first, then make targeted edits):**

#### `mcp-connect-mvp/src/config/models.ts`
- Remove the `ANTHROPIC_CLI_MODELS` array entirely
- Remove the `OPENAI_CLI_MODELS` array entirely
- Remove `'anthropic-cli'` and `'openai-cli'` from the `ModelProvider` type
- Update `ALL_MODELS` to exclude the removed arrays
- Remove CLI entries from `resolveProvider`, `resolveDefaultModel`, `OPENAI_CLI_TO_API_MODEL`, and `getModelsForPersonaSelector`
- Keep all API models and DeepSeek/Google models

#### `mcp-connect-mvp/src/services/claudeCodeWrapper.ts`
- Gut the implementation: replace `call()`, `checkInstalled()`, `checkAuthenticated()` with stubs that return failure/false
- Keep the class and its interface so imports don't break — just make every method a no-op or return a failure result
- Add a comment: `// CLI wrapper disabled in distribution build`

#### `mcp-connect-mvp/src/services/claudeCliClient.ts`
- Same approach: stub out all methods to return empty/failure results
- Keep the exports so nothing breaks

#### `mcp-connect-mvp/src/hooks/useProviderConfig.ts`
- Find the provider definitions/cards for `anthropic-cli` and `openai-cli` — remove them from the provider list
- Remove CLI login button handlers (`handleStartOAuthLogin` paths for CLI)
- Keep API provider cards intact

#### `mcp-connect-mvp/src/services/startupValidator.ts`
- Remove the CLI validation paths (where it checks `cliStatus.installed` / `cliStatus.authenticated`)
- Keep API key validation

#### `mcp-connect-mvp/src/services/anthropicClient.ts`
- Remove the CLI chat path (`chatViaCli` method or make it throw "CLI not available in this build")
- Keep the API chat path

#### `mcp-connect-mvp/src/council/llm-adapter.ts`
- If there are CLI-specific routing paths, stub them out

#### `mcp-connect-mvp/src-tauri/src/commands.rs`
- Remove or stub `run_claude_command` and `run_claude_streaming` (make them return an error: "CLI providers not available in distribution build")
- Keep all other Tauri commands (MCP proxy, OAuth for MCP servers, file ops, etc.)
- Update `src-tauri/src/lib.rs` if any commands are removed entirely

#### `mcp-connect-mvp/cli/` directory
- Remove the entire `cli/` directory (the headless CLI pipeline runner spawns `claude`/`codex` directly)

### 3. Update Documentation

#### `README.md`
- Remove all mentions of CLI subscription providers (Anthropic CLI, OpenAI CLI / Codex CLI)
- Remove the CLI Pipeline Runner section entirely
- Update the Supported Models table to only show API providers
- Update the Installation section — remove mentions of `claude` CLI and `codex` CLI
- Update the Configuration section — remove CLI provider setup
- Keep MCP proxy docs (that's for MCP server auth, not LLM provider auth)

### 4. Update Package Metadata

- In `mcp-connect-mvp/package.json`, remove the `cli/` related scripts if any exist

### 5. Verify

Run these in order and fix any issues before proceeding:

```
cd mcp-connect-mvp
npx tsc --project tsconfig.app.json --noEmit
npx vite build
```

If there are type errors from the removed CLI types, fix the imports/references. The goal is a clean compile with zero errors.

### 6. Build Binary

```
cd mcp-connect-mvp
npm run tauri build
```

Report the output binary paths when done.

### 7. Commit on the dist branch

Commit all changes on the dist branch with message: `dist: strip CLI providers for distribution (v<version>)`

### 8. Return to main

Checkout `main` again so the user is back on their working branch. Do NOT merge the dist branch into main.

## Important Rules

- NEVER modify the `main` branch
- NEVER delete or force-push `main`
- Read every file before editing it — the codebase evolves and file contents will change
- When stubbing, keep exports and interfaces intact to avoid cascading import failures
- The dist branch is disposable — it gets recreated from scratch each time
- If something doesn't compile after stripping, FIX it on the dist branch, don't give up
