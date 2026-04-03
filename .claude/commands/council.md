---
description: "Run a Kondi council deliberation and read the output"
allowed-tools: Bash, Read, Glob, Grep
argument-hint: "[task description] [--working-dir <path>]"
---

# Kondi Council Runner

You have access to the Kondi multi-LLM council system. It runs structured multi-model deliberations with manager, consultant, and worker personas across Claude CLI and OpenAI Codex CLI.

## Absolute Paths

- **CLI:** `/home/erik/Documents/MCP_Connector_App/mcp-connect-mvp/cli/run-council.ts`
- **Configs:** `/home/erik/Documents/MCP_Connector_App/mcp-connect-mvp/configs/councils/`

## Available Configs

| Config | File | Best For |
|--------|------|----------|
| **Analysis** | `analysis.json` | Code review, security audit, quality assessment, finding improvements, critical review |
| **Code Planning** | `code-planning.json` | Planning features, designing architecture, implementation specs, refactoring plans |
| **Coding** | `coding.json` | Implementing code changes with test/debug cycles — worker actually writes files |
| **Debate** | `debate.json` | Architecture decisions, trade-off analysis, should-we-or-shouldn't-we questions |

## How to Map User Requests to Configs

- "review", "analyze", "audit", "find issues", "improve", "critical review" → **analysis.json**
- "plan", "design", "architect", "spec", "how should we build" → **code-planning.json**
- "implement", "build", "code", "write", "fix", "add feature" → **coding.json**
- "debate", "decide", "should we", "compare", "trade-offs", "pros and cons" → **debate.json**

If unclear, default to **analysis.json** for review tasks or **debate.json** for decision tasks.

## Running a Council

**IMPORTANT:** Always use absolute paths. The working directory should be the project the user wants analyzed, NOT the Kondi repo.

```bash
npx tsx /home/erik/Documents/MCP_Connector_App/mcp-connect-mvp/cli/run-council.ts \
  --config /home/erik/Documents/MCP_Connector_App/mcp-connect-mvp/configs/councils/<config>.json \
  --task "The task description" \
  --working-dir <absolute-path-to-target-project> \
  --output full
```

If the user doesn't specify a working directory, use the current working directory.

**Key flags:**
- `--config <path>` — Council config JSON (absolute path)
- `--task "..."` — The problem/task for the council
- `--working-dir <path>` — Target project directory (absolute path)
- `--output <format>` — full (default), abbreviated, output-only, json, none
- `--dry-run` — Preview council structure without running

## After Completion

1. **Find the output directory:**
```bash
ls -td <working-dir>/.kondi/outputs/*/ | head -1
```

2. **Read the key artifacts:**
   - `output.md` — The worker's final deliverable (always read this)
   - `decision.md` — The manager's decision and acceptance criteria
   - `deliberation.md` — Full audit trail of all persona contributions

3. **Summarize findings to the user** — cite specific issues, recommendations, or decisions from the output.

## Execution

Parse the user's request from `$ARGUMENTS` to determine:
1. Which config to use (see mapping above)
2. The task description
3. The working directory (default: current working directory)

Then run the council, wait for completion, read the artifacts, and present the results.

$ARGUMENTS
