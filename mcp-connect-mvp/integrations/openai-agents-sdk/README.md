# OpenAI Agents SDK — Council as a Function Tool

**Goal:** Any OpenAI agent can invoke a council deliberation. Works with GPT-4o, o3, and any OpenAI model.

## What This Gets You

- OpenAI agents gain multi-model deliberation capabilities
- Broadens council reach beyond the Anthropic ecosystem
- Agent decides when it needs multi-perspective analysis
- Works with the `@openai/agents` npm package

## Skeleton: Council as a Function Tool

```typescript
// council-tool.ts
import { Agent, tool } from "@openai/agents";
import { z } from "zod";
import { execSync } from "node:child_process";

const councilTool = tool({
  name: "run_council",
  description:
    "Run a multi-LLM council deliberation with multiple AI personas. " +
    "Use when you need structured analysis, code review, implementation " +
    "planning, or multi-perspective debate on a decision.",
  parameters: z.object({
    task: z.string().describe("The problem or question for the council"),
    type: z.enum(["analysis", "code_planning", "coding", "council", "review"])
      .default("analysis"),
    working_dir: z.string().optional()
      .describe("Project directory path"),
  }),
  async execute({ task, type, working_dir }) {
    const args = [
      "kondi-council", "council",
      "--task", JSON.stringify(task),
      "--type", type,
      "--json-stdout", "--quiet",
    ];
    if (working_dir) args.push("--working-dir", working_dir);

    const stdout = execSync(args.join(" "), {
      encoding: "utf-8",
      timeout: 600_000,
    });

    return JSON.parse(stdout);
  },
});

// Use in an agent
const agent = new Agent({
  name: "Engineering Lead",
  model: "gpt-4o",
  tools: [councilTool],
  instructions:
    "You help with engineering decisions. When a question needs " +
    "multi-perspective analysis, invoke the council tool.",
});

// Run
import { run } from "@openai/agents";
const result = await run(agent, "Should we rewrite the API in Rust?");
console.log(result.finalOutput);
```

## Council as a Sub-Agent (Agent-as-Tool)

The OpenAI SDK supports agents calling other agents. A council could be modeled as a sub-agent:

```typescript
const councilAgent = new Agent({
  name: "Council Coordinator",
  model: "gpt-4o",
  tools: [councilTool],
  instructions: "You coordinate council deliberations. When invoked, run the council tool and synthesize the results.",
});

const mainAgent = new Agent({
  name: "Lead Engineer",
  model: "gpt-4o",
  handoffs: [councilAgent],  // Can hand off to the council
  instructions: "You handle engineering tasks. For complex decisions, hand off to the Council Coordinator.",
});
```

## Steps to Build and Distribute

### 1. Create the package

```bash
cd integrations/openai-agents-sdk
npm init -y
npm install @openai/agents zod
```

### 2. Build and test

```bash
export OPENAI_API_KEY=sk-...
npx tsx test-agent.ts
```

### 3. Publish

```bash
# Package name: kondi-council-openai
npm publish --access public
```

### 4. Users install

```typescript
import { councilTool } from "kondi-council-openai";
import { Agent, run } from "@openai/agents";

const agent = new Agent({ tools: [councilTool] });
```

## Resources

- [OpenAI Agents SDK (TypeScript)](https://github.com/openai/openai-agents-js)
- [@openai/agents on npm](https://www.npmjs.com/package/@openai/agents)
- [Function tools docs](https://openai.github.io/openai-agents-js/tools/)
- [Handoffs (agent-as-tool)](https://openai.github.io/openai-agents-js/handoffs/)
