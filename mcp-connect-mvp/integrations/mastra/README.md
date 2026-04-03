# Mastra Integration — Council as a Workflow Step

**Goal:** Plug councils into Mastra's TypeScript-native agent framework. 22k stars, YC-backed, growing fast.

## What This Gets You

- Integration with a fast-growing TypeScript AI framework
- Council as a workflow step or agent tool
- Native TypeScript — no bridge needed, direct import possible
- Mastra supports 40+ LLM providers (matches council's multi-provider design)

## What Mastra Is

TypeScript-native AI agent framework (built by the Gatsby team). It has:
- **Agents** with tools and model routing
- **Workflows** with steps, branching, and state
- **RAG** and vector search
- **40+ LLM providers** built in

## Skeleton: Council as a Mastra Tool

```typescript
// council-tool.ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { execSync } from "node:child_process";

export const councilTool = createTool({
  id: "kondi-council",
  description:
    "Run a multi-LLM council deliberation with structured debate between " +
    "manager, consultant, and worker personas. Returns decision and output.",
  inputSchema: z.object({
    task: z.string().describe("The problem for the council"),
    type: z.enum(["analysis", "code_planning", "coding", "council", "review"])
      .default("analysis"),
    workingDir: z.string().optional(),
    configPath: z.string().optional(),
  }),
  outputSchema: z.object({
    status: z.string(),
    decision: z.string().nullable(),
    output: z.string().nullable(),
    rounds: z.number(),
    tokensUsed: z.number(),
  }),
  execute: async ({ context }) => {
    const { task, type, workingDir, configPath } = context;
    const args = [
      "kondi-council", "council",
      "--task", task,
      "--type", type,
      "--json-stdout", "--quiet",
    ];
    if (workingDir) args.push("--working-dir", workingDir);
    if (configPath) args.push("--config", configPath);

    const stdout = execSync(args.join(" "), {
      encoding: "utf-8",
      timeout: 600_000,
    });

    const result = JSON.parse(stdout);
    return {
      status: result.status || "unknown",
      decision: result.decision || null,
      output: result.output || null,
      rounds: result.council?.rounds || 0,
      tokensUsed: result.council?.totalTokensUsed || 0,
    };
  },
});
```

## Skeleton: Council as a Mastra Workflow Step

```typescript
// council-workflow.ts
import { Workflow, Step } from "@mastra/core/workflows";
import { z } from "zod";
import { councilTool } from "./council-tool";

const analyzeStep = new Step({
  id: "council-analyze",
  description: "Run analysis council on the target",
  execute: async ({ context }) => {
    const result = await councilTool.execute({
      context: {
        task: context.triggerData.task,
        type: "analysis",
        workingDir: context.triggerData.workingDir,
      },
    });
    return result;
  },
});

const reviewStep = new Step({
  id: "human-review",
  description: "Present findings for human review",
  execute: async ({ context }) => {
    const analysis = context.getStepResult("council-analyze");
    return { summary: analysis.output, needsAction: analysis.status === "completed" };
  },
});

export const reviewWorkflow = new Workflow({
  name: "code-review-pipeline",
  triggerSchema: z.object({
    task: z.string(),
    workingDir: z.string(),
  }),
})
  .step(analyzeStep)
  .then(reviewStep)
  .commit();
```

## Skeleton: Council as a Mastra Agent Tool

```typescript
// council-agent.ts
import { Agent } from "@mastra/core/agent";
import { councilTool } from "./council-tool";

export const engineeringAgent = new Agent({
  name: "Engineering Lead",
  instructions:
    "You are a senior engineering lead. When you need thorough " +
    "multi-perspective analysis or a structured debate, use the " +
    "kondi-council tool.",
  model: { provider: "ANTHROPIC", name: "claude-sonnet-4-5-20250929" },
  tools: { "kondi-council": councilTool },
});
```

## Steps to Build and Distribute

### 1. Create the package

```bash
cd integrations/mastra
npm init -y
npm install @mastra/core zod
```

### 2. Build the tool and test

```typescript
const result = await councilTool.execute({
  context: {
    task: "Review this code",
    type: "analysis",
    workingDir: "/tmp/test-project",
  },
});
console.log(result);
```

### 3. Publish to npm

```bash
# Package name: kondi-council-mastra
npm publish --access public
```

### 4. Contribute to Mastra's integrations

Mastra has an integrations directory. You can PR your tool there:

```bash
git clone https://github.com/mastra-ai/mastra.git
# Add kondi-council integration
# Open PR
```

## Resources

- [Mastra docs](https://mastra.ai/docs)
- [Mastra tools](https://mastra.ai/docs/tools/overview)
- [Mastra workflows](https://mastra.ai/docs/workflows/overview)
- [Mastra GitHub](https://github.com/mastra-ai/mastra)
- [Mastra agents](https://mastra.ai/docs/agents/overview)
