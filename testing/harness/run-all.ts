/**
 * Kondi pipeline E2E harness.
 *
 * Runs the REAL PipelineExecutor + stores + Node platform (real fs) against a
 * series of feature-coverage pipelines (one folder per test under testing/).
 * LLM personas call NVIDIA NIM for genuine completions; personas whose name
 * starts with "SCRIPTED:" are answered by the harness deterministically so
 * control-flow tests can't flake.
 *
 * Run from mcp-connect-mvp/ (node_modules resolution):
 *   NVIDIA_API_KEY=... npx tsx ../testing/harness/run-all.ts [testId ...]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Browser shims (stores expect localStorage/window)
// ---------------------------------------------------------------------------
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};
(globalThis as any).window = globalThis;

const TESTS_ROOT = path.resolve(__dirname, '..');

async function main() {
  const { pipelineStore } = await import('../../mcp-connect-mvp/src/pipeline/store');
  const { PipelineExecutor } = await import('../../mcp-connect-mvp/src/pipeline/executor');
  const { createNodePlatform } = await import('../../mcp-connect-mvp/cli/node-platform');
  const { callLLM } = await import('../../mcp-connect-mvp/cli/llm-caller');
  const { getDecision, getLatestOutput } = await import('../../mcp-connect-mvp/src/council/context-store');
  type PipelinePersona = import('../../mcp-connect-mvp/src/pipeline/types').PipelinePersona;
  type CouncilStepConfig = import('../../mcp-connect-mvp/src/pipeline/types').CouncilStepConfig;
  type StepConfig = import('../../mcp-connect-mvp/src/pipeline/types').StepConfig;
  type Pipeline = import('../../mcp-connect-mvp/src/pipeline/types').Pipeline;

  const NIM = { model: 'nvidia/nemotron-3-nano-30b-a3b', provider: 'nvidia-router' };

  // ---------------- personas ----------------
  const worker = (name: string, extra: Partial<PipelinePersona> = {}): PipelinePersona => ({
    name, role: 'worker', model: NIM.model, provider: NIM.provider,
    suppressPersona: true, traits: ['thorough'], saveOutput: extra.saveOutput ?? false, ...extra,
  });
  const manager = (name: string, extra: Partial<PipelinePersona> = {}): PipelinePersona => ({
    name, role: 'manager', model: NIM.model, provider: NIM.provider,
    suppressPersona: true, traits: ['decisive'], ...extra,
  });

  const lightweight = (
    type: 'agent' | 'analysis',
    personas: PipelinePersona[],
    opts: Partial<CouncilStepConfig> = {},
  ): CouncilStepConfig => ({
    type,
    councilSetup: { name: type, personas, maxRounds: 1, maxRevisions: 0 },
    inputTemplate: '{{input}}',
    ...opts,
  });

  // ---------------- invocation recording + scripted personas ----------------
  interface Recorded { persona: string; system: string; user: string }
  let recorded: Recorded[] = [];
  let scripted: Record<string, (n: number, user: string) => string> = {};
  const counters = new Map<string, number>();

  const invokeAgent = async (invocation: any, persona: any) => {
    recorded.push({ persona: persona.name, system: invocation.systemPrompt || '', user: invocation.userMessage || '' });
    if (persona.name.startsWith('SCRIPTED:')) {
      const key = persona.name.slice('SCRIPTED:'.length);
      const n = (counters.get(persona.name) || 0) + 1;
      counters.set(persona.name, n);
      if (key === 'BOOM') throw new Error('Injected step failure (SCRIPTED:BOOM)');
      const fn = scripted[key];
      if (!fn) throw new Error(`No script for persona ${persona.name}`);
      return { content: fn(n, invocation.userMessage || ''), tokensUsed: 0, model: 'scripted' };
    }
    const result = await callLLM({
      provider: persona.provider, model: persona.model,
      systemPrompt: invocation.systemPrompt, userMessage: invocation.userMessage,
      skipTools: true, timeoutMs: 180_000,
    } as any);
    return { content: result.content, tokensUsed: result.tokensUsed, model: persona.model } as any;
  };

  // ---------------- assertions ----------------
  interface Check { name: string; pass: boolean; detail?: string }
  let checks: Check[] = [];
  const expect = (name: string, pass: boolean, detail?: string) => {
    checks.push({ name, pass, detail: pass ? undefined : detail });
    console.log(`    ${pass ? 'ok  ' : 'FAIL'} ${name}${!pass && detail ? ` — ${detail}` : ''}`);
  };
  const calls = (personaName: string) =>
    recorded.filter((r) => r.persona === personaName);

  // ---------------- pipeline builder helpers ----------------
  const buildPipeline = (name: string, opts: Partial<Pipeline> = {}) => {
    const p = pipelineStore.create({ name });
    if (Object.keys(opts).length) pipelineStore.update(p.id, opts as any);
    return p.id;
  };
  const addLayer = (pid: string, steps: { name: string; config: StepConfig }[], mode: 'sequential' | 'parallel' = 'sequential') => {
    const updated = pipelineStore.addStage(pid)!;
    const stage = updated.stages[updated.stages.length - 1];
    pipelineStore.updateStage(pid, stage.id, { executionMode: mode });
    for (const s of steps) pipelineStore.addStep(pid, stage.id, s.config, s.name);
    return stage.id;
  };
  const steps = (pid: string) => pipelineStore.get(pid)!.stages.flatMap((s) => s.steps);
  const stepByName = (pid: string, name: string) => steps(pid).find((s) => s.name === name)!;

  const mkExecutor = (workDir: string, overrides: any = {}) => {
    const platform = createNodePlatform(workDir);
    return new PipelineExecutor({
      invokeAgent,
      onLog: (m: string) => console.log(`    [log] ${m}`),
      ...overrides,
    } as any, platform);
  };

  // ---------------- test registry ----------------
  interface Test { id: string; run: (dir: string) => Promise<void> }
  const tests: Test[] = [];
  const test = (id: string, run: (dir: string) => Promise<void>) => tests.push({ id, run });

  // =========================================================================
  test('01-linear-chain', async (dir) => {
    const pid = buildPipeline('TEST 01 · linear chain', {
      initialInput: 'Our team ships a desktop app. Should we add auto-update? Answer briefly.',
      inputSource: { kind: 'text', instructions: 'Decide, then have the next step summarize.' },
    });
    addLayer(pid, [{ name: 'decide', config: lightweight('analysis', [manager('Analyst')]) }]);
    addLayer(pid, [{ name: 'summarize', config: {
      ...lightweight('agent', [worker('Summarizer')]),
      task: 'Summarize the input decision in ONE sentence.',
    } }]);
    await mkExecutor(dir).run(pid);

    const p = pipelineStore.get(pid)!;
    expect('pipeline completed', p.status === 'completed', p.status);
    const decideStep = stepByName(pid, 'decide');
    expect('analysis artifact is a decision', decideStep.artifact?.artifactType === 'decision',
      decideStep.artifact?.artifactType);
    const decision = getDecision(decideStep.artifact!.metadata!.councilId!);
    expect('decision artifact exists in council store', !!decision?.content);
    const sumCalls = calls('Summarizer');
    expect('summarizer received the decision text', sumCalls.length > 0 &&
      sumCalls[0].user.includes((decideStep.artifact?.content || 'NOPE').slice(0, 40)));
    expect('instructions reached step 1', calls('Analyst')[0]?.user.includes('Decide, then have the next step'));
  });

  // =========================================================================
  test('02-parallel-join', async (dir) => {
    const pid = buildPipeline('TEST 02 · parallel join', { initialInput: 'seed' });
    addLayer(pid, [
      { name: 'left', config: lightweight('agent', [worker('SCRIPTED:LEFT')]) },
      { name: 'right', config: lightweight('agent', [worker('SCRIPTED:RIGHT')]) },
    ], 'parallel');
    addLayer(pid, [
      { name: 'join-all', config: lightweight('agent', [worker('SCRIPTED:JOIN')]) },
    ]);
    addLayer(pid, [
      { name: 'pick-first', config: {
        ...lightweight('agent', [worker('SCRIPTED:PICK')]),
        inputTemplate: '{{input[0]}}',
      } },
    ]);
    scripted = {
      LEFT: () => 'ALPHA-OUTPUT',
      RIGHT: () => 'BETA-OUTPUT',
      JOIN: (_n, user) => `joined:${user.includes('ALPHA-OUTPUT') && user.includes('BETA-OUTPUT')}`,
      PICK: (_n, user) => `picked:${user}`,
    };
    await mkExecutor(dir).run(pid);

    expect('both parallel steps completed',
      stepByName(pid, 'left').status === 'completed' && stepByName(pid, 'right').status === 'completed');
    expect('join saw BOTH parallel outputs',
      stepByName(pid, 'join-all').artifact?.content === 'joined:true',
      stepByName(pid, 'join-all').artifact?.content);
    const pick = calls('SCRIPTED:PICK')[0];
    expect('{{input[0]}} selected only the first prior artifact',
      !!pick && pick.user.includes('joined:') === true && !pick.user.includes('BETA-OUTPUT'));
  });

  // =========================================================================
  test('03-json-fields', async (dir) => {
    const pid = buildPipeline('TEST 03 · json fields', { initialInput: 'produce the json' });
    addLayer(pid, [{ name: 'emit-json', config: {
      ...lightweight('agent', [worker('SCRIPTED:EMIT')]),
      outputType: 'json',
    } }]);
    addLayer(pid, [{ name: 'consume', config: {
      ...lightweight('agent', [worker('SCRIPTED:CONSUME')]),
      inputTemplate: 'FRUIT={{input.fruit}};N={{input.stats.n}}',
    } }]);
    scripted = {
      EMIT: () => 'Sure! Here is the JSON you asked for:\n```json\n{"fruit": "mango", "stats": {"n": 3}}\n```\nLet me know if you need more.',
      CONSUME: (_n, user) => `got[${user}]`,
    };
    await mkExecutor(dir).run(pid);

    const emitted = stepByName(pid, 'emit-json').artifact?.content || '';
    expect('fenced JSON recovered to clean JSON at store time', emitted.trim().startsWith('{'),
      emitted.slice(0, 60));
    const consume = calls('SCRIPTED:CONSUME')[0];
    expect('{{input.field}} dot-paths resolved', !!consume && consume.user.includes('FRUIT=mango;N=3'),
      consume?.user.slice(0, 200));
  });

  // =========================================================================
  test('04-condition-branch', async (dir) => {
    // true → continue
    const pid = buildPipeline('TEST 04a · condition continue', { initialInput: 'go' });
    addLayer(pid, [{ name: 'produce', config: lightweight('agent', [worker('SCRIPTED:P1')]) }]);
    addLayer(pid, [{ name: 'check', config: {
      type: 'condition', expression: 'QUALITY: GOOD', mode: 'contains',
      inputTemplate: '{{input}}', trueAction: 'continue', falseAction: 'stop',
    } }]);
    addLayer(pid, [{ name: 'after', config: lightweight('agent', [worker('SCRIPTED:P2')]) }]);
    scripted = { P1: () => 'result... QUALITY: GOOD', P2: () => 'ran-after' };
    await mkExecutor(dir).run(pid);
    expect('true→continue: downstream ran', stepByName(pid, 'after').status === 'completed');

    // false → stop
    const pid2 = buildPipeline('TEST 04b · condition stop', { initialInput: 'go' });
    addLayer(pid2, [{ name: 'produce', config: lightweight('agent', [worker('SCRIPTED:P1')]) }]);
    addLayer(pid2, [{ name: 'check', config: {
      type: 'condition', expression: 'QUALITY: GOOD', mode: 'contains',
      inputTemplate: '{{input}}', trueAction: 'continue', falseAction: 'stop',
    } }]);
    addLayer(pid2, [{ name: 'after', config: lightweight('agent', [worker('SCRIPTED:P2')]) }]);
    scripted = { P1: () => 'result... QUALITY: BAD', P2: () => 'ran-after' };
    await mkExecutor(dir).run(pid2);
    const after2 = stepByName(pid2, 'after');
    expect('false→stop: downstream did NOT run', after2.status !== 'completed', after2.status);
    expect('false→stop: pipeline still ends as completed', pipelineStore.get(pid2)!.status === 'completed',
      pipelineStore.get(pid2)!.status);

    // skip_next_stage
    const pid3 = buildPipeline('TEST 04c · condition skip', { initialInput: 'go' });
    addLayer(pid3, [{ name: 'produce', config: lightweight('agent', [worker('SCRIPTED:P1')]) }]);
    addLayer(pid3, [{ name: 'check', config: {
      type: 'condition', expression: 'QUALITY: GOOD', mode: 'contains',
      inputTemplate: '{{input}}', trueAction: 'skip_next_stage', falseAction: 'continue',
    } }]);
    addLayer(pid3, [{ name: 'skipped-one', config: lightweight('agent', [worker('SCRIPTED:P2')]) }]);
    addLayer(pid3, [{ name: 'final', config: lightweight('agent', [worker('SCRIPTED:P3')]) }]);
    scripted = { P1: () => 'QUALITY: GOOD', P2: () => 'should-not-run', P3: () => 'final-ran' };
    await mkExecutor(dir).run(pid3);
    expect('skip_next_stage: next step skipped', stepByName(pid3, 'skipped-one').status === 'skipped',
      stepByName(pid3, 'skipped-one').status);
    expect('skip_next_stage: following step ran', stepByName(pid3, 'final').status === 'completed',
      stepByName(pid3, 'final').status);
  });

  // =========================================================================
  test('05-loop-feedback', async (dir) => {
    const pid = buildPipeline('TEST 05 · loop feedback', { initialInput: 'write the thing' });
    const workLayer = addLayer(pid, [{ name: 'work', config: lightweight('agent', [worker('SCRIPTED:W')]) }]);
    addLayer(pid, [{ name: 'quality-gate', config: {
      type: 'condition', expression: 'STATUS: PASS', mode: 'contains',
      inputTemplate: '{{input}}', trueAction: 'continue', falseAction: 'loop_to_stage',
      loopTargetStageId: workLayer, maxLoops: 3,
    } }]);
    addLayer(pid, [{ name: 'done', config: lightweight('agent', [worker('SCRIPTED:D')]) }]);
    scripted = {
      W: (n) => n === 1 ? 'attempt one. STATUS: FAIL — too vague' : 'attempt two, improved. STATUS: PASS',
      D: () => 'finished',
    };
    await mkExecutor(dir).run(pid);

    const w = calls('SCRIPTED:W');
    expect('worker ran twice (loop fired once)', w.length === 2, `${w.length} calls`);
    expect('retry received the loop feedback', w.length === 2 &&
      w[1].user.includes('THIS IS A RETRY') && w[1].user.includes('STATUS: FAIL'),
      w[1]?.user.slice(0, 300));
    expect('pipeline completed after PASS', pipelineStore.get(pid)!.status === 'completed');

    // exhaustion → fail
    counters.clear();
    const pid2 = buildPipeline('TEST 05b · loop exhausted', { initialInput: 'write the thing' });
    const wl2 = addLayer(pid2, [{ name: 'work', config: lightweight('agent', [worker('SCRIPTED:W2')]) }]);
    addLayer(pid2, [{ name: 'quality-gate', config: {
      type: 'condition', expression: 'STATUS: PASS', mode: 'contains',
      inputTemplate: '{{input}}', trueAction: 'continue', falseAction: 'loop_to_stage',
      loopTargetStageId: wl2, maxLoops: 2, onLoopExhausted: 'fail',
    } }]);
    scripted = { W2: () => 'STATUS: FAIL forever' };
    let failed = false;
    try { await mkExecutor(dir).run(pid2); } catch { failed = true; }
    expect('exhausted loop with onLoopExhausted=fail rejects the run', failed);
    expect('worker ran initial + maxLoops times', calls('SCRIPTED:W2').length === 3,
      `${calls('SCRIPTED:W2').length} calls`);
    expect('pipeline marked failed', pipelineStore.get(pid2)!.status === 'failed',
      pipelineStore.get(pid2)!.status);
  });

  // =========================================================================
  test('06-script-step', async (dir) => {
    const pid = buildPipeline('TEST 06 · script step', { initialInput: 'ignored' });
    addLayer(pid, [{ name: 'emit', config: lightweight('agent', [worker('SCRIPTED:E')]) }]);
    addLayer(pid, [{ name: 'shell', config: {
      type: 'script', command: 'echo "SCRIPT_SAW=$KONDI_INPUT"', inputTemplate: '{{input}}',
    } }]);
    addLayer(pid, [{ name: 'reader', config: lightweight('agent', [worker('SCRIPTED:R')]) }]);
    scripted = { E: () => 'payload-42', R: (_n, user) => `reader[${user}]` };
    await mkExecutor(dir).run(pid);

    const shellOut = stepByName(pid, 'shell').artifact?.content || '';
    expect('script saw previous output via $KONDI_INPUT', shellOut.includes('SCRIPT_SAW=') && shellOut.includes('payload-42'),
      shellOut.slice(0, 120));
    expect('script stdout chained to next step', (calls('SCRIPTED:R')[0]?.user || '').includes('SCRIPT_SAW='),
      calls('SCRIPTED:R')[0]?.user.slice(0, 120));
  });

  // =========================================================================
  test('07-input-sources', async (dir) => {
    // file source
    const filePath = path.join(dir, 'input-data.md');
    fs.writeFileSync(filePath, '# The secret ingredient is saffron\n');
    const pid = buildPipeline('TEST 07a · file input', {
      inputSource: { kind: 'file', value: filePath, instructions: 'Summarize the file contents.' },
    });
    addLayer(pid, [{ name: 'first', config: lightweight('agent', [worker('SCRIPTED:F')]) }]);
    scripted = { F: (_n, user) => `saw[${user}]` };
    await mkExecutor(dir).run(pid);
    const f = calls('SCRIPTED:F')[0];
    expect('file source: path + read instruction delivered', !!f &&
      f.user.includes('[Input type: file]') && f.user.includes(filePath) && f.user.includes('read that file'),
      f?.user.slice(0, 300));
    expect('file source: instructions delivered', !!f && f.user.includes('Summarize the file contents.'));

    // directory source
    const pid2 = buildPipeline('TEST 07b · directory input', {
      inputSource: { kind: 'directory', value: dir, instructions: 'Read everything.' },
    });
    addLayer(pid2, [{ name: 'first', config: lightweight('agent', [worker('SCRIPTED:G')]) }]);
    scripted = { G: (_n, user) => `saw[${user}]` };
    await mkExecutor(dir).run(pid2);
    const g = calls('SCRIPTED:G')[0];
    expect('directory source: dir + list instruction delivered', !!g &&
      g.user.includes('[Input type: directory]') && g.user.includes(dir),
      g?.user.slice(0, 300));

    // url source (real fetch)
    const pid3 = buildPipeline('TEST 07c · url input', {
      inputSource: { kind: 'url', value: 'https://example.com/', instructions: 'Name the domain.' },
    });
    addLayer(pid3, [{ name: 'first', config: lightweight('agent', [worker('SCRIPTED:U')]) }]);
    scripted = { U: (_n, user) => `saw[${user.length}]` };
    await mkExecutor(dir).run(pid3);
    const u = calls('SCRIPTED:U')[0];
    expect('url source: body fetched at run start and delivered', !!u &&
      u.user.includes('[Input source: https://example.com/]') && u.user.includes('Example Domain'),
      u?.user.slice(0, 300));
  });

  // =========================================================================
  test('08-gate', async (dir) => {
    const mk = () => {
      const pid = buildPipeline('TEST 08 · gate', { initialInput: 'go' });
      addLayer(pid, [{ name: 'before', config: lightweight('agent', [worker('SCRIPTED:B')]) }]);
      addLayer(pid, [{ name: 'approval', config: { type: 'gate', approvalPrompt: 'Proceed?' } }]);
      addLayer(pid, [{ name: 'after', config: lightweight('agent', [worker('SCRIPTED:A')]) }]);
      return pid;
    };
    scripted = { B: () => 'work done', A: () => 'after-gate' };

    const approved = mk();
    await mkExecutor(dir, { onGateWaiting: async () => true }).run(approved);
    expect('approved gate: downstream ran', stepByName(approved, 'after').status === 'completed');
    expect('gate artifact recorded', stepByName(approved, 'approval').artifact?.artifactType === 'approval');

    const rejected = mk();
    let threw = false;
    try { await mkExecutor(dir, { onGateWaiting: async () => false }).run(rejected); } catch { threw = true; }
    expect('rejected gate: run fails', threw);
    expect('rejected gate: downstream did not run', stepByName(rejected, 'after').status !== 'completed',
      stepByName(rejected, 'after').status);
  });

  // =========================================================================
  test('09-failure-policy', async (dir) => {
    // stop (default)
    const pid = buildPipeline('TEST 09a · failure stop', { initialInput: 'go' });
    addLayer(pid, [{ name: 'boom', config: lightweight('agent', [worker('SCRIPTED:BOOM')]) }]);
    addLayer(pid, [{ name: 'after', config: lightweight('agent', [worker('SCRIPTED:A')]) }]);
    scripted = { A: () => 'after' };
    let threw = false;
    try { await mkExecutor(dir).run(pid); } catch { threw = true; }
    expect('stop policy: run rejects', threw);
    expect('stop policy: failing step marked failed', stepByName(pid, 'boom').status === 'failed');
    expect('stop policy: downstream never ran', calls('SCRIPTED:A').length === 0);

    // skip_step
    const pid2 = buildPipeline('TEST 09b · failure skip', { initialInput: 'go' });
    pipelineStore.update(pid2, { settings: { ...pipelineStore.get(pid2)!.settings, failurePolicy: 'skip_step' } });
    addLayer(pid2, [{ name: 'boom', config: lightweight('agent', [worker('SCRIPTED:BOOM')]) }]);
    addLayer(pid2, [{ name: 'after', config: lightweight('agent', [worker('SCRIPTED:A2')]) }]);
    scripted = { A2: () => 'after' };
    await mkExecutor(dir).run(pid2);
    expect('skip_step policy: pipeline completes despite failure',
      pipelineStore.get(pid2)!.status === 'completed', pipelineStore.get(pid2)!.status);
    expect('skip_step policy: downstream ran', stepByName(pid2, 'after').status === 'completed',
      stepByName(pid2, 'after').status);
  });

  // =========================================================================
  test('10-resume', async (dir) => {
    const pid = buildPipeline('TEST 10 · resume', { initialInput: 'go' });
    addLayer(pid, [{ name: 'one', config: lightweight('agent', [worker('SCRIPTED:ONE')]) }]);
    addLayer(pid, [{ name: 'two', config: lightweight('agent', [worker('SCRIPTED:TWO')]) }]);
    scripted = { ONE: () => 'first-output', TWO: (_n, user) => `two[${user.includes('first-output')}]` };
    await mkExecutor(dir).run(pid);
    expect('first run completed', pipelineStore.get(pid)!.status === 'completed');
    const oneCallsAfterFirst = calls('SCRIPTED:ONE').length;

    // Prime a rerun of step two only (rerun-forward semantics)
    pipelineStore.setStepStatus(pid, stepByName(pid, 'two').id, 'pending');
    pipelineStore.update(pid, { currentStageIndex: 0, status: 'ready' });
    await mkExecutor(dir).run(pid);

    expect('completed step was skipped on resume', calls('SCRIPTED:ONE').length === oneCallsAfterFirst,
      `${calls('SCRIPTED:ONE').length} vs ${oneCallsAfterFirst}`);
    expect('pending step re-ran with original upstream artifact',
      stepByName(pid, 'two').artifact?.content === 'two[true]',
      stepByName(pid, 'two').artifact?.content);
  });

  // =========================================================================
  test('11-worker-file-output', async (dir) => {
    const pid = buildPipeline('TEST 11 · file output', {
      initialInput: 'Write a two-line haiku about pipelines.',
      settings: { workingDirectory: dir, failurePolicy: 'stop', directoryConstrained: true } as any,
    });
    addLayer(pid, [{ name: 'author', config: {
      ...lightweight('agent', [worker('SCRIPTED:AUTHOR', { saveOutput: true })]),
      outputType: 'string',
    } }]);
    addLayer(pid, [{ name: 'locate', config: {
      ...lightweight('agent', [worker('SCRIPTED:LOC')]),
      inputTemplate: 'path:{{file}}',
    } }]);
    scripted = { AUTHOR: () => 'haiku line one\nhaiku line two', LOC: (_n, user) => user };
    await mkExecutor(dir).run(pid);

    const outputPath = stepByName(pid, 'author').artifact?.metadata?.outputPath;
    expect('worker output written to working dir', !!outputPath && fs.existsSync(outputPath), outputPath);
    expect('file content matches worker output',
      !!outputPath && fs.readFileSync(outputPath, 'utf-8').includes('haiku line one'));
    expect('{{file}} template resolves to the path',
      (stepByName(pid, 'locate').artifact?.content || '').includes(outputPath || 'NOPE'),
      stepByName(pid, 'locate').artifact?.content);
  });

  // =========================================================================
  test('12-full-council', async (dir) => {
    const pid = buildPipeline('TEST 12 · full council', {
      initialInput: 'Pick a name for a coffee shop for programmers. Keep every reply under 40 words.',
    });
    addLayer(pid, [{ name: 'council', config: {
      type: 'council',
      councilSetup: {
        name: 'Naming Council',
        personas: [manager('Lead'), worker('Namer', { saveOutput: false })],
        maxRounds: 1, maxRevisions: 0,
        expectedOutput: 'One shop name with a one-sentence rationale.',
      },
      inputTemplate: '{{input}}',
    } }]);
    await mkExecutor(dir).run(pid);

    const p = pipelineStore.get(pid)!;
    expect('full council pipeline completed', p.status === 'completed', p.status);
    const art = stepByName(pid, 'council').artifact;
    expect('council produced a non-empty output artifact', !!art?.content && art.content.length > 10,
      art?.content?.slice(0, 80));
    const councilId = art?.metadata?.councilId;
    expect('worker output exists in council store', !!councilId && !!getLatestOutput(councilId)?.content);
    expect('manager decision exists in council store', !!councilId && !!getDecision(councilId)?.content);
  });

  // ---------------- runner ----------------
  const only = process.argv.slice(2);
  const toRun = only.length ? tests.filter((t) => only.some((o) => t.id.startsWith(o))) : tests;
  const summary: { id: string; pass: number; fail: number }[] = [];

  for (const t of toRun) {
    const dir = path.join(TESTS_ROOT, t.id);
    fs.mkdirSync(dir, { recursive: true });
    console.log(`\n=== ${t.id} ===`);
    checks = []; recorded = []; scripted = {}; counters.clear();
    try {
      await t.run(dir);
    } catch (e) {
      expect('test harness error', false, e instanceof Error ? e.message : String(e));
    }
    const pass = checks.filter((c) => c.pass).length;
    const fail = checks.length - pass;
    summary.push({ id: t.id, pass, fail });
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
      test: t.id, ranAt: new Date().toISOString(), pass, fail, checks,
      llmCalls: recorded.length,
    }, null, 2));
  }

  // Dump the full store state so test pipelines can be imported into the app.
  fs.writeFileSync(path.join(TESTS_ROOT, 'harness', 'store-dump.json'),
    JSON.stringify(Object.fromEntries((globalThis as any).localStorage === undefined ? [] : mem), null, 1));

  console.log('\n========== SUMMARY ==========');
  let anyFail = false;
  for (const s of summary) {
    if (s.fail > 0) anyFail = true;
    console.log(`${s.fail === 0 ? 'PASS' : 'FAIL'}  ${s.id}  (${s.pass}/${s.pass + s.fail})`);
  }
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS CRASH:', e); process.exit(2); });
