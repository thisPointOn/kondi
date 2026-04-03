# Kondi Council — Integrations

Each directory contains instructions and skeleton code for plugging Kondi councils into a different platform or framework.

## At a Glance

| Integration | Language | Audience | Publish To | Effort | Directory |
|------------|----------|----------|------------|--------|-----------|
| **npm package** | TypeScript | Everyone with Node.js | npm | Low | `npm-package/` |
| **n8n node** | TypeScript | 181k-star workflow community | npm + n8n Creator Portal | Low-Med | `n8n-node/` |
| **LangGraph.js** | TypeScript | LangChain developer community | GitHub PR or npm | Low-Med | `langgraph-js/` |
| **MCP Server** | TypeScript | Claude Desktop, Cursor, VS Code, Windsurf users | npm + MCP directories | Low | `mcp-server/` |
| **Claude Agent SDK** | TypeScript | Claude agent builders | npm | Low | `claude-agent-sdk/` |
| **OpenAI Agents SDK** | TypeScript | OpenAI agent builders | npm | Low-Med | `openai-agents-sdk/` |
| **CrewAI** | Python (bridge) | 47k-star multi-agent community | PyPI | Med | `crewai-bridge/` |
| **Mastra** | TypeScript | Growing TS-native agent framework | npm + GitHub PR | Low | `mastra/` |

## How They All Work

Every integration wraps the same thing: the `kondi-council` CLI with `--json-stdout --quiet`. The council runs, returns JSON, and the wrapper formats it for the target platform.

```
Any Platform → spawn "kondi-council" → JSON result → format for platform
```

This means:
1. The core council code stays in one place
2. Integrations are thin wrappers (50-100 lines each)
3. Bug fixes to the council automatically benefit all integrations
4. You can build all 8 integrations from the same CLI

## Recommended Order

1. **npm package** — Foundation. All other integrations depend on `kondi-council` being installable.
2. **MCP Server** — Highest leverage per line of code. Every MCP client gets councils.
3. **n8n node** — Biggest community. Visual builder makes councils accessible to non-developers.
4. **LangGraph.js** — Developer credibility. Shows up in a major AI framework.
5. **Claude Agent SDK / OpenAI Agents SDK** — Let agents autonomously decide to run councils.
6. **Mastra** — Fast-growing, TypeScript-native, easy integration.
7. **CrewAI** — Largest multi-agent community, but Python bridge adds complexity.

## Prerequisites for All

The `kondi-council` CLI must be on PATH:

```bash
# From the kondi repo
cd mcp-connect-mvp
npm install
npm link

# Verify
kondi council --help
```
