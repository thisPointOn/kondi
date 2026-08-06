/**
 * Kondi showcase examples — four real pipelines exercising every step type,
 * run end-to-end with real models through the REAL PipelineExecutor.
 *
 * Unlike testing/ (scripted determinism), these produce genuine deliverables:
 * text steps run on NVIDIA NIM (nemotron-super for quality, nano for judges),
 * the coding step's worker runs the actual `claude` CLI with tools. Gates
 * auto-approve (documented as the human checkpoint).
 *
 * Run from mcp-connect-mvp/:
 *   NVIDIA_API_KEY=... npx tsx ../examples/harness/run-examples.ts [01|02|03|04]
 *
 * Per example folder: README.md (goal + per-step description/expected output),
 * pipeline.json (post-run export — importable in the app), outputs/ (step
 * artifacts), and the working files the run produced.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};
(globalThis as any).window = globalThis;

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const { pipelineStore } = await import('../../mcp-connect-mvp/src/pipeline/store');
  const { PipelineExecutor } = await import('../../mcp-connect-mvp/src/pipeline/executor');
  const { createNodePlatform } = await import('../../mcp-connect-mvp/cli/node-platform');
  const { callLLM } = await import('../../mcp-connect-mvp/cli/llm-caller');
  type PipelinePersona = import('../../mcp-connect-mvp/src/pipeline/types').PipelinePersona;
  type StepConfig = import('../../mcp-connect-mvp/src/pipeline/types').StepConfig;
  type Pipeline = import('../../mcp-connect-mvp/src/pipeline/types').Pipeline;

  const SUPER = { model: 'nvidia/nemotron-3-super-120b-a12b', provider: 'nvidia-router' };
  const NANO = { model: 'nvidia/nemotron-3-nano-30b-a3b', provider: 'nvidia-router' };
  const CLAUDE_CLI = { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic-cli' };

  const persona = (
    role: PipelinePersona['role'], name: string,
    m: { model: string; provider: string }, extra: Partial<PipelinePersona> = {},
  ): PipelinePersona => ({
    name, role, model: m.model, provider: m.provider,
    suppressPersona: true, traits: ['thorough'], ...extra,
  });

  const invokeAgent = async (invocation: any, p: any) => {
    console.log(`    → ${p.name} (${p.model})`);
    const result = await callLLM({
      provider: p.provider, model: p.model,
      systemPrompt: invocation.systemPrompt, userMessage: invocation.userMessage,
      // API models here run WITHOUT tools always — a tool-less NIM worker
      // offered tool definitions roleplays calls instead of answering.
      skipTools: p.provider === 'anthropic-cli' ? (invocation.skipTools ?? false) : true,
      allowedTools: invocation.allowedTools,
      workingDir: invocation.workingDirectory,
      timeoutMs: p.provider === 'anthropic-cli' ? 1_200_000 : 240_000,
    } as any);
    return { content: result.content, tokensUsed: result.tokensUsed, model: p.model } as any;
  };

  const addLayer = (pid: string, steps: { name: string; description?: string; config: StepConfig }[], mode: 'sequential' | 'parallel' = 'sequential') => {
    const updated = pipelineStore.addStage(pid)!;
    const stage = updated.stages[updated.stages.length - 1];
    pipelineStore.updateStage(pid, stage.id, { executionMode: mode });
    for (const s of steps) {
      const withStep = pipelineStore.addStep(pid, stage.id, s.config, s.name)!;
      const step = withStep.stages.find((x) => x.id === stage.id)!.steps.slice(-1)[0];
      if (s.description) pipelineStore.updateStep(pid, step.id, { description: s.description });
    }
    return stage.id;
  };

  const run = async (pid: string, dir: string) => {
    const platform = createNodePlatform(dir);
    const executor = new PipelineExecutor({
      invokeAgent,
      onGateWaiting: async (_id: string, prompt: string) => {
        console.log(`    [gate] "${prompt}" → auto-approved (human checkpoint in the app)`);
        return true;
      },
      onLog: (m: string) => console.log(`    [log] ${m}`),
      onStepComplete: (id: string) => console.log(`    ✓ step ${id.slice(0, 8)}`),
    } as any, platform);
    await executor.run(pid);
  };

  const exportRun = (pid: string, dir: string) => {
    const p = pipelineStore.get(pid)!;
    fs.writeFileSync(path.join(dir, 'pipeline.json'), JSON.stringify(p, null, 2));
    const outDir = path.join(dir, 'outputs');
    fs.mkdirSync(outDir, { recursive: true });
    for (const stage of p.stages) {
      for (const step of stage.steps) {
        if (!step.artifact) continue;
        const safe = step.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        fs.writeFileSync(path.join(outDir, `${safe}.md`),
          `# ${step.name} (${step.config.type}) — ${step.status}\n\n` +
          `> ${step.description || ''}\n\n${step.artifact.content}\n`);
      }
    }
    return p;
  };

  // =========================================================================
  // 01 · Market Brief — file input → enrich → analysis → review
  // =========================================================================
  const ex01 = async (dir: string) => {
    const pid = pipelineStore.create({ name: 'EXAMPLE · Market Brief' }).id;
    pipelineStore.update(pid, {
      description: 'Reads a product README, mines opportunities, decides a positioning, and writes a polished market brief.',
      inputSource: {
        kind: 'file',
        value: path.resolve(ROOT, '..', 'README.md'),
        instructions: 'This is the README of Kondi, a multi-LLM council/pipeline desktop app. Base all analysis on what this product actually is.',
      },
    });
    addLayer(pid, [{
      name: 'Opportunity mining',
      description: 'Enrich council debates market opportunities for the product described in the input README.',
      config: {
        type: 'enrich',
        councilSetup: {
          name: 'Opportunity Council',
          personas: [
            persona('manager', 'Product Lead', SUPER, { suppressPersona: false, traits: ['strategic'] }),
            persona('consultant', 'Market Skeptic', NANO, { traits: ['critical'] }),
            persona('worker', 'Researcher', CLAUDE_CLI),
          ],
          maxRounds: 1, maxRevisions: 1,
          expectedOutput: 'A structured list of 4-6 market opportunities with target user, pain point, and why this product wins. No fluff.',
        },
        task: 'From the README in the input, identify the strongest market opportunities for this product.',
        inputTemplate: '{{input}}',
        outputType: 'string',
      },
    }]);
    addLayer(pid, [{
      name: 'Positioning decision',
      description: 'Analysis step (manager-only) picks ONE opportunity and commits to a positioning.',
      config: {
        type: 'analysis',
        councilSetup: {
          name: 'Positioning',
          personas: [persona('manager', 'Strategist', SUPER, {
            suppressPersona: false,
            systemPrompt: 'You are a decisive product strategist. Choose exactly ONE opportunity from the input and commit. Structure: Decision, Rationale, Risks, Next Steps.',
            traits: ['decisive'],
          })],
          maxRounds: 1, maxRevisions: 0,
          expectedOutput: 'One chosen positioning with rationale, top 3 risks, and 3 next steps.',
        },
        task: 'From the market opportunities in the input, choose exactly ONE and commit to it as the positioning. Do not discuss process — decide.',
        inputTemplate: '{{input}}',
        outputType: 'string',
      },
    }]);
    addLayer(pid, [{
      name: 'Brief writing',
      description: 'Council turns the decision into a polished one-page market brief (saved to disk).',
      config: {
        type: 'council',
        councilSetup: {
          name: 'Brief Council',
          personas: [
            persona('manager', 'Editor', SUPER, { suppressPersona: false }),
            persona('worker', 'Writer', SUPER, { saveOutput: true }),
          ],
          maxRounds: 1, maxRevisions: 1,
          expectedOutput: 'A one-page market brief: headline positioning, target user, three key messages, competitive angle, first-90-days plan. Markdown.',
        },
        task: 'Write the final one-page market brief based on the positioning decision in the input.',
        inputTemplate: '{{input}}',
        outputType: 'string',
      },
    }]);
    await run(pid, dir);
    return exportRun(pid, dir);
  };

  // =========================================================================
  // 02 · Code Factory — plan → gate → code (claude CLI) → test → loop → notes
  // =========================================================================
  const ex02 = async (dir: string) => {
    const ws = path.join(dir, 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    const pid = pipelineStore.create({ name: 'EXAMPLE · Code Factory' }).id;
    pipelineStore.update(pid, {
      description: 'Plans, human-gates, implements (real CLI agent), tests, loops on failure, and writes release notes for a small utility.',
      initialInput: [
        'Build a Node.js command-line utility `wordfreq.js` in the current directory:',
        '- Usage: node wordfreq.js <file> [N]  — prints the N (default 10) most frequent words',
        '- Case-insensitive, strips punctuation, ignores words shorter than 3 chars',
        '- Output format: one "word count" pair per line, sorted by count desc then alphabetically',
        '- Also create test.js: runs wordfreq.js against a fixture it writes itself,',
        '  checks the expected ordering, and prints exactly "ALL TESTS PASS" on success',
        '  (any failure prints "TEST FAILED: <reason>" and exits 1).',
      ].join('\n'),
      settings: { workingDirectory: ws, failurePolicy: 'stop', directoryConstrained: true } as any,
    });
    const codingLayer = { id: '' };
    addLayer(pid, [{
      name: 'Implementation plan',
      description: 'Code-planning council decomposes the spec into an actionable plan.',
      config: {
        type: 'code_planning',
        councilSetup: {
          name: 'Planning',
          personas: [
            persona('manager', 'Planning Lead', SUPER, { suppressPersona: false }),
            // Code-flavored step types frame prompts around repo tools — the
            // worker must actually HAVE them (a tool-less model once turned the
            // list_directory tool description into a listDirectory library plan).
            persona('worker', 'Plan Author', CLAUDE_CLI),
          ],
          maxRounds: 1, maxRevisions: 0,
          expectedOutput: 'A short implementation plan: file list, function breakdown, edge cases, and the test strategy.',
        },
        inputTemplate: '{{input}}',
        outputType: 'string',
      },
    }]);
    addLayer(pid, [{
      name: 'Plan approval',
      description: 'Human gate — the plan must be approved before code is written (auto-approved in this scripted run).',
      config: { type: 'gate', approvalPrompt: 'Review the implementation plan above. Proceed to implementation?' },
    }]);
    codingLayer.id = addLayer(pid, [{
      name: 'Implementation',
      description: 'Coding council: a real CLI agent (claude) writes wordfreq.js and test.js in the working directory.',
      config: {
        type: 'coding',
        councilSetup: {
          name: 'Build',
          personas: [
            persona('manager', 'Tech Lead', SUPER, { suppressPersona: false }),
            persona('worker', 'Developer', CLAUDE_CLI, { saveOutput: true }),
          ],
          maxRounds: 1, maxRevisions: 0,
          maxReviewCycles: 1, maxDebugCycles: 2,
          testCommand: 'node test.js',
          expectedOutput: 'wordfreq.js and test.js exist in the working directory and node test.js prints ALL TESTS PASS.',
        },
        inputTemplate: '{{input}}',
        outputType: 'directory',
      },
    }]);
    addLayer(pid, [{
      name: 'Test run',
      description: 'Script step actually executes the test suite in the working directory.',
      config: {
        type: 'script',
        // The coding merge lands final files at the workingDir root, but a
        // worker may leave them in the .kondi/workspace scratch dir (rule 17)
        // — run the tests wherever test.js actually is.
        command: '[ -f test.js ] || cd .kondi/workspace; node test.js && echo "SCRIPT-VERIFIED"',
        inputTemplate: 'none',
        outputType: 'string',
      },
    }]);
    addLayer(pid, [{
      name: 'Ship check',
      description: 'Condition: tests must pass; otherwise loop back to Implementation (max 1 retry), failing the run if still broken.',
      config: {
        type: 'condition',
        expression: 'ALL TESTS PASS', mode: 'contains',
        inputTemplate: '{{input}}',
        trueAction: 'continue', falseAction: 'loop_to_stage',
        loopTargetStageId: codingLayer.id, maxLoops: 1, onLoopExhausted: 'fail',
      },
    }]);
    addLayer(pid, [{
      name: 'Docs & code review',
      description: 'Review council: a CLI agent audits the shipped code against the spec and writes README.md, docs/, and review.md.',
      config: {
        type: 'review',
        councilSetup: {
          name: 'Review',
          personas: [
            persona('manager', 'Review Lead', SUPER, { suppressPersona: false }),
            persona('worker', 'Auditor', CLAUDE_CLI, { saveOutput: true }),
          ],
          maxRounds: 1, maxRevisions: 0,
          expectedOutput: 'README.md, a docs/ folder, and review.md exist in the working directory; review.md evaluates spec adherence and code quality.',
        },
        task: 'Review the wordfreq utility that was just implemented and tested against the original spec (in your input). Produce the documentation set.',
        inputTemplate: '{{input}}',
        includePipelineInput: true,
        outputType: 'directory',
      },
    }]);
    addLayer(pid, [{
      name: 'Release notes',
      description: 'Agent writes concise release notes for the shipped utility.',
      config: {
        type: 'agent',
        councilSetup: {
          name: 'Notes',
          personas: [persona('worker', 'Release Writer', SUPER)],
          maxRounds: 1, maxRevisions: 0,
          expectedOutput: 'Release notes: what the tool does, usage examples, and test status. Under 200 words.',
        },
        task: 'Write release notes for the utility that was just built and tested. The test output is in your input.',
        inputTemplate: '{{input}}',
        includePipelineInput: true,
        outputType: 'string',
      },
    }]);
    await run(pid, dir);
    return exportRun(pid, dir);
  };

  // =========================================================================
  // 03 · Policy Debate — full council → condition guard → executive summary
  // =========================================================================
  const ex03 = async (dir: string) => {
    const pid = pipelineStore.create({ name: 'EXAMPLE · Policy Debate' }).id;
    pipelineStore.update(pid, {
      description: 'A full multi-persona council debates a real policy question; a guard verifies a recommendation exists; an agent distills the executive summary.',
      initialInput: 'Should a 40-person software company adopt a 4-day work week? Deliberate and produce a clear recommendation with conditions.',
    });
    addLayer(pid, [{
      name: 'Council deliberation',
      description: 'Full council: manager frames, two opposed consultants debate (2 rounds), worker synthesizes the recommendation.',
      config: {
        type: 'council',
        councilSetup: {
          name: 'Work-Week Council',
          personas: [
            persona('manager', 'Chair', SUPER, { suppressPersona: false, traits: ['analytical'] }),
            persona('consultant', 'Advocate', SUPER, { suppressPersona: false, stance: 'advocate', traits: ['optimistic'] }),
            persona('consultant', 'Skeptic', NANO, { suppressPersona: false, stance: 'critic', traits: ['critical'] }),
            persona('worker', 'Rapporteur', SUPER),
          ],
          maxRounds: 2, maxRevisions: 1,
          expectedOutput: 'A deliberated verdict containing the word RECOMMENDATION, with conditions for adoption, key risks, and a trial design.',
        },
        inputTemplate: '{{input}}',
        outputType: 'string',
      },
    }]);
    addLayer(pid, [{
      name: 'Verdict guard',
      description: 'Condition: the council output must contain an explicit RECOMMENDATION or the pipeline stops rather than shipping mush.',
      config: {
        type: 'condition',
        expression: 'RECOMMENDATION', mode: 'contains',
        inputTemplate: '{{input}}',
        trueAction: 'continue', falseAction: 'stop',
      },
    }]);
    addLayer(pid, [{
      name: 'Executive summary',
      description: 'Agent compresses the deliberation into a one-paragraph executive summary + 5 bullet decisions.',
      config: {
        type: 'agent',
        councilSetup: {
          name: 'Summary',
          personas: [persona('worker', 'Summarizer', NANO)],
          maxRounds: 1, maxRevisions: 0,
          expectedOutput: 'One paragraph (<=120 words) plus exactly 5 bullets: verdict, conditions, risk, metric, review date.',
        },
        task: 'Compress the deliberation into an executive summary: one paragraph plus exactly 5 bullets (verdict, conditions, top risk, success metric, review date).',
        inputTemplate: '{{input}}',
        outputType: 'string',
      },
    }]);
    await run(pid, dir);
    return exportRun(pid, dir);
  };

  // =========================================================================
  // 04 · Content Refinery — url input → extract json → parallel lenses →
  //                          synthesis council → length script → guard loop
  // =========================================================================
  const ex04 = async (dir: string) => {
    const pid = pipelineStore.create({ name: 'EXAMPLE · Content Refinery' }).id;
    pipelineStore.update(pid, {
      description: 'Fetches a live web page, extracts structured facts, analyzes them through two parallel lenses, synthesizes an explainer, and enforces length mechanically.',
      inputSource: {
        kind: 'url',
        value: 'https://en.wikipedia.org/api/rest_v1/page/summary/Delphi_method',
        instructions: 'The input is JSON from the Wikipedia summary API about the Delphi method. Work from its extract text; supplement with your own knowledge of the method where the summary is thin.',
      },
    });
    addLayer(pid, [{
      name: 'Fact extraction',
      description: 'Agent extracts the key facts from the fetched page as strict JSON ({{input.field}} feeds later steps).',
      config: {
        type: 'agent',
        councilSetup: {
          name: 'Extractor',
          // suppressPersona:false — a SUPPRESSED worker's custom systemPrompt is
          // silently replaced by the minimal worker prompt, so the JSON contract
          // must ride both the persona prompt AND the task.
          personas: [persona('worker', 'Extractor', SUPER, {
            suppressPersona: false,
            systemPrompt: 'You have NO tools. Do not emit tool calls. Read the input text and reply with STRICT JSON only, no prose.',
          })],
          maxRounds: 1, maxRevisions: 0,
          expectedOutput: 'Valid JSON with topic, definition, origin, key_steps[], criticisms[].',
        },
        task: 'Reply with ONE strict JSON object and nothing else — no prose, no markdown: {"topic": string, "definition": string, "origin": string, "key_steps": string[], "criticisms": string[]}. Populate it from the input text, supplementing thin fields from your knowledge of the topic.',
        inputTemplate: '{{input}}',
        outputType: 'json',
      },
    }]);
    const synthesisTarget = { id: '' };
    addLayer(pid, [
      {
        name: 'Practitioner lens',
        description: 'Analysis (parallel): when should a team actually use this method?',
        config: {
          type: 'analysis',
          councilSetup: {
            name: 'Practitioner',
            personas: [persona('manager', 'Practitioner', SUPER, {
              systemPrompt: 'You advise working teams. From the facts in the input, decide WHEN this method is worth using and when it is not. Structure: Decision, Rationale, Risks, Next Steps.',
            })],
            maxRounds: 1, maxRevisions: 0,
            expectedOutput: 'Clear guidance on when to use / when to avoid, grounded in the extracted facts.',
          },
          inputTemplate: 'Topic: {{input.topic}}\nDefinition: {{input.definition}}\nKey steps: {{input.key_steps}}\nCriticisms: {{input.criticisms}}',
          outputType: 'string',
        },
      },
      {
        name: 'Historian lens',
        description: 'Analysis (parallel): where does this method come from and how did it evolve?',
        config: {
          type: 'analysis',
          councilSetup: {
            name: 'Historian',
            personas: [persona('manager', 'Historian', NANO, {
              systemPrompt: 'You are a methods historian. From the facts in the input, decide what the essential historical context is. Structure: Decision (what matters), Rationale, Risks (of misreading history), Next Steps.',
            })],
            maxRounds: 1, maxRevisions: 0,
            expectedOutput: 'The essential origin story and evolution, grounded in the extracted facts.',
          },
          inputTemplate: 'Topic: {{input.topic}}\nOrigin: {{input.origin}}\nDefinition: {{input.definition}}',
          outputType: 'string',
        },
      },
    ], 'parallel');
    synthesisTarget.id = addLayer(pid, [{
      name: 'Explainer synthesis',
      description: 'Council merges both lenses into a 350-450 word explainer for a general audience.',
      config: {
        type: 'council',
        councilSetup: {
          name: 'Synthesis',
          personas: [
            persona('manager', 'Editor', SUPER, { suppressPersona: false }),
            persona('worker', 'Writer', SUPER),
          ],
          maxRounds: 1, maxRevisions: 1,
          expectedOutput: 'A 350-450 word explainer titled with the topic, weaving practical guidance with history. Plain language.',
        },
        task: 'Write a 350-450 word explainer combining BOTH analyses in the input. It MUST be between 350 and 450 words.',
        inputTemplate: '{{input}}',
        outputType: 'string',
      },
    }]);
    addLayer(pid, [{
      name: 'Length check',
      description: 'Script counts words mechanically — no trusting the model.',
      config: {
        type: 'script',
        command: 'N=$(echo "$KONDI_INPUT" | wc -w); if [ "$N" -ge 300 ] && [ "$N" -le 500 ]; then echo "LENGTH OK ($N words)"; else echo "LENGTH BAD ($N words)"; fi',
        inputTemplate: '{{input}}',
        outputType: 'string',
      },
    }]);
    addLayer(pid, [{
      name: 'Length gate',
      description: 'Condition: loop back to synthesis (with the measured word count as feedback) until the length lands, max 2 tries.',
      config: {
        type: 'condition',
        expression: 'LENGTH OK', mode: 'contains',
        inputTemplate: '{{input}}',
        trueAction: 'continue', falseAction: 'loop_to_stage',
        loopTargetStageId: synthesisTarget.id, maxLoops: 2, onLoopExhausted: 'continue',
      },
    }]);
    await run(pid, dir);
    return exportRun(pid, dir);
  };

  // ---------------- runner ----------------
  const examples: Record<string, (dir: string) => Promise<Pipeline>> = {
    '01-market-brief': ex01,
    '02-code-factory': ex02,
    '03-policy-debate': ex03,
    '04-content-refinery': ex04,
  };
  const only = process.argv.slice(2);
  for (const [id, fn] of Object.entries(examples)) {
    if (only.length && !only.some((o) => id.startsWith(o))) continue;
    const dir = path.join(ROOT, id);
    fs.mkdirSync(dir, { recursive: true });
    console.log(`\n=== ${id} ===`);
    try {
      const p = await fn(dir);
      const steps = p.stages.flatMap((s) => s.steps);
      console.log(`DONE ${id}: ${p.status} — ${steps.filter((s) => s.status === 'completed').length}/${steps.length} steps completed`);
    } catch (e) {
      console.error(`FAILED ${id}:`, e instanceof Error ? e.message : e);
    }
  }
}

main().catch((e) => { console.error('CRASH:', e); process.exit(2); });
