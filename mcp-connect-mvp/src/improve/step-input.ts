/**
 * Self-Improvement: Step Input Records
 *
 * Captures EXACTLY what a council step received (task + rendered input) so the
 * step can later be replayed in isolation with a proposed recipe change.
 * Keyed by council id (the artifact already carries `metadata.councilId`).
 *
 * Stored through councilDataStore (in-memory primary, disk mirror, localStorage
 * best-effort) — same pattern as context-store.ts — so it never bloats the
 * `mcp-pipelines` blob and survives restarts.
 */

import { councilDataStore } from '../council/storage-cleanup';
import type { StepInputRecord } from './types';

export const STEP_INPUT_PREFIX = 'step-input-';

export function stepInputKey(councilId: string): string {
  return `${STEP_INPUT_PREFIX}${councilId}`;
}

export function saveStepInput(record: StepInputRecord): void {
  try {
    councilDataStore.setItem(stepInputKey(record.councilId), JSON.stringify(record));
  } catch (err) {
    console.warn('[Improve] Failed to save step input record:', err);
  }
}

export function getStepInput(councilId: string): StepInputRecord | null {
  try {
    const raw = councilDataStore.getItem(stepInputKey(councilId));
    return raw ? (JSON.parse(raw) as StepInputRecord) : null;
  } catch {
    return null;
  }
}

export function deleteStepInput(councilId: string): void {
  try {
    councilDataStore.removeItem(stepInputKey(councilId));
  } catch { /* best effort */ }
}

/** Human-readable `_input.md` body written beside a step's `output.md`. */
export function formatStepInputMarkdown(record: StepInputRecord): string {
  const lines: string[] = [
    `# Step input — ${record.stepType} (${record.kind})`,
    '',
    `- pipeline: ${record.pipelineId}`,
    `- step: ${record.stepId}`,
    `- council: ${record.councilId}`,
    `- run: ${record.runId}`,
    `- output type: ${record.outputType}`,
    `- input template: \`${record.inputTemplate || '{{input}}'}\``,
    `- recorded: ${record.recordedAt}`,
    '',
  ];
  if (record.task) lines.push('## Task', '', record.task, '');
  if (record.pipelineInput) lines.push('## Pipeline input', '', record.pipelineInput, '');
  if (record.inputContext) lines.push('## Rendered input (previous steps)', '', record.inputContext, '');
  lines.push('## Raw problem (as sent to the orchestrator)', '', record.rawProblem, '');
  return lines.join('\n');
}
