import { describe, it, expect } from 'vitest';
import { buildWorkOrder, stripTaskPrefix, extractAcceptanceCriteria, WORK_ORDER_CAPS } from '../../src/council/work-order';
import type { WorkOrderInput } from '../../src/council/work-order';
import { parseWorkerSignals } from '../../src/council/worker-signals';
import { PipelineExecutor } from '../../src/pipeline/executor';
import type { PlatformAdapter } from '../../src/pipeline/executor';
import { pipelineStore } from '../../src/pipeline/store';
import { councilStore } from '../../src/council/store';
import { createCouncilFromSetup } from '../../src/council/factory';
import type { CouncilStepConfig, PipelinePersona } from '../../src/pipeline/types';

const base: WorkOrderInput = {
  objective: { task: 'Write a blurb.', stepName: 'Blurb', stepType: 'council' },
  deliverable: { outputType: 'string', expectedOutput: 'Three sentences.' },
  acceptance: { acceptanceCriteria: '- mentions price\n- under 70 words', decisionCriteria: ['no jargon'] },
  directive: 'Write the blurb about Quill.',
  constraints: { writePermissions: false, toolScope: 'none', maxWords: 70, timeoutMinutes: 30 },
  attempt: { number: 1, max: 3, mode: 'execute' },
  inputs: [{ stepName: 'Research', outputType: 'json', path: '/wd/research.json' }],
  source: 'Product: Quill. Price: $6/month.',
};

