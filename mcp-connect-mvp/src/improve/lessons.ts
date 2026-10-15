/**
 * Self-Improvement: Lessons
 *
 * Lessons are short, durable operating notes distilled from past runs
 * ("the manager keeps rejecting outputs that lack a test plan — always include
 * one"). They are NOT recipe edits: they ride into every persona's prompt at
 * call time via `OrchestratorConfig.lessons`, so they also work for bound
 * councils (whose records must not be mutated per run).
 *
 * Persistence: the improve store (authoritative) + `<wd>/.kondi/memory/
 * <pipelineId>_patterns.json` — a SUPERSET of the pre-existing `{patterns}`
 * shape that `{{memory.patterns}}` already reads.
 */

import type { PlatformAdapter } from '../pipeline/executor';
import { getPatternsFilePath } from '../pipeline/memory-store';
import type { Lesson, LessonBundle, ImproveState, SeatRole } from './types';

export interface PatternsFile {
  patterns: string[];
  lessons: Lesson[];
  updatedAt: string;
}

/** Write the superset `_patterns.json` (keeps `{{memory.patterns}}` working). */
export async function writePatterns(
  platform: PlatformAdapter,
  workingDir: string,
  pipelineId: string,
  lessons: Lesson[],
): Promise<string> {
  const path = getPatternsFilePath(workingDir, pipelineId);
  const active = lessons.filter((l) => l.active);
  const file: PatternsFile = {
    patterns: active.map((l) => (l.scope === 'all' ? l.text : `[${l.scope}] ${l.text}`)),
    lessons,
    updatedAt: new Date().toISOString(),
  };
  await platform.writeFile(path, JSON.stringify(file, null, 2));
  return path;
}

/**
 * Select the lessons relevant to one step and group them by role. Global
 * lessons (no stepId) apply to every step; step-scoped ones only to theirs.
 * Caps total characters, most-confirmed and newest first.
 */
export function buildLessonBundle(
  state: ImproveState | null | undefined,
  stepId: string | undefined,
  maxChars = 2000,
): LessonBundle | undefined {
  if (!state || !state.lessons?.length) return undefined;
  const relevant = state.lessons
    .filter((l) => l.active && (!l.stepId || l.stepId === stepId))
    .sort((a, b) => (b.confirmations - a.confirmations) || b.createdAt.localeCompare(a.createdAt));
  if (relevant.length === 0) return undefined;

  const bundle: LessonBundle = {};
  let used = 0;
  for (const l of relevant) {
    const text = l.text.trim();
    if (!text) continue;
    if (used + text.length > maxChars) break;
    (bundle[l.scope] ||= []).push(text);
    used += text.length;
  }
  return Object.keys(bundle).length ? bundle : undefined;
}

/**
 * Render the LESSONS block appended to a persona's user message. Role-scoped
 * lessons are included only for that role; 'all' lessons always.
 */
export function formatLessonsBlock(bundle: LessonBundle | undefined, role: SeatRole | string | undefined): string {
  if (!bundle) return '';
  const lines: string[] = [...(bundle.all || [])];
  if (role && role in bundle && role !== 'all') lines.push(...(bundle[role as SeatRole] || []));
  if (lines.length === 0) return '';
  return (
    `\n\nLESSONS FROM PREVIOUS RUNS (apply these; they come from reviewing how earlier runs of this exact step went):\n` +
    lines.map((l) => `- ${l}`).join('\n')
  );
}

export function newLesson(text: string, scope: Lesson['scope'], runId: string, stepId?: string, proposalId?: string): Lesson {
  return {
    id: `lesson-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    text: text.trim(),
    scope,
    stepId,
    source: { runId, proposalId },
    createdAt: new Date().toISOString(),
    confirmations: 0,
    active: true,
  };
}
