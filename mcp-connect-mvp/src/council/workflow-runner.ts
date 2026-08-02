/**
 * Workflow bridge — a multi-step council workflow IS a pipeline.
 *
 * A workflow is a series of councils sharing a workflowId (see store.ts
 * appendCouncilToWorkflow). Sequencing is owned by the PipelineExecutor:
 * `syncWorkflowPipeline` projects the council chain into a hidden shadow
 * pipeline (source 'council-workflow', one sequential stage per step, each
 * step BOUND to its persistent council via boundCouncilId), regenerated from
 * the chain on every run so it can never drift. Running step K marks the
 * steps before it completed (the executor's resume skips those) and the rest
 * pending — so a run always reruns K..N in order, each step's input composed
 * from the sibling councils' outputs (composeStepProblem, called by the
 * executor's bound-council path).
 */
import type { Council } from './types';
import { councilStore } from './store';
import { ledgerStore } from './ledger-store';
import { getLatestOutput, deleteAllArtifacts } from './context-store';
import { renderCoreTemplate } from '../pipeline/input-template';
import { pipelineStore } from '../pipeline/store';
import type { CouncilStepConfig, PipelineStage } from '../pipeline/types';

/** Reset a step's results so it can run fresh (ledger, artifacts, state). */
export function clearStepResults(councilId: string): void {
  ledgerStore.clear(councilId);
  deleteAllArtifacts(councilId);
  councilStore.update(councilId, { deliberationState: undefined, status: 'active' });
}

/**
 * Render a step's input template against the outputs of the steps before it.
 * Shares the core {{input}}/{{input[N]}}/{{input.field}} semantics with the
 * pipeline executor (input-template.ts); here {{input[N]}} is 1-based to
 * match the step-rail numbering, and {{input}} is the previous step's output.
 */
export function renderStepInput(template: string, priorSteps: Council[]): string {
  const inputs = priorSteps.map((c) => {
    const content = getLatestOutput(c.id)?.content || '';
    return { display: content, raw: content };
  });
  const last = inputs[inputs.length - 1];
  if (!template || template === '{{input}}') return last?.display ?? '';
  // Workflow {{input}} means the PREVIOUS step's output (per the rail UX), not
  // all steps joined — rewrite bare {{input}} to an indexed access, then let
  // the shared renderer handle everything ({{input.field}} already targets the
  // last input, i.e. the previous step).
  const rewritten = template.replace(/\{\{input\}\}/g, `{{input[${inputs.length}]}}`);
  return renderCoreTemplate(rewritten, inputs, { indexBase: 1 });
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
 * Project the council chain containing `startCouncilId` into its shadow
 * pipeline and prime it to run from that step FORWARD: steps before it are
 * marked completed (the executor's resume skips them; their existing outputs
 * feed the run), the rest pending. Returns the shadow pipeline's id, or null
 * if the council isn't part of a multi-step workflow.
 */
export function syncWorkflowPipeline(startCouncilId: string): string | null {
  const chain = councilStore.getWorkflow(startCouncilId);
  const workflowId = chain[0]?.workflowId;
  if (chain.length < 2 || !workflowId) return null;

  const startIdx = Math.max(0, chain.findIndex((c) => c.id === startCouncilId));
  const pipelineId = `council-wf-${workflowId}`;
  const name = councilStore.getWorkflowName(startCouncilId) || chain[0].name;

  const stages: PipelineStage[] = chain.map((c, i) => ({
    id: `wfstage-${c.id}`,
    name: c.name,
    executionMode: 'sequential',
    steps: [
      {
        id: `wfstep-${c.id}`,
        name: c.name,
        config: {
          type: c.deliberation?.stepType === 'coding' ? 'coding' : 'council',
          boundCouncilId: c.id,
          councilSetup: { name: c.name, personas: [] },
          inputTemplate: '{{input}}',
        } as CouncilStepConfig,
        status: i < startIdx ? 'completed' : 'pending',
      },
    ],
  }));

  if (!pipelineStore.get(pipelineId)) {
    pipelineStore.create({ id: pipelineId, name, source: 'council-workflow' });
  }
  pipelineStore.update(pipelineId, {
    name,
    stages,
    status: 'ready',
    currentStageIndex: 0,
    source: 'council-workflow',
    settings: {
      workingDirectory: chain[0].deliberation?.workingDirectory,
      // Bound steps resolve their working dir from their own council record.
      directoryConstrained: false,
      failurePolicy: 'stop',
      // No per-run output dirs for workflows — councils own their file output.
      outputConfig: { enabled: false, stepOutput: 'artifact_only' },
    },
  });
  return pipelineId;
}
