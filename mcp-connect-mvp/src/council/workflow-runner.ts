/**
 * Workflow runner — sequential execution of a multi-step council workflow.
 *
 * A workflow is a series of councils sharing a workflowId (see store.ts
 * appendCouncilToWorkflow). Running step K runs K, K+1, … N in order; each
 * step's problem is composed from its own saved Task plus the PREVIOUS step's
 * output, rendered through the step's inputTemplate contract ({{input}},
 * {{input[N]}}, {{input.field}}). Every step in the range is cleared before it
 * runs, so editing a step and rerunning invalidates everything forward of it.
 *
 * The runner owns sequencing only — the actual deliberation happens through the
 * injected frameProblem callback (useCouncilHandlers.onFrameProblem), so model
 * validation, tool preflight, and orchestrator choice stay in one place.
 */
import type { Council } from './types';
import { councilStore } from './store';
import { ledgerStore } from './ledger-store';
import { getLatestOutput, deleteAllArtifacts } from './context-store';

export interface WorkflowRunCallbacks {
  /** Runs one council's full deliberation (blocking until done). */
  frameProblem: (council: Council, rawProblem: string) => Promise<void>;
  /** Fired before each step starts — use to follow the run in the UI. */
  onStepStart?: (council: Council, index: number, total: number) => void;
}

/** Reset a step's results so it can run fresh (ledger, artifacts, state). */
export function clearStepResults(councilId: string): void {
  ledgerStore.clear(councilId);
  deleteAllArtifacts(councilId);
  councilStore.update(councilId, { deliberationState: undefined, status: 'active' });
}

/**
 * Render a step's input template against the outputs of the steps before it.
 *   {{input}}        → the immediately previous step's output
 *   {{input[N]}}     → step N's output (1-based, matching the rail numbering)
 *   {{input.field}}  → dot-path into the previous step's output parsed as JSON
 */
export function renderStepInput(template: string, priorSteps: Council[]): string {
  const prev = priorSteps[priorSteps.length - 1];
  const outputOf = (c: Council | undefined): string =>
    (c && getLatestOutput(c.id)?.content) || '';

  return template
    .replace(/\{\{\s*input\[(\d+)\]\s*\}\}/g, (_, n) => outputOf(priorSteps[Number(n) - 1]))
    .replace(/\{\{\s*input\.([\w.[\]]+)\s*\}\}/g, (_, path: string) => {
      try {
        const json = JSON.parse(outputOf(prev));
        const val = path.split('.').reduce<unknown>(
          (o, k) => (o != null && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
          json,
        );
        return val == null ? '' : typeof val === 'string' ? val : JSON.stringify(val);
      } catch {
        return '';
      }
    })
    .replace(/\{\{\s*input\s*\}\}/g, () => outputOf(prev));
}

/**
 * Compose the full problem text for one step: its own Task, the previous
 * step's output (via the step's input contract), and optionally the
 * workflow's original starting input.
 */
export function composeStepProblem(step: Council, priorSteps: Council[]): string {
  const task = step.deliberation?.savedProblem?.trim() || step.topic?.trim() || '';
  if (priorSteps.length === 0) return task;

  const template = step.deliberation?.inputTemplate?.trim() || '{{input}}';
  const rendered = renderStepInput(template, priorSteps).trim();
  const prevName = priorSteps[priorSteps.length - 1]?.name || 'previous step';

  const parts: string[] = [];
  if (task) parts.push(task);
  if (rendered) parts.push(`## INPUT FROM PREVIOUS STEP (${prevName})\n\n${rendered}`);
  if (step.deliberation?.includePipelineInput) {
    const anchor = priorSteps[0];
    const initial = anchor?.deliberation?.savedProblem?.trim();
    if (initial) parts.push(`## WORKFLOW STARTING INPUT\n\n${initial}`);
  }
  return parts.join('\n\n');
}

/**
 * Run the workflow from the given step FORWARD through the last step.
 * Steps before it keep their existing results (their outputs feed the run);
 * the step itself and everything after are cleared, then run in order.
 * Stops at the first failing step (its error propagates).
 */
export async function runWorkflowFrom(
  startCouncilId: string,
  callbacks: WorkflowRunCallbacks,
): Promise<void> {
  const steps = councilStore.getWorkflow(startCouncilId);
  const startIdx = Math.max(0, steps.findIndex((s) => s.id === startCouncilId));
  const toRun = steps.slice(startIdx);

  // Invalidate forward: everything from the start step on runs fresh.
  for (const step of toRun) clearStepResults(step.id);

  for (let i = 0; i < toRun.length; i++) {
    // Re-read: earlier iterations (and clearStepResults) mutate the store.
    const step = councilStore.get(toRun[i].id);
    if (!step) continue;
    const priorSteps = steps.slice(0, startIdx + i);
    const problem = composeStepProblem(step, priorSteps);
    callbacks.onStepStart?.(step, startIdx + i, steps.length);
    await callbacks.frameProblem(step, problem);
  }
}
