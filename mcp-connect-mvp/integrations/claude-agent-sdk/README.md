# Claude Agent SDK — Council as an Agent Tool

**Goal:** Any Claude agent built with Anthropic's Agent SDK can call a council deliberation as a tool. When the agent decides it needs multi-perspective analysis, it invokes the council.

## What This Gets You

- Claude agents can autonomously decide to run a council
- "I need multiple perspectives on this" → agent calls council tool
- Works in any Claude Agent SDK application
- Agent receives structured council output and incorporates it into its reasoning

## What the Agent SDK Is

Anthropic's SDK for building autonomous Claude agents. Agents have tools, can make decisions, and execute multi-step tasks. You register custom tools that the agent can choose to invoke.

## Skeleton: Council Tool

```typescript
// council-tool.ts
import { Agent, tool } from "claude-agent-sdk";
import { z } from "zod";
import { execSync } from "node:child_process";

const councilTool = tool({
  name: "run_council",
  description:
    "Run a multi-LLM council deliberation. Use this when you need " +
    "structured multi-perspective analysis, code review, implementation " +
    "planning, or a decision with advocate/critic debate. Returns the " +
    "council's decision and final output.",
  input_schema: z.object({
    task: z.string().describe("The problem or task for the council to deliberate on"),
    type: z.enum(["analysis", "code_planning", "coding", "council", "review"])
      .default("analysis")
      .describe("Council type: analysis for reviews, code_planning for specs, coding for implementation, council for debates"),
    working_dir: z.string().optional()
      .describe("Absolute path to the target project directory"),
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
      cwd: working_dir || process.cwd(),
    });

    const result = JSON.parse(stdout);
    return {
      status: result.status,
      decision: result.decision,
      output: result.output,
      rounds: result.council?.rounds,
      tokens_used: result.council?.totalTokensUsed,
    };
  },
});

// Use in an agent
const agent = new Agent({
  model: "claude-sonnet-4-5-20250929",
  tools: [councilTool],
  instructions:
    "You are a senior engineer. When you need multiple perspectives on " +
    "a complex decision or thorough code analysis, use the run_council tool.",
});

// The agent will autonomously decide when to invoke a council
const result = await agent.run("Review the auth system and decide if we should migrate to OAuth2");
```

## Steps to Build and Distribute

### 1. Create the package

```bash
cd integrations/claude-agent-sdk
npm init -y
npm install claude-agent-sdk zod
```

### 2. Build the tool (adapt skeleton above)

### 3. Test with a simple agent

```typescript
const agent = new Agent({
  model: "claude-sonnet-4-5-20250929",
  tools: [councilTool],
});

const result = await agent.run("Do a security review of ~/my-project");
// Agent should invoke the council tool and summarize results
```

### 4. Publish as an npm package

```bash
# Package name: kondi-council-agent-tool
npm publish --access public
```

### 5. Users install and use

```typescript
import { councilTool } from "kondi-council-agent-tool";

const agent = new Agent({
  tools: [councilTool, ...otherTools],
});
```

## Resources

- [Claude Agent SDK docs](https://docs.anthropic.com/en/docs/agents/agent-sdk)
- [Claude Agent SDK TypeScript](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Custom tools guide](https://docs.anthropic.com/en/docs/agents/tools)
