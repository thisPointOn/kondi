import { describe, it, expect } from 'vitest';
import { createCouncilFromSetup } from '../../src/council/factory';
import { DeliberationOrchestrator } from '../../src/council/deliberation-orchestrator';
import type { AgentInvocation, AgentResponse } from '../../src/council/deliberation-orchestrator';
import { CodingOrchestrator } from '../../src/council/coding-orchestrator';
import { ledgerStore } from '../../src/council/ledger-store';
import type { Persona } from '../../src/council/types';

describe('ledger per-call metadata (callMeta → LedgerEntry fields)', () => {
  it('records concrete model, token split, attempts after a timeout retry (deliberation path)', async () => {
    const council = createCouncilFromSetup({
      name: 'MetaTest',
      personas: [{ name: 'Solo', role: 'worker', model: 'route:balanced', provider: 'router', toolAccess: 'none' }],
      maxRounds: 0, maxRevisions: 0, stepType: 'agent', outputType: 'string',
    });

    let calls = 0;
    const invokeAgent = async (_inv: AgentInvocation, _p: Persona): Promise<AgentResponse> => {
      calls++;
      if (calls === 1) throw new Error('LLM call timed out after 1s');
      return {
        content: 'Deliverable text\n\n## COMPLETION SUMMARY\nDone.',
        tokensUsed: 150, latencyMs: 42,
        model: 'concrete-model-x', provider: 'nvidia-router', inputTokens: 100, outputTokens: 50,
      };
    };

    const orch = new DeliberationOrchestrator({ invokeAgent });
    await orch.runFullDeliberation(council, 'Write one sentence.');

    expect(calls).toBe(2);
    const entries = ledgerStore.getAll(council.id);
    const out = entries.find((e) => e.entryType === 'work_output')!;
    expect(out).toBeTruthy();
    expect(out.model).toBe('concrete-model-x');
    expect(out.provider).toBe('nvidia-router');
    expect(out.inputTokens).toBe(100);
    expect(out.outputTokens).toBe(50);
    expect(out.attempts).toBe(2);
    expect(out.routed).toBe(true);
    expect(out.tokensUsed).toBe(150);
    // The raw callMeta is still available under structured for anything that wants it.
    expect((out.structured as any)?.callMeta?.attempts).toBe(2);
    // Bookkeeping entries (0/0) carry no call metadata.
    const directive = entries.find((e) => e.entryType === 'work_directive')!;
    expect(directive.model).toBeUndefined();
  });

  it('falls back to the persona model/provider when the invoker reports none', async () => {
    const council = createCouncilFromSetup({
      name: 'MetaTest2',
      personas: [{ name: 'Solo', role: 'worker', model: 'deepseek-v4-pro', provider: 'deepseek', toolAccess: 'none' }],
      maxRounds: 0, maxRevisions: 0, stepType: 'agent',
    });
    const orch = new DeliberationOrchestrator({
      invokeAgent: async () => ({ content: 'ok', tokensUsed: 10, latencyMs: 5 }),
    });
    await orch.runFullDeliberation(council, 'Say ok.');
    const out = ledgerStore.getAll(council.id).find((e) => e.entryType === 'work_output')!;
    expect(out.model).toBe('deepseek-v4-pro');
    expect(out.provider).toBe('deepseek');
    expect(out.attempts).toBe(1);
    expect(out.routed).toBe(false);
    expect(out.inputTokens).toBeUndefined();
  });

  it('coding orchestrator entries carry callMeta too (decomposition)', async () => {
    const council = createCouncilFromSetup({
      name: 'CodingMeta',
      personas: [
        { name: 'Lead', role: 'manager', model: 'route:nvidia', provider: 'router' },
        { name: 'Dev', role: 'worker', model: 'z-ai/glm-5.2', provider: 'nvidia-router' },
      ],
      stepType: 'coding', outputType: 'directory', maxDebugCycles: 0, maxReviewCycles: 0,
    });
    const orch = new CodingOrchestrator({
      invokeAgent: async (_inv, persona) => {
        if (persona.name === 'Lead') {
          return {
            content: JSON.stringify({ modules: [{ name: 'core', files: ['a.ts'], interfaces: '', dependencies: [], directive: 'build core' }], integrationNotes: '', testStrategy: 'none' }),
            tokensUsed: 90, latencyMs: 10, model: 'nvidia/nemotron-3-ultra-550b-a55b', provider: 'nvidia-router', inputTokens: 60, outputTokens: 30,
          };
        }
        return { content: 'implemented core\n\n## COMPLETION SUMMARY\nok', tokensUsed: 40, latencyMs: 10 };
      },
      runCommand: async () => ({ stdout: '', stderr: '', exit_code: 0, success: true }),
    });
    try {
      await orch.runCodingWorkflow(council, 'Build a tiny module.');
    } catch {
      // The git snapshot / test phases may throw in this bare environment; the
      // decomposition entry is written before any of that.
    }
    const decomposition = ledgerStore.getAll(council.id).find((e) => e.entryType === 'decomposition');
    expect(decomposition).toBeTruthy();
    expect(decomposition!.model).toBe('nvidia/nemotron-3-ultra-550b-a55b');
    expect(decomposition!.inputTokens).toBe(60);
    expect(decomposition!.routed).toBe(true);
    expect(decomposition!.attempts).toBe(1);
  });
});
