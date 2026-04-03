/**
 * Kondi Council tool for OpenAI Agents SDK
 *
 * Usage:
 *   import { councilTool } from "kondi-council-openai";
 *   import { Agent, run } from "@openai/agents";
 *   const agent = new Agent({ tools: [councilTool] });
 *   const result = await run(agent, "Review this codebase");
 */

import { execFileSync } from "node:child_process";

function findKondi(): string {
  for (const cmd of ["kondi-council", "kondi"]) {
    try {
      execFileSync("which", [cmd], { stdio: "ignore" });
      return cmd;
    } catch {}
  }
  throw new Error("kondi-council not found. Install: npm install -g kondi-council");
}

function runCouncil(opts: {
  task: string;
  type: string;
  working_dir?: string;
}): any {
  const kondi = findKondi();
  const args = [
    "council",
    "--task", opts.task,
    "--type", opts.type,
    "--json-stdout", "--quiet", "--output", "none",
  ];
  if (opts.working_dir) args.push("--working-dir", opts.working_dir);

  const stdout = execFileSync(kondi, args, {
    encoding: "utf-8",
    timeout: 600_000,
    env: { ...process.env, CLAUDECODE: undefined },
  });

  return JSON.parse(stdout);
}

/**
 * Council tool for @openai/agents.
 * The agent will call this when it needs multi-perspective analysis.
 */
export const councilTool = {
  type: "function" as const,
  name: "run_council",
  description:
    "Run a multi-LLM council deliberation. Multiple AI personas debate " +
    "and produce a reviewed output. Use for code analysis, planning, " +
    "implementation, or decisions needing multiple perspectives.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "The problem or question for the council",
      },
      type: {
        type: "string",
        enum: ["analysis", "code_planning", "coding", "council", "review"],
        default: "analysis",
        description: "Council type",
      },
      working_dir: {
        type: "string",
        description: "Project directory path",
      },
    },
    required: ["task"],
  },
  async execute(input: { task: string; type?: string; working_dir?: string }) {
    const result = runCouncil({
      task: input.task,
      type: input.type || "analysis",
      working_dir: input.working_dir,
    });
    return JSON.stringify({
      status: result.status,
      decision: result.decision,
      output: result.output,
      rounds: result.council?.rounds,
    });
  },
};
