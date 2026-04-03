import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from "n8n-workflow";
import { execFileSync } from "node:child_process";

export class KondiCouncil implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Kondi Council",
    name: "kondiCouncil",
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["councilType"]}} council',
    description: "Run a multi-LLM council deliberation with manager, consultant, and worker personas",
    defaults: { name: "Kondi Council" },
    inputs: ["main"],
    outputs: ["main"],
    properties: [
      {
        displayName: "Council Type",
        name: "councilType",
        type: "options",
        options: [
          { name: "Analysis / Code Review", value: "analysis" },
          { name: "Code Planning", value: "code_planning" },
          { name: "Coding (writes files)", value: "coding" },
          { name: "General Debate", value: "council" },
          { name: "Structured Review", value: "review" },
        ],
        default: "analysis",
        description: "Type of council deliberation to run",
      },
      {
        displayName: "Task",
        name: "task",
        type: "string",
        typeOptions: { rows: 4 },
        default: "",
        required: true,
        description: "The task or problem for the council to work on",
      },
      {
        displayName: "Working Directory",
        name: "workingDir",
        type: "string",
        default: "",
        description: "Absolute path to target project directory",
      },
      {
        displayName: "Config File",
        name: "configPath",
        type: "string",
        default: "",
        description: "Path to custom council config JSON (optional)",
      },
      {
        displayName: "Timeout (seconds)",
        name: "timeout",
        type: "number",
        default: 600,
        description: "Maximum time for council execution",
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const results: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const councilType = this.getNodeParameter("councilType", i) as string;
      const task = this.getNodeParameter("task", i) as string;
      const workingDir = this.getNodeParameter("workingDir", i, "") as string;
      const configPath = this.getNodeParameter("configPath", i, "") as string;
      const timeout = this.getNodeParameter("timeout", i, 600) as number;

      const args = [
        "council",
        "--task", task,
        "--type", councilType,
        "--json-stdout", "--quiet",
        "--output", "none",
      ];
      if (workingDir) args.push("--working-dir", workingDir);
      if (configPath) args.push("--config", configPath);

      // Find kondi binary
      let kondi = "kondi-council";
      try {
        execFileSync("which", ["kondi-council"], { stdio: "ignore" });
      } catch {
        kondi = "kondi";
      }

      try {
        const stdout = execFileSync(kondi, args, {
          encoding: "utf-8",
          timeout: timeout * 1000,
          cwd: workingDir || undefined,
          env: { ...process.env, CLAUDECODE: undefined },
        });

        const result = JSON.parse(stdout);
        results.push({
          json: {
            status: result.status,
            decision: result.decision,
            output: result.output,
            councilName: result.council?.name,
            rounds: result.council?.rounds,
            tokensUsed: result.council?.totalTokensUsed,
            entryCount: result.council?.entryCount,
          },
        });
      } catch (err: any) {
        results.push({
          json: {
            status: "failed",
            error: err.stderr || err.message || String(err),
          },
        });
      }
    }

    return [results];
  }
}
