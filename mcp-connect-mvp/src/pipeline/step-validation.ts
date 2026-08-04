/**
 * Pre-run configuration validation — powers the ⚠ badges on graph nodes and
 * the run gate in the builder. A step's problems are human-readable strings;
 * a pipeline with any problems refuses to run.
 *
 * Key '__input__' carries pipeline-level input problems (shown on the ▶ Input
 * node).
 */
import type {
  Pipeline,
  PipelineStep,
  CouncilStepConfig,
  ScriptStepConfig,
  ConditionStepConfig,
  GateStepConfig,
} from './types';
import { isCouncilType, isLightweightCouncilType } from './types';

export const INPUT_KEY = '__input__';

function validateCouncilStep(
  config: CouncilStepConfig,
  configuredProviders?: Record<string, boolean>,
): string[] {
  const problems: string[] = [];
  const personas = config.councilSetup?.personas || [];

  if (personas.length === 0) {
    problems.push('No personas configured');
  }
  for (const p of personas) {
    if (!p.model) problems.push(`Persona "${p.name}" has no model`);
    if (!p.provider) {
      problems.push(`Persona "${p.name}" has no provider`);
    } else if (
      configuredProviders &&
      p.provider !== 'router' &&
      configuredProviders[p.provider] === false
    ) {
      problems.push(`Persona "${p.name}": provider "${p.provider}" is not configured`);
    }
  }

  const hasTask = !!config.task?.trim();
  const receivesInput = config.inputTemplate !== 'none';
  if (!hasTask && !receivesInput) {
    problems.push('Step has no Task and its input is set to "none" — it would run with nothing to do');
  }
  // Full councils deliberate toward a declared deliverable; lightweight
  // agent/analysis steps define theirs in the Task, so don't nag them.
  if (!isLightweightCouncilType(config.type) && !config.councilSetup?.expectedOutput?.trim()) {
    problems.push('Expected Output not specified');
  }
  return problems;
}

export function validateStep(
  step: PipelineStep,
  pipeline: Pipeline,
  configuredProviders?: Record<string, boolean>,
): string[] {
  const config = step.config;

  if (isCouncilType(config.type)) {
    return validateCouncilStep(config as CouncilStepConfig, configuredProviders);
  }
  if (config.type === 'script') {
    const c = config as ScriptStepConfig;
    return c.command?.trim() ? [] : ['No shell command configured'];
  }
  if (config.type === 'gate') {
    const c = config as GateStepConfig;
    return c.approvalPrompt?.trim() ? [] : ['No approval prompt configured'];
  }
  if (config.type === 'condition') {
    const c = config as ConditionStepConfig;
    const problems: string[] = [];
    if (!c.expression?.trim()) problems.push('No expression configured');
    const loops = c.trueAction === 'loop_to_stage' || c.falseAction === 'loop_to_stage';
    if (loops) {
      if (!c.loopTargetStageId) {
        problems.push('Loop action has no target step');
      } else {
        const stageIdx = pipeline.stages.findIndex((s) =>
          s.steps.some((st) => st.id === step.id)
        );
        const targetIdx = pipeline.stages.findIndex((s) => s.id === c.loopTargetStageId);
        if (targetIdx === -1) problems.push('Loop target no longer exists');
        else if (targetIdx > stageIdx) problems.push('Loop target must be an EARLIER step');
      }
    }
    return problems;
  }
  return [];
}

/** Pipeline-level input problems (shown on the ▶ Input node). */
export function validatePipelineInput(pipeline: Pipeline): string[] {
  const src = pipeline.inputSource;
  const kind = src?.kind || 'text';
  if (kind !== 'text' && !src?.value?.trim()) {
    return [`Input source is "${kind}" but no ${kind === 'url' ? 'URL' : 'path'} is set`];
  }
  if (kind === 'text' && !pipeline.initialInput?.trim()) {
    // Only a problem when the first step also has nothing to work from.
    const firstSteps = pipeline.stages[0]?.steps || [];
    const anyTask = firstSteps.some(
      (s) => !!(s.config as { task?: string }).task?.trim()
    );
    if (!anyTask && firstSteps.length > 0) {
      return ['No initial input, and the first step has no Task either'];
    }
  }
  return [];
}

/**
 * Validate the whole pipeline. Returns a map of stepId (or INPUT_KEY) →
 * problems. Empty map = ready to run.
 */
export function validatePipeline(
  pipeline: Pipeline,
  configuredProviders?: Record<string, boolean>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const inputProblems = validatePipelineInput(pipeline);
  if (inputProblems.length) result.set(INPUT_KEY, inputProblems);
  for (const stage of pipeline.stages) {
    for (const step of stage.steps) {
      const problems = validateStep(step, pipeline, configuredProviders);
      if (problems.length) result.set(step.id, problems);
    }
  }
  return result;
}
