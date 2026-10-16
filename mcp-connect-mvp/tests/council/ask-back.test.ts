import { describe, it, expect } from 'vitest';
import { createCouncilFromSetup } from '../../src/council/factory';
import { councilStore } from '../../src/council/store';
import { ledgerStore } from '../../src/council/ledger-store';
import { DeliberationOrchestrator } from '../../src/council/deliberation-orchestrator';
import { CodingOrchestrator } from '../../src/council/coding-orchestrator';
import { parseManagerAnswer, resolveWorkerQuestion, AUTO_ANSWER } from '../../src/council/ask-back';
import type { PipelinePersona } from '../../src/pipeline/types';

const persona = (name: string, role: PipelinePersona['role'], extra: Partial<PipelinePersona> = {}): PipelinePersona =>
  ({ name, role, model: 'm', provider: 'deepseek', suppressPersona: true, traits: ['t'], saveOutput: false, ...extra });

const QUESTION = (q: string) => `## NEEDS INPUT\n**Question:** ${q}\n`;
const DONE = (body: string) => `${body}\n\n## COMPLETION SUMMARY\n**Status:** Complete`;
const BLOCKED = (why: string) => `I tried.\n\n## COMPLETION SUMMARY\n**Status:** Blocked — ${why}`;

describe('ask-back helpers', () => {
  it('parses manager JSON (answer / escalate / plain text)', () => {
    expect(parseManagerAnswer('{"action":"answer","answer":"Use Postgres","why":"spec"}')).toEqual({ action: 'answer', answer: 'Use Postgres', why: 'spec' });
    expect(parseManagerAnswer('```json\n{"action":"escalate","why":"needs a credential"}\n```')).toEqual({ action: 'escalate', answer: undefined, why: 'needs a credential' });
    expect(parseManagerAnswer('Just use SQLite.')).toEqual({ action: 'answer', answer: 'Just use SQLite.' });
    expect(parseManagerAnswer('{"action":"answer"}').action).toBe('escalate');
  });

  it('ladder: manager → human → auto', async () => {
    const ctx = { councilId: 'c', personaId: 'p', personaName: 'Dev', question: 'q?', phase: 'execution' };
    expect(await resolveWorkerQuestion({ ctx, askManager: async () => '{"action":"answer","answer":"A"}', onWorkerQuestion: async () => 'H' }))
      .toMatchObject({ answer: 'A', answeredBy: 'manager' });
    expect(await resolveWorkerQuestion({ ctx, askManager: async () => '{"action":"escalate","why":"no idea"}', onWorkerQuestion: async () => 'H' }))
      .toMatchObject({ answer: 'H', answeredBy: 'user', managerNote: 'no idea' });
    const auto = await resolveWorkerQuestion({ ctx, askManager: async () => { throw new Error('boom'); }, onWorkerQuestion: async () => null });
    expect(auto.answeredBy).toBe('system');
    expect(auto.answer).toContain(AUTO_ANSWER);
    expect(auto.answer).toContain('boom');
    expect((await resolveWorkerQuestion({ ctx })).answeredBy).toBe('system');
  });
});

