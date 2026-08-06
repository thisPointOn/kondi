/**
 * Councils-as-pipelines migration.
 *
 * The standalone Councils surface is gone from the UI — a council is the
 * deliberation ENGINE inside a pipeline step, not a parallel top-level thing.
 * Every pre-existing council must therefore be reachable through Pipelines:
 *
 * - A multi-step council workflow already has a shadow pipeline
 *   (`council-wf-<workflowId>`, built by workflow-runner's
 *   syncWorkflowPipeline). Those were hidden while the Councils section
 *   existed; they are now the canonical visible pipeline (the source filter
 *   was removed from Sidebar/PipelineLibrary).
 *
 * - A standalone single council gets a one-step pipeline BOUND to it
 *   (deterministic id `council-1s-<councilId>`, step boundCouncilId), so its
 *   full history/config/personas remain the source of truth and rerunning the
 *   pipeline reruns THE SAME council in place — nothing is duplicated or lost.
 *
 * Both operations are idempotent (deterministic ids, existence checks) and
 * run at startup; ensurePipelineForCouncil is also called for councils born
 * after startup (e.g. generated from chat).
 */

import { pipelineStore } from './store';
import { councilStore } from '../council/store';
import { syncWorkflowPipeline } from '../council/workflow-runner';
import type { CouncilStepConfig, PipelineStage } from './types';
import type { Council } from '../council/types';

const oneStepPipelineId = (councilId: string) => `council-1s-${councilId}`;

/** True if this council is already reachable through some pipeline. */
function hasPipelineHome(council: Council): boolean {
  if (council.pipelineId && pipelineStore.get(council.pipelineId)) return true;
  if (council.workflowId && pipelineStore.get(`council-wf-${council.workflowId}`)) return true;
  return !!pipelineStore.get(oneStepPipelineId(council.id));
}

/**
 * Make sure `council` is visible through the Pipelines surface, creating its
 * one-step bound pipeline (or workflow shadow pipeline) if needed.
 * Returns the pipeline id the council lives in, or null if none was needed
 * (e.g. a pipeline-spawned council whose parent pipeline exists).
 */
export function ensurePipelineForCouncil(councilId: string): string | null {
  const council = councilStore.get(councilId);
  if (!council) return null;

  // Pipeline-spawned councils are reached through their parent pipeline.
  if (council.pipelineId && pipelineStore.get(council.pipelineId)) return council.pipelineId;

  // Workflow member: the shadow pipeline is the home for the whole chain.
  if (council.workflowId) {
    const synced = syncWorkflowPipeline(council.id);
    if (synced) return synced;
    // Chain of 1 (workflow id but no siblings) → fall through to one-step.
  }

  const pid = oneStepPipelineId(council.id);
  if (pipelineStore.get(pid)) return pid;

  const stage: PipelineStage = {
    id: `1sstage-${council.id}`,
    name: council.name,
    executionMode: 'sequential',
    steps: [
      {
        id: `1sstep-${council.id}`,
        name: council.name,
        config: {
          type: council.deliberation?.stepType === 'coding' ? 'coding' : 'council',
          boundCouncilId: council.id,
          councilSetup: { name: council.name, personas: [] },
          inputTemplate: '{{input}}',
        } as CouncilStepConfig,
        status: 'pending',
      },
    ],
  };

  pipelineStore.create({ id: pid, name: council.name, source: 'council-workflow' });
  pipelineStore.update(pid, {
    name: council.name,
    stages: [stage],
    status: 'ready',
    currentStageIndex: 0,
    source: 'council-workflow',
    initialInput: council.deliberation?.savedProblem || '',
    settings: {
      workingDirectory: council.deliberation?.workingDirectory,
      // The bound step resolves its working dir from the council record.
      directoryConstrained: false,
      failurePolicy: 'stop',
      outputConfig: { enabled: false, stepOutput: 'artifact_only' },
    },
  });
  return pid;
}

/**
 * Startup sweep: give every council a pipeline home. Idempotent.
 * Returns how many pipelines were created/synced.
 */
export function migrateCouncilsToPipelines(): number {
  let migrated = 0;
  for (const council of councilStore.getAll()) {
    if (hasPipelineHome(council)) continue;
    // Only the head of a workflow needs to sync the chain's shadow pipeline;
    // ensurePipelineForCouncil handles both cases idempotently.
    if (ensurePipelineForCouncil(council.id)) migrated++;
  }
  if (migrated > 0) {
    console.log(`[CouncilMigration] Gave ${migrated} council(s) a pipeline home`);
  }
  return migrated;
}
