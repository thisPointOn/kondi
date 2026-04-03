#!/usr/bin/env node
/**
 * Kondi Council MCP Server
 *
 * Exposes council deliberation as an MCP tool.
 * Any MCP client (Claude Desktop, Cursor, VS Code, Windsurf) can invoke it.
 *
 * Install: npm install -g kondi-council-mcp
 * Config:  Add to ~/.claude.json mcpServers
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

function findKondi(): string {
  // Try kondi-council (npm package), then kondi (linked from repo)
  for (const cmd of ["kondi-council", "kondi"]) {
    try {
      execSync(`which ${cmd}`, { stdio: "ignore" });
      return cmd;
    } catch {}
  }
  throw new Error(
    "kondi-council CLI not found. Install with: npm install -g kondi-council"
  );
}

const server = new McpServer({
  name: "kondi-council",
  version: "0.1.0",
});

server.tool(
  "council",
  "Run a multi-LLM council deliberation. Multiple AI personas (manager, consultants, worker) debate and produce a reviewed output. Use for code analysis, planning, implementation, or general decisions.",
  {
    task: z.string().describe("The task or problem for the council to deliberate on"),
    type: z
      .enum(["analysis", "code_planning", "coding", "council", "review"])
      .default("analysis")
      .describe(
        "Council type: 'analysis' for code review, 'code_planning' for specs, " +
        "'coding' for implementation, 'council' for debate, 'review' for structured review"
      ),
    working_dir: z
      .string()
      .optional()
      .describe("Absolute path to the target project directory"),
    config_path: z
      .string()
      .optional()
      .describe("Path to a custom council config JSON file"),
  },
  async ({ task, type, working_dir, config_path }) => {
    const kondi = findKondi();
    const args = [
      "council",
      "--task", task,
      "--type", type,
      "--output", "full",
      "--json-stdout",
      "--quiet",
    ];
    if (working_dir) args.push("--working-dir", resolve(working_dir));
    if (config_path) args.push("--config", resolve(config_path));

    try {
      const stdout = execFileSync(kondi, args, {
        encoding: "utf-8",
        timeout: 600_000,
        cwd: working_dir || process.cwd(),
        env: { ...process.env, CLAUDECODE: undefined },
      });

      const result = JSON.parse(stdout);

      const text = [
        `## Council Result: ${result.council?.name || type}`,
        "",
        `**Status:** ${result.status}`,
        `**Rounds:** ${result.council?.rounds || 0}`,
        `**Entries:** ${result.council?.entryCount || 0}`,
        `**Tokens:** ${result.council?.totalTokensUsed?.toLocaleString() || 0}`,
        "",
        "### Decision",
        result.decision || "_No decision recorded._",
        "",
        "### Output",
        result.output || "_No output recorded._",
      ];

      if (result.artifacts?.length) {
        text.push("", "### Artifacts");
        for (const p of result.artifacts) {
          text.push(`- \`${p}\``);
        }
      }

      return { content: [{ type: "text", text: text.join("\n") }] };
    } catch (err: any) {
      const msg = err.stderr || err.message || String(err);
      return {
        content: [{ type: "text", text: `Council failed:\n${msg}` }],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
