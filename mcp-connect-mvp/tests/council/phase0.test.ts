import { describe, it, expect } from 'vitest';
import { PipelineExecutor } from '../../src/pipeline/executor';
import type { PlatformAdapter } from '../../src/pipeline/executor';
import { pipelineStore } from '../../src/pipeline/store';
import { councilStore } from '../../src/council/store';
import { createCouncilFromSetup } from '../../src/council/factory';
import { CodingOrchestrator } from '../../src/council/coding-orchestrator';
import type { CouncilStepConfig, GateStepConfig, PipelinePersona } from '../../src/pipeline/types';
import type { AgentInvocation, AgentResponse } from '../../src/council/deliberation-orchestrator';
import type { Persona } from '../../src/council/types';

const M = { model: 'm', provider: 'deepseek' };
const persona = (name: string, role: PipelinePersona['role'], extra: Partial<PipelinePersona> = {}): PipelinePersona =>
  ({ name, role, ...M, suppressPersona: true, traits: ['t'], saveOutput: false, toolAccess: 'none', ...extra });

function memPlatform(wd: string) {
  const files = new Map<string, string>();
  const commands: string[] = [];
  const platform: PlatformAdapter = {
    writeFile: async (p, c) => { files.set(p, c); },
    readFile: async (p) => files.get(p) ?? null,
    runCommand: async (cmd) => {
      commands.push(cmd);
      if (cmd.startsWith('git rev-parse --show-toplevel')) return { stdout: `${wd}\n`, stderr: '', exit_code: 0, success: true };
      if (cmd.startsWith('git rev-parse HEAD')) return { stdout: 'abc123\n', stderr: '', exit_code: 0, success: true };
      if (cmd.startsWith('git status')) return { stdout: '', stderr: '', exit_code: 0, success: true };
      return { stdout: '', stderr: '', exit_code: 0, success: true };
    },
    setWorkingDir: () => {},
    getWorkingDir: () => wd,
  };
  return { platform, files, commands };
}

const DECOMP = JSON.stringify({ modules: [{ name: 'core', files: ['a.ts'], interfaces: '', dependencies: [], directive: 'build core' }], integrationNotes: '', testStrategy: 'none' });
const BLOCKED = "I'm blocked: the sandbox denies file writes, so I cannot write files or create the module. The tool names are not available in this environment. Please fix the environment and re-run.";

