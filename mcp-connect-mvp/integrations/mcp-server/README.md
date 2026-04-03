# MCP Server — Expose Councils to Any MCP Client

**Goal:** Any app that speaks MCP (Claude Desktop, Cursor, Windsurf, VS Code Copilot, etc.) can invoke a council deliberation as a tool.

## What This Gets You

- Claude Desktop users can say "run a security council on this project" and it just works
- Cursor/Windsurf users get council capabilities in their IDE
- Any future MCP client automatically gets councils
- No framework lock-in — MCP is an open protocol

## What MCP Is (Plain English)

MCP (Model Context Protocol) is a standard that lets AI apps discover and call external tools. You build an "MCP server" — a small program that says "I offer these tools." AI apps connect to it and can call those tools.

Think of it like a USB device driver: you write it once, and any computer (AI app) that supports USB (MCP) can use your device (council).

## How It Works

```
Claude Desktop / Cursor / VS Code
        │
        │ MCP protocol (stdio or HTTP)
        │
   ┌────▼────────────────┐
   │  kondi-mcp-server    │
   │                      │
   │  Tool: council       │
   │    - task: string    │
   │    - type: string    │
   │    - workingDir: str │
   │                      │
   │  Runs the council    │
   │  Returns results     │
   └──────────────────────┘
```

## Skeleton: MCP Server

```typescript
// server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "node:child_process";

const server = new McpServer({
  name: "kondi-council",
  version: "0.1.0",
});

server.tool(
  "council",
  "Run a multi-LLM council deliberation with manager, consultant, and worker personas",
  {
    task: z.string().describe("The task or problem for the council"),
    type: z.enum(["analysis", "code_planning", "coding", "council", "review"])
      .default("analysis")
      .describe("Council type"),
    workingDir: z.string().optional()
      .describe("Target project directory"),
    configPath: z.string().optional()
      .describe("Path to a custom council config JSON"),
    outputFormat: z.enum(["full", "abbreviated", "json", "output-only"])
      .default("full")
      .describe("Artifact output format"),
  },
  async ({ task, type, workingDir, configPath, outputFormat }) => {
    const args = [
      "kondi-council", "council",
      "--task", task,
      "--type", type,
      "--output", outputFormat,
      "--json-stdout", "--quiet",
    ];
    if (workingDir) args.push("--working-dir", workingDir);
    if (configPath) args.push("--config", configPath);

    try {
      const stdout = execSync(args.join(" "), {
        encoding: "utf-8",
        timeout: 600_000, // 10 min
        cwd: workingDir || process.cwd(),
      });

      const result = JSON.parse(stdout);
      return {
        content: [
          {
            type: "text",
            text: `## Council Result: ${result.council?.name || type}\n\n` +
              `**Status:** ${result.status}\n` +
              `**Rounds:** ${result.council?.rounds || 0}\n` +
              `**Tokens:** ${result.council?.totalTokensUsed || 0}\n\n` +
              `### Decision\n${result.decision || "No decision recorded."}\n\n` +
              `### Output\n${result.output || "No output recorded."}`,
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Council failed: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
```

## Steps to Build and Distribute

### 1. Create the package

```bash
cd integrations/mcp-server
npm init -y
npm install @modelcontextprotocol/sdk zod
```

### 2. Build the server (use the skeleton above)

### 3. Test locally with Claude Desktop

Add to `~/.claude.json`:
```json
{
  "mcpServers": {
    "kondi-council": {
      "command": "npx",
      "args": ["tsx", "/path/to/integrations/mcp-server/server.ts"]
    }
  }
}
```

Restart Claude Desktop. Type "run a council analysis on ~/my-project" — it should invoke the tool.

### 4. Publish to npm

```bash
# package.json should have:
# "bin": { "kondi-council-mcp": "./server.ts" }
npm publish --access public
```

### 5. Users install like any MCP server

```json
{
  "mcpServers": {
    "kondi-council": {
      "command": "npx",
      "args": ["-y", "kondi-council-mcp"]
    }
  }
}
```

### 6. List on MCP directories

- Submit to [MCP Servers](https://github.com/modelcontextprotocol/servers) — the official MCP server directory
- Add to [Smithery](https://smithery.ai/) — MCP server marketplace
- Add to [mcp.so](https://mcp.so/) — community MCP directory

## Resources

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Specification](https://modelcontextprotocol.io/specification)
- [Building MCP Servers](https://modelcontextprotocol.io/quickstart/server)
- [MCP Servers directory](https://github.com/modelcontextprotocol/servers)
