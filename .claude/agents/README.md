# Project Subagents

These are **Claude Code subagents** — reusable specialist assistants scoped to this
project. Each is a single Markdown file with YAML frontmatter; Claude can delegate a
task to one (preserving its own context) or you can invoke one explicitly.

## How they work

```markdown
---
name: my-agent                     # kebab-case id
description: When to use this agent # Claude reads this to auto-delegate
tools: Read, Grep, Bash            # optional — omit to inherit all tools
model: sonnet                      # optional — sonnet | opus | haiku | inherit
---

The system prompt: who the agent is, what it does, the rules it follows.
```

- **Location:** `.claude/agents/` (project, checked in & shared) or `~/.claude/agents/`
  (personal, all your projects). Project agents win on name conflicts.
- **Invoke:** ask Claude naturally ("use the council-forensics agent to…") or let it
  auto-delegate based on the `description`. Subagents run in their own context window and
  return a summary, so they're great for read-heavy or repetitive work that would
  otherwise bloat the main conversation.
- **Tools:** list only what the agent needs (least privilege). Omit `tools:` to inherit
  everything the main session has, including MCP tools.

## The agents here

| Agent | Use it for |
|-------|-----------|
| [`doc-sync`](doc-sync.md) | After a code change, re-sync CLAUDE.md / SPEC.md / ARCHITECTURE.md / GUIDE.md (the Self-Update Protocol). |
| [`council-forensics`](council-forensics.md) | Diagnose a misbehaving council/pipeline run by reading the on-disk council store (real config + ledger, not guesses). |
| [`release-verifier`](release-verifier.md) | Sanity-check built installers before publishing a release — bundling, deps, and an actual Linux launch test, with honest per-platform confidence. |

## Add your own

Drop a new `name.md` here with the frontmatter above. Keep the `description` action-oriented
("Use to/when …") so auto-delegation fires at the right time, and give the agent the minimum
tools it needs. Commit it and the whole team gets it.

Related: `.claude/commands/` holds **slash commands** (e.g. `/council`, `/prepare-distribution`)
— those are prompt macros you trigger by name; subagents are delegated specialists.