describe('phase 0 — honest step outcomes and fixes', () => {
  it('a coding council that ends in the failed phase FAILS the step (no fake artifact downstream)', async () => {
    const p = pipelineStore.create({ name: 'P0 failed council', initialInput: 'spec', settings: { workingDirectory: '/virt/p0' } });
    const stage = pipelineStore.addStage(p.id)!.stages[0];
    const cfg: CouncilStepConfig = {
      type: 'coding',
      councilSetup: { name: 'code', personas: [persona('Lead', 'manager'), persona('Dev', 'worker', { toolAccess: 'full' })], maxRounds: 1, maxRevisions: 0, maxReviewCycles: 0, maxDebugCycles: 0 },
      task: 'Build it', inputTemplate: '{{input}}', outputType: 'directory',
    };
    pipelineStore.addStep(p.id, stage.id, cfg, 'Implement');
    pipelineStore.addStep(p.id, pipelineStore.addStage(p.id)!.stages[1].id, { type: 'agent', councilSetup: { name: 'after', personas: [persona('Next', 'worker')], maxRounds: 1, maxRevisions: 0 }, task: 'Summarize', inputTemplate: '{{input}}', outputType: 'string' } as CouncilStepConfig, 'After');

    const { platform } = memPlatform('/virt/p0');
    let afterCalled = 0;
    const executor = new PipelineExecutor({
      invokeAgent: async (_inv: AgentInvocation, who: Persona): Promise<AgentResponse> => {
        if (who.name === 'Lead') return { content: DECOMP, tokensUsed: 10, latencyMs: 1 };
        if (who.name === 'Next') { afterCalled++; return { content: 'summary', tokensUsed: 1, latencyMs: 1 }; }
        return { content: BLOCKED, tokensUsed: 10, latencyMs: 1 };
      },
    }, platform);

    await expect(executor.run(p.id)).rejects.toThrow();
    const pipe = pipelineStore.get(p.id)!;
    const step = pipe.stages[0].steps[0];
    expect(step.status).toBe('failed');
    expect(step.artifact?.metadata?.terminalPhase).toBe('failed');
    expect(step.artifact?.content.startsWith('Step failed:')).toBe(true);
    expect(councilStore.get(step.artifact!.metadata!.councilId!)?.deliberationState?.currentPhase).toBe('failed');
    expect(pipe.status).toBe('failed');
    expect(afterCalled).toBe(0); // the downstream step never ran on "FAILED ..." text
  });

  it('abort() fails a step that is parked on a gate (waiting_approval)', async () => {
    const p = pipelineStore.create({ name: 'P0 gate abort', initialInput: 'x' });
    const stage = pipelineStore.addStage(p.id)!.stages[0];
    pipelineStore.addStep(p.id, stage.id, { type: 'gate', inputTemplate: '{{input}}', approvalPrompt: 'ok?' } as GateStepConfig, 'Gate');
    const { platform } = memPlatform('');
    const executor = new PipelineExecutor({
      invokeAgent: async () => ({ content: '', tokensUsed: 0, latencyMs: 0 }),
      onGateWaiting: () => new Promise<boolean>(() => { /* never resolves */ }),
    }, platform);
    const run = executor.run(p.id).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(pipelineStore.get(p.id)!.stages[0].steps[0].status).toBe('waiting_approval');
    executor.abort();
    expect(pipelineStore.get(p.id)!.stages[0].steps[0].status).toBe('failed');
    expect(pipelineStore.get(p.id)!.status).toBe('failed');
    void run;
  });

  it('maxRevisions: 0 means ONE worker attempt — a revise verdict completes with best effort instead of 3 extra revisions', async () => {
    const council = createCouncilFromSetup({
      name: 'P0 revisions',
      personas: [persona('Boss', 'manager'), persona('Maker', 'worker')],
      maxRounds: 0, maxRevisions: 0, stepType: 'council', outputType: 'string',
    });
    const { DeliberationOrchestrator } = await import('../../src/council/deliberation-orchestrator');
    let workerCalls = 0;
    const orch = new DeliberationOrchestrator({
      invokeAgent: async (inv, who) => {
        if (who.name === 'Maker') { workerCalls++; return { content: 'deliverable\n\n## COMPLETION SUMMARY\n**Status:** Complete', tokensUsed: 5, latencyMs: 1 }; }
        if (/WORKER OUTPUT/i.test(inv.userMessage)) return { content: '{"verdict":"revise","reasoning":"meh","feedback":"do more"}', tokensUsed: 5, latencyMs: 1 };
        return { content: 'DECISION: do it\n\nACCEPTANCE CRITERIA:\n- done', tokensUsed: 5, latencyMs: 1 };
      },
    });
    await orch.runFullDeliberation(council, 'Make a thing.');
    const c = councilStore.get(council.id)!;
    expect(workerCalls).toBe(1);
    expect(c.deliberationState?.currentPhase).toBe('completed');
    expect(c.status).toBe('resolved');
  });

  it('coding orchestrator reports verification as SKIPPED (not passed) when it cannot run commands', async () => {
    const council = createCouncilFromSetup({
      name: 'P0 skipped tests',
      personas: [persona('Lead', 'manager'), persona('Dev', 'worker', { toolAccess: 'full' })],
      stepType: 'coding', outputType: 'directory', maxDebugCycles: 1, maxReviewCycles: 0, testCommand: 'npm test',
    });
    const orch = new CodingOrchestrator({
      invokeAgent: async (_inv, who) => who.name === 'Lead'
        ? { content: DECOMP, tokensUsed: 1, latencyMs: 1 }
        : { content: 'wrote a.ts\n\n## COMPLETION SUMMARY\n**Status:** Complete\n**Files created:**\n- a.ts — core', tokensUsed: 1, latencyMs: 1 },
      // no runCommand, no working directory → cannot verify
    });
    await orch.runCodingWorkflow(council, 'Build the core module.');
    const c = councilStore.get(council.id)!;
    expect(c.deliberationState?.completionSummary || '').toMatch(/Verification NOT run/);
  });

  it('CodingOrchestratorConfig.canUseTools=false strips tools from every call', async () => {
    const council = createCouncilFromSetup({
      name: 'P0 canUseTools',
      personas: [persona('Lead', 'manager'), persona('Dev', 'worker', { toolAccess: 'full' })],
      stepType: 'coding', outputType: 'directory', maxDebugCycles: 0, maxReviewCycles: 0,
    });
    const seen: AgentInvocation[] = [];
    const orch = new CodingOrchestrator({
      canUseTools: () => false,
      invokeAgent: async (inv, who) => { seen.push(inv); return who.name === 'Lead'
        ? { content: DECOMP, tokensUsed: 1, latencyMs: 1 }
        : { content: 'done\n\n## COMPLETION SUMMARY\n**Status:** Complete', tokensUsed: 1, latencyMs: 1 }; },
    });
    await orch.runCodingWorkflow(council, 'Build.');
    expect(seen.length).toBeGreaterThan(0);
    for (const inv of seen) { expect(inv.skipTools).toBe(true); expect(inv.allowedTools).toBeUndefined(); expect(inv.timeoutMs).toBeGreaterThan(0); }
  });
});
