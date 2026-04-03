# Publish Kondi Council as a Standalone npm Package

**Goal:** Anyone in the world runs `npm install -g kondi-council` and gets the council CLI.

## What This Gets You

- Global install: `npx kondi-council --task "Review my code"`
- Anyone with Node.js 20+ can use it
- No framework dependency, works everywhere
- Can be used in CI/CD, cron, scripts

## Steps to Publish

### 1. Create a clean package.json for CLI-only distribution

The main `package.json` includes React, Tauri, and other GUI deps. For npm publishing, you need a stripped-down version.

Copy this directory's `package.json` as a starting point, then:

```bash
cd integrations/npm-package
npm install  # verify deps resolve
```

### 2. Test locally

```bash
npm link
kondi-council --help
kondi-council --task "Test" --dry-run
```

### 3. Pick a name and check availability

```bash
npm view kondi-council  # check if taken
npm view kondi          # check if taken
```

### 4. Create an npm account (if you don't have one)

```bash
npm adduser
# or sign up at npmjs.com
```

### 5. Publish

```bash
npm publish --access public
```

### 6. Verify

```bash
npm install -g kondi-council
kondi-council --task "Hello world" --dry-run
```

## What Needs to Happen First

The current codebase has CLI and GUI code interleaved. For a clean npm package you need to either:

**Option A (quick):** Publish the whole repo but use `.npmignore` to exclude GUI files. The `.npmignore` already exists — just verify it excludes `src-tauri/`, heavy deps, etc.

**Option B (clean):** Create a standalone `package.json` in this directory that only lists CLI dependencies:

```json
{
  "name": "kondi-council",
  "version": "0.1.0",
  "description": "Multi-LLM council deliberation CLI — structured debates between AI personas",
  "license": "AGPL-3.0-only",
  "type": "module",
  "bin": {
    "kondi-council": "../../cli/kondi.ts"
  },
  "files": [
    "../../cli/",
    "../../src/council/",
    "../../src/pipeline/types.ts",
    "../../src/pipeline/executor.ts",
    "../../src/pipeline/output-parsers.ts",
    "../../src/services/deliberationSummary.ts",
    "../../configs/"
  ],
  "dependencies": {
    "tsx": "^4.0.0",
    "zod": "^4.3.6"
  },
  "engines": {
    "node": ">=20"
  },
  "keywords": ["ai", "llm", "multi-agent", "council", "deliberation", "claude", "openai", "cli"]
}
```

**Option C (best for real distribution):** Bundle the CLI into a single JS file using `esbuild` or `tsup`, eliminating the tsx runtime dependency. This is more work but produces a cleaner package.

## Promoting It

- Add to the npm README (this is what people see on npmjs.com)
- Post on r/LocalLLaMA, r/MachineLearning, Hacker News
- Add badges to the README: `npm version`, `downloads/month`
- Create a demo GIF showing a council running in the terminal
