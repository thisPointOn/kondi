/**
 * Kondi Council tool for Claude Agent SDK
 *
 * Usage:
 *   import { councilTool } from "kondi-council-agent-tool";
 *   const agent = new Agent({ tools: [councilTool] });
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
  type?: string;
  working_dir?: string;
  config_path?: string;
}): any {
  const kondi = findKondi();
  const args = [
    "council",
    "--task", opts.task,
    "--type", opts.type || "analysis",
    "--json-stdout", "--quiet", "--output", "none",
  ];
  if (opts.working_dir) args.push("--working-dir", opts.working_dir);
  if (opts.config_path) args.push("--config", opts.config_path);

  const stdout = execFileSync(kondi, args, {
    encoding: "utf-8",
    timeout: 600_000,
    env: { ...process.env, CLAUDECODE: undefined },
  });

  return JSON.parse(stdout);
}

/**
 * Council tool definition for Claude Agent SDK.
 * Register this with your agent's tools array.
 */
export const councilTool = {
  name: "run_council",
  description:
    "Run a multi-LLM council deliberation with manager, consultant, and worker personas. " +
    "Use for thorough code analysis, implementation planning, structured code review, " +
    "or multi-perspective debate on decisions. Returns the council's decision and output.",
  input_schema: {
    type: "object" as const,
    properties: {
      task: {
        type: "string",
        description: "The problem or task for the council to deliberate on",
      },
      type: {
        type: "string",
        enum: ["analysis", "code_planning", "coding", "council", "review"],
        default: "analysis",
        description: "Council type",
      },
      working_dir: {
        type: "string",
        description: "Absolute path to the target project directory",
      },
    },
    required: ["task"],
  },
  async execute(input: { task: string; type?: string; working_dir?: string }) {
    try {
      const result = runCouncil(input);
      return {
        status: result.status,
        decision: result.decision,
        output: result.output,
        rounds: result.council?.rounds,
        tokens_used: result.council?.totalTokensUsed,
      };
    } catch (err: any) {
      return { status: "failed", error: err.message };
    }
  },
};
