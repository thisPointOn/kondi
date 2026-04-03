/**
 * Kondi Council node for LangGraph.js
 *
 * Usage:
 *   import { councilNode, CouncilState } from "kondi-council-langgraph";
 *   const graph = new StateGraph(CouncilState)
 *     .addNode("council", councilNode)
 *     .addEdge("__start__", "council")
 *     .addEdge("council", "__end__")
 *     .compile();
 */

import { execFileSync } from "node:child_process";

export interface CouncilNodeInput {
  task: string;
  councilType?: string;
  workingDir?: string;
  configPath?: string;
}

export interface CouncilNodeOutput {
  status: string;
  decision: string | null;
  output: string | null;
  rounds: number;
  tokensUsed: number;
  error?: string;
}

function findKondi(): string {
  for (const cmd of ["kondi-council", "kondi"]) {
    try {
      execFileSync("which", [cmd], { stdio: "ignore" });
      return cmd;
    } catch {}
  }
  throw new Error("kondi-council not found. Install: npm install -g kondi-council");
}

/**
 * Run a Kondi council and return structured results.
 * Use as a node function in a LangGraph StateGraph.
 */
export async function councilNode(
  state: CouncilNodeInput
): Promise<CouncilNodeOutput> {
  const kondi = findKondi();
  const args = [
    "council",
    "--task", state.task,
    "--type", state.councilType || "analysis",
    "--json-stdout", "--quiet",
    "--output", "none",
  ];
  if (state.workingDir) args.push("--working-dir", state.workingDir);
  if (state.configPath) args.push("--config", state.configPath);

  try {
    const stdout = execFileSync(kondi, args, {
      encoding: "utf-8",
      timeout: 600_000,
      cwd: state.workingDir || process.cwd(),
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