describe('council/work-order', () => {
  it('renders every section in order and the protocol once', () => {
    const o = buildWorkOrder(base);
    const idx = (h: string) => o.indexOf(h);
    expect(idx('# WORK ORDER')).toBe(0);
    for (const h of ['## Objective', '## Deliverable', '## Acceptance criteria', '## Directive', '## Constraints', '## Attempt', '## Inputs from earlier steps', '## Source material', '## HOW TO SIGNAL']) {
      expect(idx(h)).toBeGreaterThan(-1);
    }
    expect(idx('## Objective')).toBeLessThan(idx('## Directive'));
    expect(idx('## Directive')).toBeLessThan(idx('## Source material'));
    expect(o.match(/## HOW TO SIGNAL/g)).toHaveLength(1);
    expect(o).toContain('Step: Blurb (council)');
    expect(o).toContain('- no jargon');
    expect(o).toContain('Attempt 1 of 3 (execute)');
    expect(o).toContain('Research (json) → /wd/research.json');
    expect(o).toContain('about 70 words');
  });

  it('rule 5: a text-deliverable order never names write tools; a full-tools order does; read-only says so', () => {
    const text = buildWorkOrder(base);
    expect(text).not.toMatch(/write_file|run_command|Bash|Edit/);
    expect(text).toContain('NO tools');
    const full = buildWorkOrder({ ...base, constraints: { ...base.constraints, writePermissions: true, toolScope: 'full', workingDirectory: '/wd', directoryConstrained: true } });
    expect(full).toMatch(/file and shell tools/);
    expect(full).toContain('MUST stay inside /wd');
    const ro = buildWorkOrder({ ...base, constraints: { ...base.constraints, toolScope: 'read_only', workingDirectory: '/wd' } });
    expect(ro).toContain('READ-ONLY tools');
    const wt = buildWorkOrder({ ...base, constraints: { ...base.constraints, writePermissions: true, toolScope: 'full', codebase: { mode: 'worktree', branch: 'kondi/x', repoRoot: '/repo' } } });
    expect(wt).toContain('branch `kondi/x`');
    expect(wt).toContain('Do NOT commit');
  });

  it('verification appears only for full-tools workers; revise mode shows feedback + previous output; Q&A rendered', () => {
    const noVerify = buildWorkOrder({ ...base, verification: { command: 'npm test', maxTries: 3 } });
    expect(noVerify).not.toContain('## Verification');
    const withVerify = buildWorkOrder({ ...base, constraints: { ...base.constraints, writePermissions: true, toolScope: 'full' }, verification: { command: 'npm test', maxTries: 2, lastOutputTail: 'FAIL x' } });
    expect(withVerify).toContain('Run `npm test`');
    expect(withVerify).toContain('at most 2 tries');
    expect(withVerify).toContain('FAIL x');
    const rev = buildWorkOrder({ ...base, attempt: { number: 2, max: 3, mode: 'revise', previousOutput: 'old text', feedback: 'add the price', qa: [{ question: 'Which currency?', answer: 'USD', answeredBy: 'manager' }] } });
    expect(rev).toContain('### Reviewer feedback');
    expect(rev).toContain('add the price');
    expect(rev).toContain('### Your previous output');
    expect(rev).toContain('A (manager): USD');
  });

  it('caps long sections and dedupes the task out of the source', () => {
    const long = 'z'.repeat(WORK_ORDER_CAPS.source + 5000);
    const o = buildWorkOrder({ ...base, source: long });
    expect(o).toContain('source material truncated: 5000 more chars');
    expect(stripTaskPrefix('Write a blurb.\n\n---\n\nProduct: Quill', 'Write a blurb.')).toBe('Product: Quill');
    expect(stripTaskPrefix('Write a blurb.', 'Write a blurb.')).toBe('');
    expect(stripTaskPrefix('Unrelated input', 'Write a blurb.')).toBe('Unrelated input');
    expect(stripTaskPrefix(undefined, 'x')).toBe('');
  });

  it('extractAcceptanceCriteria captures the whole section up to the next heading', () => {
    const decision = `SUMMARY:\nDo it.\n\nDECISION:\nBuild X.\n\nACCEPTANCE CRITERIA:\n- criterion one\n\n- criterion two after a blank line\n- criterion three\n\nRISKS:\n- none\n`;
    const ac = extractAcceptanceCriteria(decision)!;
    expect(ac).toContain('criterion one');
    expect(ac).toContain('criterion two after a blank line');
    expect(ac).toContain('criterion three');
    expect(ac).not.toContain('RISKS');
    expect(ac).not.toContain('none');
    const md = `## Decision\nx\n\n## Acceptance Criteria\n1. a\n2. b\n\n## Next steps\nfoo`;
    expect(extractAcceptanceCriteria(md)).toBe('1. a\n2. b');
    expect(extractAcceptanceCriteria('no criteria here')).toBeUndefined();
  });
});

describe('council/worker-signals', () => {
  it('parses complete / partial / unknown statuses and verification lines', () => {
    const c = parseWorkerSignals('text\n\n## COMPLETION SUMMARY\n**Status:** Complete\n**Verification:** exit 0 — `npm test` 12 passing');
    expect(c.status).toBe('complete');
    expect(c.hasCompletionSummary).toBe(true);
    expect(c.verification).toEqual({ exitCode: 0, command: 'npm test', tail: 'exit 0 — `npm test` 12 passing' });
    expect(parseWorkerSignals('x\n\n## COMPLETION SUMMARY\n**Status:** Partial — missing docs').status).toBe('partial');
    expect(parseWorkerSignals('just prose').status).toBe('unknown');
    expect(parseWorkerSignals('just prose').hasCompletionSummary).toBe(false);
    expect(parseWorkerSignals('x\n\n## COMPLETION SUMMARY\n**Status:** Complete\n**Verification:** tests failed (3 red)').verification?.exitCode).toBe(1);
  });

  it('a NEEDS INPUT heading without a completed delivery is a question; with delivery it is not', () => {
    const q = parseWorkerSignals('## NEEDS INPUT\n**Question:** Which currency should prices use?\n');
    expect(q.status).toBe('question');
    expect(q.question).toBe('Which currency should prices use?');
    const both = parseWorkerSignals('## NEEDS INPUT\n**Question:** Which currency?\n\nAnyway here is the blurb.\n\n## COMPLETION SUMMARY\n**Status:** Complete');
    expect(both.status).toBe('complete');
    // Mid-paragraph words are not a signal.
    expect(parseWorkerSignals('The team needs input from legal before launch.').status).toBe('unknown');
    // Bare question text under the heading (no bold label) still counts.
    expect(parseWorkerSignals('## NEEDS INPUT\nShould I include the team plan?').question).toBe('Should I include the team plan?');
  });

  it('Blocked status or heading yields blocked with a reason', () => {
    const b = parseWorkerSignals('I tried.\n\n## COMPLETION SUMMARY\n**Status:** Blocked — the directive asks for a file but the output type is text\n**Known issues:** none');
    expect(b.status).toBe('blocked');
    expect(b.blockedReason).toBe('the directive asks for a file but the output type is text');
    const h = parseWorkerSignals('## BLOCKED\nThe repo has no package.json so there is nothing to test.');
    expect(h.status).toBe('blocked');
    expect(h.blockedReason).toMatch(/no package.json/);
  });
});

describe('executor passes the work-order brief to the worker', () => {
  const persona = (name: string, role: PipelinePersona['role']): PipelinePersona =>
    ({ name, role, model: 'm', provider: 'deepseek', suppressPersona: true, traits: ['t'], saveOutput: false, toolAccess: 'none' });
  const platform: PlatformAdapter = { writeFile: async () => {}, readFile: async () => null, setWorkingDir: () => {}, getWorkingDir: () => '' };

  it('unbound step: worker prompt contains # WORK ORDER, the task alone as Objective, the upstream input ref, and the pipeline input as Source', async () => {
    const p = pipelineStore.create({ name: 'WO', initialInput: 'The pipeline seed.' });
    const s1 = pipelineStore.addStage(p.id)!.stages[0];
    pipelineStore.addStep(p.id, s1.id, { type: 'agent', councilSetup: { name: 'a', personas: [persona('First', 'worker')], maxRounds: 1, maxRevisions: 0 }, task: 'Produce research.', inputTemplate: '{{input}}', outputType: 'string' } as CouncilStepConfig, 'Research');
    const s2 = pipelineStore.addStage(p.id)!.stages[1];
    pipelineStore.addStep(p.id, s2.id, { type: 'agent', councilSetup: { name: 'b', personas: [persona('Second', 'worker')], maxRounds: 1, maxRevisions: 0 }, task: 'Write the blurb from the research.', inputTemplate: '{{input}}', outputType: 'string' } as CouncilStepConfig, 'Blurb');
    const prompts: Record<string, string> = {};
    await new PipelineExecutor({
      invokeAgent: async (inv, who) => { prompts[who.name] = inv.userMessage; return { content: `${who.name} output\n\n## COMPLETION SUMMARY\n**Status:** Complete`, tokensUsed: 1, latencyMs: 1 }; },
    }, platform).run(p.id);
    const second = prompts.Second;
    expect(second).toContain('# WORK ORDER');
    expect(second).toContain('Step: Blurb (agent)');
    expect(second).toMatch(/## Objective[\s\S]*Write the blurb from the research\./);
    expect(second).toContain('## Inputs from earlier steps');
    expect(second).toContain('- Research (string)');
    // The first step's output reaches the worker (direct execution puts the stripped raw problem in the
    // Directive; the managed path puts it in Source), with the task stripped (no duplication).
    expect(second).toMatch(/## (Directive|Source material)[\s\S]*First output/);
    expect(second.split('Write the blurb from the research.').length).toBe(2); // task appears once
    expect(second).toContain('## HOW TO SIGNAL');
  });

  it('bound council: savedProblem keeps the ORIGINAL task after a run (no compounding)', async () => {
    const council = createCouncilFromSetup({ name: 'Bound WO', personas: [persona('Solo', 'worker')], task: 'Original bound task', maxRounds: 0, maxRevisions: 0, stepType: 'agent', outputType: 'string' });
    const p = pipelineStore.create({ name: 'WO bound', initialInput: 'seed' });
    const s = pipelineStore.addStage(p.id)!.stages[0];
    pipelineStore.addStep(p.id, s.id, { type: 'agent', boundCouncilId: council.id, councilSetup: { name: 'shell', personas: [] }, inputTemplate: '{{input}}' } as CouncilStepConfig, 'Bound');
    let seen = '';
    await new PipelineExecutor({
      invokeAgent: async (inv) => { seen = inv.userMessage; return { content: 'ok\n\n## COMPLETION SUMMARY\n**Status:** Complete', tokensUsed: 1, latencyMs: 1 }; },
    }, platform).run(p.id);
    expect(seen).toContain('# WORK ORDER');
    expect(councilStore.get(council.id)!.deliberation!.savedProblem).toBe('Original bound task');
  });
});
