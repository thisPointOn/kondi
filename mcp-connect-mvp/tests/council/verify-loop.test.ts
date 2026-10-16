import { describe, it, expect } from 'vitest';
import { createCouncilFromSetup } from '../../src/council/factory';
import { councilStore } from '../../src/council/store';
import { ledgerStore } from '../../src/council/ledger-store';
import { DeliberationOrchestrator } from '../../src/council/deliberation-orchestrator';
import type { AgentInvocation } from '../../src/council/deliberation-orchestrator';
import { CodingOrchestrator } from '../../src/council/coding-orchestrator';
import type { PipelinePersona } from '../../src/pipeline/types';
import type { Persona } from '../../src/council/types';

const persona = (name: string, role: PipelinePersona['role'], extra: Partial<PipelinePersona> = {}): PipelinePersona =>
  ({ name, role, model: 'm', provider: 'deepseek', suppressPersona: true, traits: ['t'], saveOutput: false, ...extra });

/** runCommand fake that fails N times then passes; records every call. */
function flakyRunner(failures: number) {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    runCommand: async (cmd: string) => {
      calls.push(cmd);
      n++;
      return n <= failures
        ? { stdout: '', stderr: `FAIL: expected 2 to be 3 (run ${n})`, exit_code: 1, success: false }
        : { stdout: '3 passing', stderr: '', exit_code: 0, success: true };
    },
  };
}

describe('worker-owned verify loop (deliberation)', () => {
  it('a failing final check sends the work back WITHOUT a manager review call, with the test tail as feedback; a passing one reaches the manager', async () => {
    const council = createCouncilFromSetup({
      name: 'Verify', workingDirectory: '/virt/proj', testCommand: 'npm test',
      personas: [persona('Boss', 'manager'), persona('Dev', 'worker', { toolAccess: 'full' })],
      maxRounds: 0, maxRevisions: 2, stepType: 'council', outputType: 'file',
    });
    const runner = flakyRunner(1);
    const seen: Array<{ who: string; msg: string }> = [];
    let managerReviews = 0;
    const orch = new DeliberationOrchestrator({
      runCommand: runner.runCommand,
      invokeAgent: async (inv: AgentInvocation, who: Persona) => {
        seen.push({ who: who.name, msg: inv.userMessage });
        if (who.name === 'Dev') return { content: 'wrote files\n\n## COMPLETION SUMMARY\n**Status:** Complete\n**Verification:** exit 0', tokensUsed: 5, latencyMs: 1 };
        if (/WORKER OUTPUT/.test(inv.userMessage)) { managerReviews++; return { content: '{"verdict":"accept","reasoning":"fine"}', tokensUsed: 5, latencyMs: 1 }; }
        return { content: 'DECISION: build it\n\nACCEPTANCE CRITERIA:\n- tests pass', tokensUsed: 5, latencyMs: 1 };
      },
    });
    await orch.runFullDeliberation(council, 'Build the thing.');

    const entries = ledgerStore.getAll(council.id);
    const tests = entries.filter((e) => e.entryType === 'test_result');
    expect(tests).toHaveLength(2);
    expect((tests[0].structured as { exitCode: number }).exitCode).toBe(1);
    expect((tests[1].structured as { exitCode: number }).exitCode).toBe(0);
    const reviews = entries.filter((e) => e.entryType === 'review');
    expect(reviews).toHaveLength(2);
    expect(reviews[0].reviewOutcome).toBe('revise');
    expect(reviews[0].tokensUsed).toBe(0);                      // mechanical, no LLM
    expect((reviews[0].structured as { automatic: boolean }).automatic).toBe(true);
    const revReq = entries.find((e) => e.entryType === 'revision_request')!;
    expect(revReq.content).toMatch(/FAILED \(exit code 1\)/);
    expect(revReq.content).toMatch(/expected 2 to be 3/);
    expect(managerReviews).toBe(1);                              // only the passing round reached the manager
    const managerReview = seen.find((s) => s.who === 'Boss' && /WORKER OUTPUT/.test(s.msg))!;
    expect(managerReview.msg).toMatch(/VERIFICATION \(run by the orchestrator/);
    expect(managerReview.msg).toMatch(/PASSED/);
    // The worker was told to run the command itself, in both attempts; the fix attempt carried the tail.
    const devPrompts = seen.filter((s) => s.who === 'Dev').map((s) => s.msg);
    expect(devPrompts).toHaveLength(2);
    expect(devPrompts[0]).toMatch(/Run `npm test`/);
    expect(devPrompts[1]).toMatch(/\(fix\)/);
    expect(devPrompts[1]).toMatch(/expected 2 to be 3/);
    expect(runner.calls).toEqual(['npm test', 'npm test']);
    expect(councilStore.get(council.id)!.deliberationState?.currentPhase).toBe('completed');
    expect(councilStore.get(council.id)!.deliberationState?.revisionCount).toBe(1);
  });

  it('maxRevisions: 0 + failing verification → one attempt, completes with best effort, no loop', async () => {
    const council = createCouncilFromSetup({
      name: 'Verify0', workingDirectory: '/virt/proj', testCommand: 'make check',
      personas: [persona('Boss', 'manager'), persona('Dev', 'worker', { toolAccess: 'full' })],
      maxRounds: 0, maxRevisions: 0, stepType: 'council', outputType: 'directory',
    });
    const runner = flakyRunner(99);
    let devCalls = 0;
    const orch = new DeliberationOrchestrator({
      runCommand: runner.runCommand,
      invokeAgent: async (inv, who) => {
        if (who.name === 'Dev') { devCalls++; return { content: 'x\n\n## COMPLETION SUMMARY\n**Status:** Complete', tokensUsed: 1, latencyMs: 1 }; }
        if (/WORKER OUTPUT/.test(inv.userMessage)) return { content: '{"verdict":"accept"}', tokensUsed: 1, latencyMs: 1 };
        return { content: 'DECISION: go', tokensUsed: 1, latencyMs: 1 };
      },
    });
    await orch.runFullDeliberation(council, 'Do it.');
    expect(devCalls).toBe(1);
    expect(runner.calls).toHaveLength(1);
    expect(councilStore.get(council.id)!.deliberationState?.currentPhase).toBe('completed');
  });

  it('text-deliverable workers get no verify command (rule 5), even when a test command is configured', async () => {
    const council = createCouncilFromSetup({
      name: 'VerifyText', workingDirectory: '/virt/proj', testCommand: 'npm test',
      personas: [persona('Boss', 'manager'), persona('Writer', 'worker')],
      maxRounds: 0, maxRevisions: 1, stepType: 'council', outputType: 'string',
    });
    const runner = flakyRunner(99);
    let writerPrompt = '';
    const orch = new DeliberationOrchestrator({
      runCommand: runner.runCommand,
      invokeAgent: async (inv, who) => {
        if (who.name === 'Writer') { writerPrompt = inv.userMessage; return { content: 'prose\n\n## COMPLETION SUMMARY\n**Status:** Complete', tokensUsed: 1, latencyMs: 1 }; }
        if (/WORKER OUTPUT/.test(inv.userMessage)) return { content: '{"verdict":"accept"}', tokensUsed: 1, latencyMs: 1 };
        return { content: 'DECISION: write', tokensUsed: 1, latencyMs: 1 };
      },
    });
    await orch.runFullDeliberation(council, 'Write.');
    expect(writerPrompt).not.toMatch(/npm test/);
    expect(runner.calls).toHaveLength(0);
  });

  it('manager-less direct execution verifies and gives bounded fix attempts', async () => {
    const council = createCouncilFromSetup({
      name: 'VerifyDirect', workingDirectory: '/virt/proj', testCommand: 'pytest',
      personas: [persona('Solo', 'worker', { toolAccess: 'full' })],
      maxRounds: 0, maxRevisions: 1, stepType: 'agent', outputType: 'file',
    });
    const runner = flakyRunner(1);
    const prompts: string[] = [];
    const orch = new DeliberationOrchestrator({
      runCommand: runner.runCommand,
      invokeAgent: async (inv) => { prompts.push(inv.userMessage); return { content: 'did it\n\n## COMPLETION SUMMARY\n**Status:** Complete', tokensUsed: 1, latencyMs: 1 }; },
    });
    await orch.runFullDeliberation(council, 'Make tests pass.');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/\(fix\)/);
    expect(prompts[1]).toMatch(/pytest/);
    expect(runner.calls).toEqual(['pytest', 'pytest']);
    expect(ledgerStore.getAll(council.id).filter((e) => e.entryType === 'test_result')).toHaveLength(2);
  });
});

