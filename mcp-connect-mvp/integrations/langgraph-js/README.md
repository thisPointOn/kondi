# LangGraph.js Integration — Council as a Graph Node

**Goal:** A council deliberation step that plugs into LangGraph's graph-based agent workflows. ~24k stars, first-class TypeScript support.

## What This Gets You

- Council as a node in any LangGraph workflow
- Developers building agent systems can add multi-model deliberation
- Compatible with the entire LangChain ecosystem
- Can be contributed as an example to the official repo

## How LangGraph Works

LangGraph models agent workflows as state graphs:
- **Nodes** are functions that read/write shared state
- **Edges** connect nodes (can be conditional)
- **State** flows through the graph

A council node would: read the task from state → run deliberation → write decision/output back to state.

## Two Contribution Paths

### Path A: Contribute an example to the LangGraph.js repo

```bash
# Fork and clone
git clone https://github.com/langchain-ai/langgraphjs.git
cd langgraphjs

# Create example
mkdir -p examples/council-deliberation
# Add your example files (see skeleton below)

# Open a PR
git checkout -b example/council-deliberation
git add examples/council-deliberation/
git commit -m "Add multi-model council deliberation example"
# Push and open PR at github.com/langchain-ai/langgraphjs
```

### Path B: Publish a standalone package

```bash
mkdir langgraph-kondi-council
cd langgraph-kondi-council
npm init
npm install @langchain/langgraph @langchain/core
```

## Skeleton: Council Node for LangGraph

```typescript
// council-node.ts
import { StateGraph, Annotation } from "@langchain/langgraph";
import { spawn } from "node:child_process";

// Define the state shape
const CouncilState = Annotation.Root({
  task: Annotation<string>,
  councilType: Annotation<string>({ default: () => "analysis" }),
  workingDir: Annotation<string>({ default: () => process.cwd() }),
  decision: Annotation<string | null>({ default: () => null }),
  output: Annotation<string | null>({ default: () => null }),
  status: Annotation<string>({ default: () => "pending" }),
});

// Council deliberation node
async function runCouncil(state: typeof CouncilState.State) {
  const result = await runKondiCouncil({
    task: state.task,
    type: state.councilType,
    workingDir: state.workingDir,
  });

  return {
    decision: result.decision,
    output: result.output,
    status: result.status,
  };
}

// Should we continue or are we done?
function shouldContinue(state: typeof CouncilState.State) {
  return state.status === "completed" ? "done" : "retry";
}

// Build the graph
const graph = new StateGraph(CouncilState)
  .addNode("council", runCouncil)
  .addEdge("__start__", "council")
  .addConditionalEdges("council", shouldContinue, {
    done: "__end__",
    retry: "council",
  })
  .compile();

// Usage
const result = await graph.invoke({
  task: "Review this codebase for security issues",
  councilType: "analysis",
  workingDir: "/path/to/project",
});
console.log(result.output);
```

## How to Run Kondi from LangGraph

The node function calls the Kondi CLI:

```typescript
import { execSync } from "node:child_process";

interface CouncilResult {
  status: string;
  decision: string | null;
  output: string | null;
}

function runKondiCouncil(opts: {
  task: string;
  type: string;
  workingDir: string;
  configPath?: string;
}): CouncilResult {
  const args = [
    "kondi-council", "council",
    "--task", opts.task,
    "--type", opts.type,
    "--working-dir", opts.workingDir,
    "--json-stdout", "--quiet",
  ];
  if (opts.configPath) {
    args.push("--config", opts.configPath);
  }

  const stdout = execSync(args.join(" "), {
    encoding: "utf-8",
    timeout: 600_000,
  });

  return JSON.parse(stdout);
}
```

## Steps to Contribute

1. **Build the example** using the skeleton above
2. **Test it** — run the graph with a real task
3. **Write a README** for the example explaining the council concept
4. **Fork** `langchain-ai/langgraphjs`
5. **Add** your example under `examples/council-deliberation/`
6. **Open a PR** with a clear description:
   - What: Multi-model council deliberation node
   - Why: Structured multi-perspective analysis as a graph step
   - How: Wraps Kondi council CLI, returns structured output
7. **Engage** with reviewers — LangChain team is responsive to well-documented examples

## Resources

- [LangGraph.js docs](https://langchain-ai.github.io/langgraphjs/)
- [LangGraph.js GitHub](https://github.com/langchain-ai/langgraphjs)
- [LangGraph multi-agent tutorial](https://langchain-ai.github.io/langgraphjs/tutorials/multi_agent/)
- [Contributing guide](https://github.com/langchain-ai/langgraphjs/blob/main/CONTRIBUTING.md)
