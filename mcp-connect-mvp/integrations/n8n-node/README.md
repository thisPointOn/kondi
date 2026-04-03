# n8n Community Node — Kondi Council

**Goal:** A draggable "Council Deliberation" block in n8n's visual workflow builder. 181k GitHub stars, thousands of users.

## What This Gets You

- Visual workflow integration: drag a council between any two steps
- Non-developers can use councils in their automations
- Listed in n8n's community nodes directory
- Example: GitHub webhook → Council Analysis → Slack notification

## How n8n Community Nodes Work

1. You create an npm package named `n8n-nodes-kondi`
2. It exports node classes that n8n discovers automatically
3. You publish to npm
4. Users install via: n8n Settings → Community Nodes → `n8n-nodes-kondi`
5. The node appears in their workflow editor

## Steps to Build and Publish

### 1. Scaffold the node package

```bash
# Clone n8n's starter template
npx degit n8n-io/n8n-nodes-starter n8n-nodes-kondi
cd n8n-nodes-kondi
npm install
```

### 2. Create the council node

Create `nodes/KondiCouncil/KondiCouncil.node.ts`:

```typescript
import { IExecuteFunctions, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { spawn } from 'node:child_process';

export class KondiCouncil implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Kondi Council',
    name: 'kondiCouncil',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["councilType"]}} council',
    description: 'Run a multi-LLM council deliberation',
    defaults: { name: 'Kondi Council' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Council Type',
        name: 'councilType',
        type: 'options',
        options: [
          { name: 'Analysis', value: 'analysis' },
          { name: 'Code Planning', value: 'code_planning' },
          { name: 'Coding', value: 'coding' },
          { name: 'Debate', value: 'debate' },
          { name: 'Custom', value: 'custom' },
        ],
        default: 'analysis',
      },
      {
        displayName: 'Task',
        name: 'task',
        type: 'string',
        default: '',
        required: true,
        description: 'The task or problem for the council to work on',
      },
      {
        displayName: 'Working Directory',
        name: 'workingDir',
        type: 'string',
        default: '',
        description: 'Target directory for file operations',
      },
      {
        displayName: 'Custom Config JSON',
        name: 'customConfig',
        type: 'json',
        default: '',
        displayOptions: { show: { councilType: ['custom'] } },
        description: 'Full council configuration JSON',
      },
      {
        displayName: 'Output Format',
        name: 'outputFormat',
        type: 'options',
        options: [
          { name: 'Full', value: 'full' },
          { name: 'Abbreviated', value: 'abbreviated' },
          { name: 'JSON', value: 'json' },
          { name: 'Output Only', value: 'output-only' },
        ],
        default: 'json',
      },
    ],
  };

  async execute(this: IExecuteFunctions) {
    // Implementation: spawn kondi-council CLI with --json-stdout
    // Parse JSON result, return as n8n item
    // See skeleton in index.ts
  }
}
```

### 3. Add an icon

Place `nodes/KondiCouncil/kondiCouncil.svg` — a 60x60 SVG icon.

### 4. Test locally with n8n

```bash
# In your n8n-nodes-kondi directory
npm run build
npm link

# In your n8n installation
npm link n8n-nodes-kondi

# Start n8n — the node should appear
npx n8n start
```

### 5. Publish to npm

```bash
npm publish --access public
```

### 6. Submit to n8n Creator Portal

Go to https://creators.n8n.io and register your node. This gets it listed in n8n's official community directory.

## Key Requirements

- Node package name MUST start with `n8n-nodes-`
- Must export node classes from the package root
- Need `n8n` section in package.json pointing to node files
- As of May 2026, npm provenance attestation is required
- The node should handle timeouts gracefully (councils can run 5+ minutes)

## Architecture Decision

**Option A: Shell out to kondi CLI** (recommended for v1)
- Depend on `kondi-council` npm package
- Spawn `kondi-council --json-stdout --quiet`
- Parse JSON output
- Simple, works immediately

**Option B: Import council orchestrator directly**
- Import the TypeScript orchestrator code
- More integrated, no subprocess overhead
- Harder to maintain across versions

## Resources

- [n8n Community Nodes docs](https://docs.n8n.io/integrations/community-nodes/)
- [n8n Starter Template](https://github.com/n8n-io/n8n-nodes-starter)
- [n8n Creator Portal](https://creators.n8n.io)
- [Publishing guide](https://docs.n8n.io/integrations/community-nodes/build-community-nodes/)