describe('worker-owned verify loop (coding)', () => {
  it('module workers are told the verify command before implementing; the final test loop reuses it', async () => {
    const council = createCouncilFromSetup({
      name: 'CodingVerify', workingDirectory: '/virt/proj', testCommand: 'npm test',
      personas: [persona('Lead', 'manager'), persona('Dev', 'worker', { toolAccess: 'full' })],
      stepType: 'coding', outputType: 'directory', maxDebugCycles: 1, maxReviewCycles: 0,
    });
    const runner = flakyRunner(0);
    const prompts: Record<string, string[]> = {};
    const orch = new CodingOrchestrator({
      runCommand: runner.runCommand,
      invokeAgent: async (inv, who) => {
        (prompts[who.name] ||= []).push(inv.userMessage);
        return who.name === 'Lead'
          ? { content: JSON.stringify({ modules: [{ name: 'core', files: ['a.ts'], interfaces: '', dependencies: [], directive: 'build core' }], integrationNotes: '', testStrategy: 'unit tests in a.test.ts' }), tokensUsed: 1, latencyMs: 1 }
          : { content: 'done\n\n## COMPLETION SUMMARY\n**Status:** Complete\n**Verification:** exit 0', tokensUsed: 1, latencyMs: 1 };
      },
    });
    await orch.runCodingWorkflow(council, 'Build the core module.');
    const dev = prompts.Dev[0];
    expect(dev).toMatch(/## VERIFICATION/);
    expect(dev).toMatch(/Test strategy: unit tests in a.test.ts/);
    expect(dev).toMatch(/RUN `npm test`/);
    expect(dev).toMatch(/## ORIGINAL SPECIFICATION/);
    expect(dev).toMatch(/Build the core module/);
    expect(runner.calls.some((c) => c.includes('npm test'))).toBe(true);
  });
});
