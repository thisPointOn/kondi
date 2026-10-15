import { describe, it, expect } from 'vitest';
import { buildLessonBundle, formatLessonsBlock, writePatterns, newLesson } from '../../src/improve/lessons';
import { readPatterns } from '../../src/pipeline/memory-store';
import type { ImproveState } from '../../src/improve/types';
import type { PlatformAdapter } from '../../src/pipeline/executor';
import { createCouncilFromSetup } from '../../src/council/factory';
import { DeliberationOrchestrator } from '../../src/council/deliberation-orchestrator';

const state = (lessons: ImproveState['lessons']): ImproveState => ({ version: 1, pipelineId: 'p', proposals: [], lessons, changelog: [], scorecardIds: [] });

describe('improve/lessons', () => {
  it('bundles active, relevant lessons by scope with a char cap, most-confirmed first', () => {
    const s = state([
      { ...newLesson('Global A', 'all', 'r'), confirmations: 0, createdAt: '2026-01-01' },
      { ...newLesson('Worker only', 'worker', 'r'), confirmations: 3 },
      { ...newLesson('Other step', 'all', 'r', 'step-other') },
      { ...newLesson('This step', 'manager', 'r', 'step-1') },
      { ...newLesson('Inactive', 'all', 'r'), active: false },
    ]);
    const b = buildLessonBundle(s, 'step-1')!;
    expect(b.all).toEqual(['Global A']);
    expect(b.worker).toEqual(['Worker only']);
    expect(b.manager).toEqual(['This step']);
    expect(buildLessonBundle(s, 'step-1', 12)!.worker).toEqual(['Worker only']); // cap: highest-confirmed first, then stops
    expect(buildLessonBundle(state([]), 'x')).toBeUndefined();
    expect(buildLessonBundle(null, 'x')).toBeUndefined();

    const w = formatLessonsBlock(b, 'worker');
    expect(w).toContain('LESSONS FROM PREVIOUS RUNS');
    expect(w).toContain('- Global A');
    expect(w).toContain('- Worker only');
    expect(w).not.toContain('This step');
    expect(formatLessonsBlock(b, 'consultant')).toContain('Global A');
    expect(formatLessonsBlock(b, 'consultant')).not.toContain('Worker only');
    expect(formatLessonsBlock(undefined, 'worker')).toBe('');
  });

  it('writes a superset _patterns.json that readPatterns still understands', async () => {
    const files = new Map<string, string>();
    const platform: PlatformAdapter = {
      writeFile: async (p, c) => { files.set(p, c); },
      readFile: async (p) => files.get(p) ?? null,
      setWorkingDir: () => {}, getWorkingDir: () => '/wd',
    };
    const path = await writePatterns(platform, '/wd', 'pid', [
      newLesson('Always cite sources', 'all', 'r'),
      { ...newLesson('Be terse', 'worker', 'r'), active: false },
      newLesson('Ask for a test plan', 'manager', 'r'),
    ]);
    expect(path).toBe('/wd/.kondi/memory/pid_patterns.json');
    const parsed = JSON.parse(files.get(path)!);
    expect(parsed.patterns).toEqual(['Always cite sources', '[manager] Ask for a test plan']);
    expect(parsed.lessons).toHaveLength(3);
    expect(await readPatterns(platform, '/wd', 'pid')).toBe('- Always cite sources\n- [manager] Ask for a test plan');
  });

  it('the orchestrator appends the role-scoped LESSONS block to the persona user message', async () => {
    const council = createCouncilFromSetup({
      name: 'LessonsRun',
      personas: [{ name: 'Solo', role: 'worker', model: 'm', provider: 'deepseek', toolAccess: 'none' }],
      maxRounds: 0, maxRevisions: 0, stepType: 'agent',
    });
    let seen = '';
    const orch = new DeliberationOrchestrator({
      invokeAgent: async (inv) => { seen = inv.userMessage; return { content: 'ok', tokensUsed: 1, latencyMs: 1 }; },
      lessons: { all: ['Cite sources.'], worker: ['Never narrate tool calls.'], manager: ['Demand a test plan.'] },
    });
    await orch.runFullDeliberation(council, 'Do it.');
    expect(seen).toContain('LESSONS FROM PREVIOUS RUNS');
    expect(seen).toContain('- Cite sources.');
    expect(seen).toContain('- Never narrate tool calls.');
    expect(seen).not.toContain('Demand a test plan.');
  });
});
