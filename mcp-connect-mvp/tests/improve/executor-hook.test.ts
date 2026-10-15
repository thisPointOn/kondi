import { describe, it, expect } from 'vitest';
import { PipelineExecutor } from '../../src/pipeline/executor';
import type { PlatformAdapter } from '../../src/pipeline/executor';
import { pipelineStore } from '../../src/pipeline/store';
import type { CouncilStepConfig, PipelinePersona } from '../../src/pipeline/types';
import { improveStore } from '../../src/improve/store';
import { getStepInput } from '../../src/improve/step-input';

/** In-memory platform: records every write so the test can assert on files. */
function memPlatform(workDir: string) {
  const files = new Map<string, string>();
  let wd = workDir;
  const platform: PlatformAdapter = {
    writeFile: async (p, c) => { files.set(p, c); },
    readFile: async (p) => files.get(p) ?? null,
    runCommand: async () => ({ stdout: '', stderr: '', exit_code: 0, success: true }),
    setWorkingDir: (d) => { wd = d; },
    getWorkingDir: () => wd,
  };
  return { platform, files };
}

const worker = (name: string, extra: Partial<PipelinePersona> = {}): PipelinePersona => ({
  name, role: 'worker', model: 'nvidia/nemotron-3-nano-30b-a3b', provider: 'nvidia-router',
  suppressPersona: true, traits: ['thorough'], saveOutput: false, toolAccess: 'none', ...extra,
});

function buildPipeline(name: string, workingDirectory?: string) {
  const p = pipelineStore.create({ name, initialInput: 'The seed input.', settings: { workingDirectory } });
  const updated = pipelineStore.addStage(p.id)!;
  const stage = updated.stages[updated.stages.length - 1];
  const config: CouncilStepConfig = {
    type: 'agent',
    councilSetup: { name: 'draft', personas: [worker('Drafter')], maxRounds: 1, maxRevisions: 0 },
    task: 'Write the thing.',
    inputTemplate: '{{input}}',
    outputType: 'string',
  };
  pipelineStore.addStep(p.id, stage.id, config, 'Draft');
  return p.id;
}

describe('executor post-run hook (scorecard + step input capture)', () => {
  it('records step input, sets artifact usage, saves a scorecard and writes run files', async () => {
    const pid = buildPipeline('Hooked', '/virtual/wd');
    const { platform, files } = memPlatform('/virtual/wd');
    const executor = new PipelineExecutor({
      invokeAgent: async (inv) => ({
        content: `Drafted from: ${inv.userMessage.slice(0, 20)}`,
        tokensUsed: 123, latencyMs: 7, model: 'nvidia/nemotron-3-nano-30b-a3b', provider: 'nvidia-router', inputTokens: 100, outputTokens: 23,
      }),
    }, platform);

    await executor.run(pid);

    const pipeline = pipelineStore.get(pid)!;
    expect(pipeline.status).toBe('completed');
    const step = pipeline.stages[0].steps[0];
    expect(step.status).toBe('completed');
    expect(step.artifact?.metadata?.tokensUsed).toBe(123);
    expect(step.artifact?.metadata?.models).toEqual(['nvidia/nemotron-3-nano-30b-a3b']);
    expect(step.artifact?.metadata?.model).toBe('nvidia/nemotron-3-nano-30b-a3b');
    expect(step.artifact?.metadata?.costUsd).toBe(0);

    // Step input record keyed by the step's council id.
    const councilId = step.artifact!.metadata!.councilId!;
    const rec = getStepInput(councilId)!;
    expect(rec.kind).toBe('unbound');
    expect(rec.stepType).toBe('agent');
    expect(rec.task).toBe('Write the thing.');
    expect(rec.rawProblem).toContain('Write the thing.');
    expect(rec.rawProblem).toContain('The seed input.');
    expect(rec.previousArtifactStepIds).toEqual(['__initial__']); // the stage-0 synthetic input artifact

    // Scorecard persisted in the store...
    const card = improveStore.latestScorecard(pid)!;
    expect(card).toBeTruthy();
    expect(card.status).toBe('completed');
    expect(card.runId).toBe(rec.runId);
    expect(card.runNumber).toBe(1);
    expect(card.steps).toHaveLength(1);
    expect(card.steps[0].tokens).toBe(123);
    expect(card.steps[0].seats[0].inputTokens).toBe(100);
    expect(card.steps[0].firstTryAccept).toBe(true);
    expect(card.totalTokens).toBe(123);

    // ...and on disk beside the run output, plus the JSONL mirror and manifest.
    const paths = [...files.keys()];
    const scorecardPath = paths.find((p) => p.endsWith('/_scorecard.json'))!;
    expect(scorecardPath).toMatch(/\/virtual\/wd\/kondi-runs\/hooked_run_001_.*\/_scorecard\.json$/);
    expect(JSON.parse(files.get(scorecardPath)!).runId).toBe(card.runId);
    expect(paths.some((p) => p.endsWith('/_input.md'))).toBe(true);
    expect(files.get(paths.find((p) => p.endsWith('/_input.md'))!)).toContain('Write the thing.');
    const jsonl = files.get('/virtual/wd/.kondi/memory/' + pid + '_scorecards.jsonl')!;
    expect(jsonl.trim().split('\n')).toHaveLength(1);
    const manifest = JSON.parse(files.get(paths.find((p) => p.endsWith('/_manifest.json'))!)!);
    expect(manifest.totalTokens).toBe(123);
    expect(manifest.runId).toBe(card.runId);
    expect(manifest.scorecardPath).toBe(scorecardPath);

    // A second run advances the run number even though memory is off, and
    // appends a second JSONL line.
    pipelineStore.resetExecution(pid);
    await new PipelineExecutor({
      invokeAgent: async () => ({ content: 'again', tokensUsed: 10, latencyMs: 1 }),
    }, platform).run(pid);
    expect(improveStore.listScorecards(pid)).toHaveLength(2);
    expect(improveStore.latestScorecard(pid)!.runNumber).toBe(2);
    expect(files.get('/virtual/wd/.kondi/memory/' + pid + '_scorecards.jsonl')!.trim().split('\n')).toHaveLength(2);
    expect(paths.length).toBeLessThan([...files.keys()].length);
  });

  it('still builds a scorecard when the run fails, and without a working directory', async () => {
    const pid = buildPipeline('Failing');
    const { platform, files } = memPlatform('');
    const executor = new PipelineExecutor({
      invokeAgent: async () => { throw new Error('model exploded'); },
    }, platform);

    await expect(executor.run(pid)).rejects.toThrow();
    expect(pipelineStore.get(pid)!.status).toBe('failed');
    const card = improveStore.latestScorecard(pid)!;
    expect(card).toBeTruthy();
    expect(card.status).toBe('failed');
    expect(card.steps[0].status).toBe('failed');
    expect(card.steps[0].flags).toContain('step_failed');
    // Nothing written to disk without a working directory, and no pipelines leaked.
    expect(files.size).toBe(0);
    expect(pipelineStore.getAll().filter((p) => p.name === 'Failing')).toHaveLength(1);
  });
});
