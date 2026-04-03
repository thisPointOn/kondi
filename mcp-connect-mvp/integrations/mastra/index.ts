/**
 * Kondi Council tool for Mastra
 *
 * Usage as agent tool:
 *   import { councilTool } from "kondi-council-mastra";
 *   const agent = new Agent({ tools: { council: councilTool } });
 *
 * Usage in workflow:
 *   import { councilStep } from "kondi-council-mastra";
 *   const workflow = new Workflow({ name: "review" }).step(councilStep);
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

export interface CouncilInput {
  task: string;
  type?: "analysis" | "code_planning" | "coding" | "council" | "review";
  workingDir?: string;
  configPath?: string;
}

export interface CouncilOutput {
  status: string;
  decision: string | null;
  output: string | null;
  rounds: number;
  tokensUsed: number;
  error?: string;
}

/**
 * Run a council and return structured results.
 * Can be used directly or wrapped in Mastra's createTool / Step.
 */
export async function runCouncil(input: CouncilInput): Promise<CouncilOutput> {
  const kondi = findKondi();
  const args = [
    "council",
    "--task", input.task,
    "--type", input.type || "analysis",
    "--json-stdout", "--quiet", "--output", "none",
  ];
  if (input.workingDir) args.push("--working-dir", input.workingDir);
  if (input.configPath) args.push("--config", input.configPath);

  try {
    const stdout = execFileSync(kondi, args, {
      encoding: "utf-8",
      timeout: 600_000,
      cwd: input.workingDir || process.cwd(),
      env: { ...process.env, CLAUDECODE: undefined },
    });

    const result = JSON.parse(stdout);
    return {
      status: result.status || "completed",
      decision: result.decision || null,
      output: result.output || null,
      rounds: result.council?.rounds || 0,
      tokensUsed: result.council?.totalTokensUsed || 0,
    };
  } catch (err: any) {
    return {
      status: "failed",
      decision: null,
      output: null,
      rounds: 0,
      tokensUsed: 0,
      error: err.stderr || err.message || String(err),
    };
  }
}

/**
 * Mastra tool definition.
 * Import createTool from @mastra/core/tools and wrap this:
 *
 *   import { createTool } from "@mastra/core/tools";
 *   import { z } from "zod";
 *   import { runCouncil } from "kondi-council-mastra";
 *
 *   export const councilTool = createTool({
 *     id: "kondi-council",
 *     description: "Run a multi-LLM council deliberation",
 *     inputSchema: z.object({ task: z.string(), type: z.string().optional(), workingDir: z.string().optional() }),
 *     execute: async ({ context }) => runCouncil(context),
 *   });
 */