describe('ask-back in the deliberation orchestrator', () => {
  it('manager answers; the worker is re-invoked on the same attempt with the Q&A; ledger holds question + answer', async () => {
    const council = createCouncilFromSetup({
      name: 'Ask', personas: [persona('Boss', 'manager'), persona('Dev', 'worker')],
      maxRounds: 0, maxRevisions: 1, stepType: 'council', outputType: 'string',
    });
    const devPrompts: string[] = [];
    let humanAsked = 0;
    const orch = new DeliberationOrchestrator({
      onWorkerQuestion: async () => { humanAsked++; return 'human'; },
      invokeAgent: async (inv, who) => {
        if (who.name === 'Dev') {
          devPrompts.push(inv.userMessage);
          return { content: devPrompts.length === 1 ? QUESTION('Which database should I target?') : DONE('Targeting Postgres.'), tokensUsed: 3, latencyMs: 1 };
        }
        if (/WORKER'S QUESTION/.test(inv.userMessage)) return { content: '{"action":"answer","answer":"Postgres 16.","why":"it is in the spec"}', tokensUsed: 2, latencyMs: 1 };
        if (/WORKER OUTPUT/.test(inv.userMessage)) return { content: '{"verdict":"accept"}', tokensUsed: 1, latencyMs: 1 };
        return { content: 'DECISION: build it', tokensUsed: 1, latencyMs: 1 };
      },
    });
    await orch.runFullDeliberation(council, 'Build a service.');

    expect(devPrompts).toHaveLength(2);
    expect(devPrompts[0]).not.toMatch(/Answers to your questions/);
    expect(devPrompts[1]).toMatch(/Attempt 1 of 2 \(answer\)/);
    expect(devPrompts[1]).toMatch(/Q: Which database should I target\?/);
    expect(devPrompts[1]).toMatch(/A \(manager\): Postgres 16\./);
    expect(humanAsked).toBe(0);
    const entries = ledgerStore.getAll(council.id);
    const q = entries.find((e) => e.entryType === 'manager_question')!;
    expect(q.authorRole).toBe('worker');
    expect(q.content).toMatch(/Which database/);
    const a = entries.find((e) => e.entryType === 'response')!;
    expect(a.authorRole).toBe('manager');
    expect((a.structured as { answeredBy: string }).answeredBy).toBe('manager');
    // The single work_output is the delivered one, and the deliberation completed with 0 revisions.
    const outs = entries.filter((e) => e.entryType === 'work_output');
    expect(outs).toHaveLength(1);
    expect(outs[0].content).toMatch(/Targeting Postgres/);
    expect(councilStore.get(council.id)!.deliberationState?.currentPhase).toBe('completed');
    expect(councilStore.get(council.id)!.deliberationState?.revisionCount).toBe(0);
  });

  it('manager escalates → human answers; human says nothing → auto answer; the 3rd question gets the budget answer and no manager call', async () => {
    const council = createCouncilFromSetup({
      name: 'AskEsc', personas: [persona('Boss', 'manager'), persona('Dev', 'worker')],
      maxRounds: 0, maxRevisions: 0, stepType: 'council', outputType: 'string',
    });
    const devPrompts: string[] = [];
    const humanQs: string[] = [];
    let managerAnswerCalls = 0;
    const orch = new DeliberationOrchestrator({
      onWorkerQuestion: async (ctx) => { humanQs.push(ctx.question); return humanQs.length === 1 ? 'Deploy to eu-west-1.' : null; },
      invokeAgent: async (inv, who) => {
        if (who.name === 'Dev') {
          devPrompts.push(inv.userMessage);
          const n = devPrompts.length;
          if (n === 1) return { content: QUESTION('Which region?'), tokensUsed: 1, latencyMs: 1 };
          if (n === 2) return { content: QUESTION('Which instance size?'), tokensUsed: 1, latencyMs: 1 };
          if (n === 3) return { content: QUESTION('Blue or green?'), tokensUsed: 1, latencyMs: 1 };
          return { content: DONE('Deployed.'), tokensUsed: 1, latencyMs: 1 };
        }
        if (/WORKER'S QUESTION/.test(inv.userMessage)) { managerAnswerCalls++; return { content: '{"action":"escalate","why":"customer preference"}', tokensUsed: 1, latencyMs: 1 }; }
        if (/WORKER OUTPUT/.test(inv.userMessage)) return { content: '{"verdict":"accept"}', tokensUsed: 1, latencyMs: 1 };
        return { content: 'DECISION: deploy', tokensUsed: 1, latencyMs: 1 };
      },
    });
    await orch.runFullDeliberation(council, 'Deploy.');

    expect(devPrompts).toHaveLength(4);
    expect(managerAnswerCalls).toBe(2);               // 3rd question: budget exhausted, manager NOT asked
    expect(humanQs).toEqual(['Which region?', 'Which instance size?']);
    expect(devPrompts[1]).toMatch(/A \(user\): Deploy to eu-west-1\./);
    expect(devPrompts[2]).toMatch(/A \(system\): No one is available/);
    expect(devPrompts[2]).toMatch(/customer preference/);           // manager's note travels with the auto answer
    expect(devPrompts[3]).toMatch(/A \(system\): Question budget exhausted/);
    const answers = ledgerStore.getAll(council.id).filter((e) => e.entryType === 'response').map((e) => (e.structured as { answeredBy: string }).answeredBy);
    expect(answers).toEqual(['user', 'system', 'system']);
    expect(councilStore.get(council.id)!.deliberationState?.currentPhase).toBe('completed');
  });

  it('a question that comes WITH a delivery is a caveat, not a stop', async () => {
    const council = createCouncilFromSetup({
      name: 'AskCaveat', personas: [persona('Boss', 'manager'), persona('Dev', 'worker')],
      maxRounds: 0, maxRevisions: 0, stepType: 'council', outputType: 'string',
    });
    let devCalls = 0;
    const orch = new DeliberationOrchestrator({
      invokeAgent: async (inv, who) => {
        if (who.name === 'Dev') { devCalls++; return { content: `${QUESTION('Should I also add tests?')}\nDid the work.\n\n## COMPLETION SUMMARY\n**Status:** Complete`, tokensUsed: 1, latencyMs: 1 }; }
        if (/WORKER OUTPUT/.test(inv.userMessage)) return { content: '{"verdict":"accept"}', tokensUsed: 1, latencyMs: 1 };
        return { content: 'DECISION: go', tokensUsed: 1, latencyMs: 1 };
      },
    });
    await orch.runFullDeliberation(council, 'Do.');
    expect(devCalls).toBe(1);
    expect(ledgerStore.getAll(council.id).some((e) => e.entryType === 'manager_question')).toBe(false);
  });

  it('blocked worker → manager re-deliberates once (no quality review call); blocked again → best-effort revise; still blocked → council FAILS', async () => {
    const council = createCouncilFromSetup({
      name: 'Blocked', personas: [persona('Boss', 'manager'), persona('Dev', 'worker')],
      maxRounds: 0, maxRevisions: 1, stepType: 'council', outputType: 'string',
    });
    let reviewCalls = 0; let devCalls = 0; const devPrompts: string[] = [];
    const orch = new DeliberationOrchestrator({
      invokeAgent: async (inv, who) => {
        if (who.name === 'Dev') { devCalls++; devPrompts.push(inv.userMessage); return { content: BLOCKED('the API needs a key I do not have'), tokensUsed: 1, latencyMs: 1 }; }
        if (/WORKER OUTPUT/.test(inv.userMessage)) { reviewCalls++; return { content: '{"verdict":"accept"}', tokensUsed: 1, latencyMs: 1 }; }
        return { content: 'DECISION: call the API', tokensUsed: 1, latencyMs: 1 };
      },
    });
    await expect(orch.runFullDeliberation(council, 'Fetch data.')).rejects.toThrow(/blocked/i);

    expect(reviewCalls).toBe(0);                                   // never reviewed on quality
    expect(devCalls).toBe(3);                                      // execute → (re-delib) execute → best-effort revise
    const entries = ledgerStore.getAll(council.id);
    expect(entries.filter((e) => e.entryType === 're_deliberation')).toHaveLength(1);
    expect(entries.find((e) => e.entryType === 're_deliberation')!.content).toMatch(/API needs a key/);
    const reviews = entries.filter((e) => e.entryType === 'review');
    expect(reviews.map((r) => r.reviewOutcome)).toEqual(['re_deliberate', 'revise']);
    expect(reviews.every((r) => (r.structured as { automatic: boolean }).automatic)).toBe(true);
    expect(entries.find((e) => e.entryType === 'revision_request')!.content).toMatch(/BEST EFFORT/);
    expect(devPrompts[2]).toMatch(/\(revise\)/);
    expect(entries.some((e) => e.entryType === 'error' && /still BLOCKED/.test(e.content))).toBe(true);
    expect(councilStore.get(council.id)!.deliberationState?.currentPhase).toBe('failed');
    expect(councilStore.get(council.id)!.deliberationState?.reDeliberationCount).toBe(1);
  });

  it('manager-less direct execution: blocked → failed council (thrown), question → human hook', async () => {
    const council = createCouncilFromSetup({
      name: 'DirectBlocked', personas: [persona('Solo', 'worker')],
      maxRounds: 0, maxRevisions: 0, stepType: 'agent', outputType: 'string',
    });
    const humanQs: string[] = [];
    let calls = 0;
    const orch = new DeliberationOrchestrator({
      onWorkerQuestion: async (ctx) => { humanQs.push(ctx.question); return 'Use the staging bucket.'; },
      invokeAgent: async () => { calls++; return { content: calls === 1 ? QUESTION('Which bucket?') : BLOCKED('no credentials for the bucket'), tokensUsed: 1, latencyMs: 1 }; },
    });
    await expect(orch.runFullDeliberation(council, 'Upload.')).rejects.toThrow(/blocked/i);
    expect(humanQs).toEqual(['Which bucket?']);
    expect(calls).toBe(2);
    expect(councilStore.get(council.id)!.deliberationState?.currentPhase).toBe('failed');
    expect(ledgerStore.getAll(council.id).some((e) => e.entryType === 'error' && /no manager/.test(e.content))).toBe(true);
  });
});

describe('ask-back in the coding orchestrator', () => {
  it('a module worker question is answered by the manager and the worker continues with the answer appended', async () => {
    const council = createCouncilFromSetup({
      name: 'CodingAsk', workingDirectory: '/virt/proj',
      personas: [persona('Lead', 'manager'), persona('Dev', 'worker', { toolAccess: 'full' })],
      stepType: 'coding', outputType: 'directory', maxDebugCycles: 0, maxReviewCycles: 0,
    });
    const devPrompts: string[] = [];
    const orch = new CodingOrchestrator({
      runCommand: async () => ({ stdout: 'ok', stderr: '', exit_code: 0, success: true }),
      invokeAgent: async (inv, who) => {
        if (who.name === 'Dev') {
          devPrompts.push(inv.userMessage);
          return { content: devPrompts.length === 1 ? QUESTION('ESM or CommonJS?') : DONE('Wrote a.ts as ESM.'), tokensUsed: 1, latencyMs: 1 };
        }
        if (/WORKER'S QUESTION/.test(inv.userMessage)) return { content: '{"action":"answer","answer":"ESM.","why":"package.json type module"}', tokensUsed: 1, latencyMs: 1 };
        return { content: JSON.stringify({ modules: [{ name: 'core', files: ['a.ts'], interfaces: '', dependencies: [], directive: 'build core' }], integrationNotes: '', testStrategy: '' }), tokensUsed: 1, latencyMs: 1 };
      },
    });
    await orch.runCodingWorkflow(council, 'Build the core module.');
    expect(devPrompts).toHaveLength(2);
    expect(devPrompts[1]).toMatch(/## ANSWERS TO YOUR QUESTIONS/);
    expect(devPrompts[1]).toMatch(/A \(manager\): ESM\./);
    const entries = ledgerStore.getAll(council.id);
    expect(entries.find((e) => e.entryType === 'manager_question')!.authorRole).toBe('worker');
    expect(entries.find((e) => e.entryType === 'response')!.phase).toBe('implementing');
    expect(councilStore.get(council.id)!.deliberationState?.currentPhase).toBe('completed');
  });
});

describe('executor ask-back plumbing', () => {
  it('parks the step in waiting_approval with a question pendingInput while the human answers, then resumes and completes', async () => {
    const { PipelineExecutor } = await import('../../src/pipeline/executor');
    const { pipelineStore } = await import('../../src/pipeline/store');
    const p = pipelineStore.create({ name: 'Ask-back step', initialInput: 'spec', settings: { workingDirectory: '/virt/ask' } });
    const stage = pipelineStore.addStage(p.id)!.stages[0];
    pipelineStore.addStep(p.id, stage.id, {
      type: 'council', task: 'Do the thing.', inputTemplate: '{{input}}', outputType: 'string',
      councilSetup: { name: 'ask', personas: [persona('Boss', 'manager'), persona('Dev', 'worker')], maxRounds: 0, maxRevisions: 0 },
    } as import('../../src/pipeline/types').CouncilStepConfig, 'Ask step');

    const seen: Array<{ status: string; pendingKind?: string }> = [];
    let devCalls = 0;
    const executor = new PipelineExecutor({
      invokeAgent: async (inv, who) => {
        if (who.name === 'Dev') { devCalls++; return { content: devCalls === 1 ? QUESTION('Which locale?') : DONE('Done in en-GB.'), tokensUsed: 1, latencyMs: 1 }; }
        if (/WORKER'S QUESTION/.test(inv.userMessage)) return { content: '{"action":"escalate","why":"client preference"}', tokensUsed: 1, latencyMs: 1 };
        if (/WORKER OUTPUT/.test(inv.userMessage)) return { content: '{"verdict":"accept"}', tokensUsed: 1, latencyMs: 1 };
        return { content: 'DECISION: go', tokensUsed: 1, latencyMs: 1 };
      },
      onCouncilQuestion: async (stepId, input) => {
        const step = pipelineStore.get(p.id)!.stages[0].steps[0];
        seen.push({ status: step.status, pendingKind: step.pendingInput?.kind });
        expect(stepId).toBe(step.id);
        expect(input).toMatchObject({ kind: 'question', prompt: 'Which locale?', personaName: 'Dev', managerNote: 'client preference' });
        return 'en-GB';
      },
    }, {
      writeFile: async () => {}, readFile: async () => null,
      runCommand: async () => ({ stdout: '', stderr: '', exit_code: 0, success: true }),
      setWorkingDir: () => {}, getWorkingDir: () => '/virt/ask',
    });
    await executor.run(p.id);

    expect(seen).toEqual([{ status: 'waiting_approval', pendingKind: 'question' }]);
    const step = pipelineStore.get(p.id)!.stages[0].steps[0];
    expect(step.status).toBe('completed');
    expect(step.pendingInput).toBeUndefined();
    expect(step.artifact?.content).toMatch(/en-GB/);
  });
});
