/**
 * Self-Improvement: apply / revert proposals.
 *
 * - Unbound steps: the step's config IS the recipe → deep-clone, mutate via
 *   `applyToConfig`, re-validate with the builder's own `validateStep`, then
 *   `pipelineStore.updateStepConfig` (which replaces the whole config).
 * - Bound steps: the council record is the recipe → `councilStore.updatePersona`
 *   / `setRoleAssignments` / `update({deliberation})` / `setSavedProblem`, each
 *   of which runs the Zod council schema and THROWS on invalid data; a throw
 *   becomes `status: 'rejected'` with the reason.
 * - Staleness: every proposal carries the target's hash at proposal time;
 *   apply refuses on mismatch (`stale`). Apply records a post-apply hash so
 *   revert can refuse if the target changed again since.
 * - Lessons: appended to the improve store (+ `_patterns.json` when a working
 *   directory is known); revert deactivates them.
 */

import { pipelineStore } from '../pipeline/store';
import type { Pipeline, PipelineStep, CouncilStepConfig } from '../pipeline/types';
import { validateStep } from '../pipeline/step-validation';
import { councilStore } from '../council/store';
import type { Council } from '../council/types';
import type { PlatformAdapter } from '../pipeline/executor';
import { improveStore } from './store';
import { applyToConfig, applyToCouncil, findPersona, MutationError } from './mutate';
import { hashValue } from './hash';
import { stepConfigHash } from './run-metrics';
import { writePatterns } from './lessons';
import type { Proposal, ProposalKind, ProposalTarget, ChangelogEntry, Lesson } from './types';

export type ApplyBy = ChangelogEntry['by'];

export interface ApplyOptions {
  /** Needed to mirror lessons into `<wd>/.kondi/memory/<pid>_patterns.json`. */
  platform?: PlatformAdapter;
  configuredProviders?: Record<string, boolean>;
}

// ============================================================================
// Hashes & current values
// ============================================================================

/** Recipe-relevant hash of a bound council (personas, roles, task, settings). */
export function boundCouncilHash(council: Council): string {
  return hashValue({
    personas: council.personas.map((p) => ({ id: p.id, name: p.name, model: p.model, provider: p.provider, systemPrompt: p.predisposition?.systemPrompt })),
    roles: council.deliberation?.roleAssignments,
    task: council.deliberation?.savedProblem,
    expectedOutput: council.deliberation?.expectedOutput,
    decisionCriteria: council.deliberation?.decisionCriteria,
    maxRounds: council.deliberation?.maxRounds,
    maxRevisions: council.deliberation?.maxRevisions,
    maxDebugCycles: council.deliberation?.maxDebugCycles,
    maxReviewCycles: council.deliberation?.maxReviewCycles,
    testCommand: council.deliberation?.testCommand,
  });
}

/** The hash a proposal is pinned to: step config, or the bound council recipe. */
export function proposalTargetHash(step: PipelineStep): string {
  const cfg = step.config as CouncilStepConfig;
  if (cfg.boundCouncilId) {
    const c = councilStore.get(cfg.boundCouncilId);
    return c ? boundCouncilHash(c) : 'missing-bound-council';
  }
  return stepConfigHash(step);
}

/** Read the CURRENT value a proposal would replace. */
export function currentValue(step: PipelineStep, kind: ProposalKind, target: ProposalTarget): unknown {
  const cfg = step.config as CouncilStepConfig;
  if (cfg.boundCouncilId) {
    const c = councilStore.get(cfg.boundCouncilId);
    if (!c) return undefined;
    const p = target.bound?.personaId ? c.personas.find((x) => x.id === target.bound!.personaId) : undefined;
    const ra = p ? c.deliberation?.roleAssignments?.find((r) => r.personaId === p.id) : undefined;
    switch (kind) {
      case 'persona_prompt': case 'worker_prompt': return p?.predisposition?.systemPrompt;
      case 'focus_area': return ra?.focusArea;
      case 'step_task': return c.deliberation?.savedProblem;
      case 'expected_output': return c.deliberation?.expectedOutput;
      case 'decision_criteria': return c.deliberation?.decisionCriteria;
      case 'council_setting': return (c.deliberation as unknown as Record<string, unknown> | undefined)?.[(target.path || '').replace(/^councilSetup\./, '')];
      case 'model_swap': return p ? { model: p.model, provider: p.provider } : undefined;
      default: return undefined;
    }
  }
  const persona = target.persona ? (() => { try { return findPersona(cfg, target).persona; } catch { return undefined; } })() : undefined;
  switch (kind) {
    case 'persona_prompt': case 'worker_prompt': return persona?.systemPrompt;
    case 'focus_area': return persona?.focusArea;
    case 'step_task': return cfg.task;
    case 'expected_output': return cfg.councilSetup?.expectedOutput;
    case 'decision_criteria': return cfg.councilSetup?.decisionCriteria;
    case 'council_setting': return (cfg.councilSetup as unknown as Record<string, unknown> | undefined)?.[(target.path || '').replace(/^councilSetup\./, '')];
    case 'model_swap': return persona ? { model: persona.model, provider: persona.provider } : undefined;
    default: return undefined;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function findStep(pipeline: Pipeline, stepId: string): PipelineStep | undefined {
  return pipeline.stages.flatMap((s) => s.steps).find((s) => s.id === stepId);
}

function changelog(pipelineId: string, proposalId: string, action: ChangelogEntry['action'], by: ApplyBy): void {
  improveStore.appendChangelog(pipelineId, {
    id: `cl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    proposalId, action, at: new Date().toISOString(), by,
  });
}

function fail(pipelineId: string, p: Proposal, status: 'stale' | 'invalid' | 'rejected', reason: string): Proposal {
  return improveStore.updateProposal(pipelineId, p.id, { status, reason, decidedAt: new Date().toISOString() },
    { type: 'rejected', pipelineId, proposalId: p.id })!;
}

async function mirrorLessons(pipelineId: string, opts?: ApplyOptions): Promise<void> {
  const wd = pipelineStore.get(pipelineId)?.settings.workingDirectory;
  if (!opts?.platform || !wd) return;
  try {
    await writePatterns(opts.platform, wd, pipelineId, improveStore.get(pipelineId).lessons);
  } catch (err) {
    console.warn('[Improve] Failed to write _patterns.json:', err);
  }
}

/** Apply a bound-council patch through the store (Zod-validated; throws on invalid). */
function applyCouncilPatch(councilId: string, patch: ReturnType<typeof applyToCouncil>): void {
  if (patch.persona) councilStore.updatePersona(councilId, patch.persona.personaId, patch.persona.updates);
  if (patch.roleAssignments) councilStore.setRoleAssignments(councilId, patch.roleAssignments);
  if (patch.savedProblem !== undefined) councilStore.setSavedProblem(councilId, patch.savedProblem);
  if (patch.deliberation) {
    const c = councilStore.get(councilId);
    if (!c?.deliberation) throw new Error('Council has no deliberation config');
    councilStore.update(councilId, { deliberation: { ...c.deliberation, ...patch.deliberation } });
  }
}

// ============================================================================
// Approve / reject
// ============================================================================

export function approveProposal(pipelineId: string, proposalId: string): Proposal | null {
  const p = improveStore.getProposal(pipelineId, proposalId);
  if (!p || (p.status !== 'proposed' && p.status !== 'evaluating')) return p;
  return improveStore.updateProposal(pipelineId, proposalId, { status: 'approved', decidedAt: new Date().toISOString() });
}

export function rejectProposal(pipelineId: string, proposalId: string, reason = 'Rejected by user'): Proposal | null {
  const p = improveStore.getProposal(pipelineId, proposalId);
  if (!p) return null;
  if (p.status !== 'proposed' && p.status !== 'approved' && p.status !== 'evaluating') return p;
  return fail(pipelineId, p, 'rejected', reason);
}

/**
 * Staleness with field-level rebase: the target hash pins the proposal to the
 * recipe it was made against; when the hash moved (e.g. a SIBLING proposal
 * from the same retrospective was just applied), the proposal is still
 * applicable as long as the exact field it changes still holds the `before`
 * value it was computed from.
 */
function isApplicable(p: Proposal, step: PipelineStep): boolean {
  if (proposalTargetHash(step) === p.configHash) return true;
  const current = currentValue(step, p.kind, p.target);
  const before = p.kind === 'worker_prompt' && p.before && typeof p.before === 'object'
    ? (p.before as { systemPrompt?: string }).systemPrompt
    : p.before;
  return JSON.stringify(current ?? null) === JSON.stringify(before ?? null);
}

// ============================================================================
// Apply
// ============================================================================

export async function applyProposal(pipelineId: string, proposalId: string, by: ApplyBy, opts: ApplyOptions = {}): Promise<Proposal> {
  const p = improveStore.getProposal(pipelineId, proposalId);
  if (!p) throw new Error(`Proposal not found: ${proposalId}`);
  if (p.status !== 'proposed' && p.status !== 'approved' && p.status !== 'evaluating') return p;

  const pipeline = pipelineStore.get(pipelineId);
  if (!pipeline) throw new Error(`Pipeline not found: ${pipelineId}`);

  // ---- lessons: no recipe mutation, just the store + patterns mirror ----
  if (p.kind === 'lesson') {
    const a = p.after as { text: string; scope: Lesson['scope']; stepId?: string };
    const lesson: Lesson = {
      id: `lesson-${p.id}`, text: a.text, scope: a.scope || 'all', stepId: a.stepId,
      source: { runId: p.runId, proposalId: p.id }, createdAt: new Date().toISOString(), confirmations: 0, active: true,
    };
    improveStore.upsertLesson(pipelineId, lesson);
    await mirrorLessons(pipelineId, opts);
    changelog(pipelineId, p.id, 'applied', by);
    return improveStore.updateProposal(pipelineId, p.id, { status: 'applied', appliedAt: new Date().toISOString(), decidedAt: new Date().toISOString(), reason: undefined },
      { type: 'applied', pipelineId, proposalId: p.id })!;
  }

  if (p.kind === 'router_profile' || p.kind === 'structure') {
    return fail(pipelineId, p, 'invalid', `Proposal kind "${p.kind}" is not applicable yet`);
  }

  const step = findStep(pipeline, p.target.stepId);
  if (!step) return fail(pipelineId, p, 'stale', `Step "${p.target.stepName}" no longer exists`);
  if (!isApplicable(p, step)) {
    return fail(pipelineId, p, 'stale', 'The value this proposal changes was edited since the retrospective — re-run it');
  }

  const cfg = step.config as CouncilStepConfig;
  try {
    if (cfg.boundCouncilId) {
      const council = councilStore.get(cfg.boundCouncilId);
      if (!council) return fail(pipelineId, p, 'stale', 'Bound council no longer exists');
      const patch = applyToCouncil(council, p);
      applyCouncilPatch(council.id, patch);
      const after = councilStore.get(council.id)!;
      changelog(pipelineId, p.id, 'applied', by);
      return improveStore.updateProposal(pipelineId, p.id, {
        status: 'applied', before: patch.before, appliedAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
        appliedConfigHash: boundCouncilHash(after), reason: undefined,
      }, { type: 'applied', pipelineId, proposalId: p.id })!;
    }

    const { config: mutated, before } = applyToConfig(cfg, p);
    const mutatedStep: PipelineStep = { ...step, config: mutated };
    // Only NEW validation problems block the apply — a step that was already
    // flagged (e.g. unconfigured provider) must not make every proposal invalid.
    const beforeProblems = new Set(validateStep(step, pipeline, opts.configuredProviders));
    const newProblems = validateStep(mutatedStep, pipeline, opts.configuredProviders).filter((x) => !beforeProblems.has(x));
    if (newProblems.length) return fail(pipelineId, p, 'invalid', `Would break the step: ${newProblems.join('; ')}`);

    pipelineStore.updateStepConfig(pipelineId, step.id, mutated);
    const afterStep = findStep(pipelineStore.get(pipelineId)!, step.id)!;
    changelog(pipelineId, p.id, 'applied', by);
    return improveStore.updateProposal(pipelineId, p.id, {
      status: 'applied', before, appliedAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
      appliedConfigHash: stepConfigHash(afterStep), reason: undefined,
    }, { type: 'applied', pipelineId, proposalId: p.id })!;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = err instanceof MutationError && err.code === 'stale' ? 'stale' : err instanceof MutationError && err.code === 'invalid' ? 'invalid' : 'rejected';
    return fail(pipelineId, p, status, msg);
  }
}

// ============================================================================
// Revert
// ============================================================================

export async function revertProposal(pipelineId: string, proposalId: string, by: ApplyBy, opts: ApplyOptions = {}): Promise<Proposal> {
  const p = improveStore.getProposal(pipelineId, proposalId);
  if (!p) throw new Error(`Proposal not found: ${proposalId}`);
  if (p.status !== 'applied') return p;
  const pipeline = pipelineStore.get(pipelineId);
  if (!pipeline) throw new Error(`Pipeline not found: ${pipelineId}`);
  const done = () => improveStore.updateProposal(pipelineId, p.id, { status: 'reverted', revertedAt: new Date().toISOString(), reason: undefined },
    { type: 'reverted', pipelineId, proposalId: p.id })!;

  if (p.kind === 'lesson') {
    const s = improveStore.get(pipelineId);
    for (const l of s.lessons) if (l.source.proposalId === p.id) improveStore.setLessonActive(pipelineId, l.id, false);
    await mirrorLessons(pipelineId, opts);
    changelog(pipelineId, p.id, 'reverted', by);
    return done();
  }

  const step = findStep(pipeline, p.target.stepId);
  if (!step) return improveStore.updateProposal(pipelineId, p.id, { reason: 'Cannot revert: step no longer exists' })!;
  if (p.appliedConfigHash && proposalTargetHash(step) !== p.appliedConfigHash) {
    return improveStore.updateProposal(pipelineId, p.id, { reason: 'Cannot revert: the step changed again after this was applied' })!;
  }

  const cfg = step.config as CouncilStepConfig;
  try {
    if (cfg.boundCouncilId) {
      const council = councilStore.get(cfg.boundCouncilId);
      if (!council) return improveStore.updateProposal(pipelineId, p.id, { reason: 'Cannot revert: bound council missing' })!;
      if (p.kind === 'worker_prompt') {
        const b = p.before as { systemPrompt?: string; suppressPersona?: boolean };
        const pid = p.target.bound?.personaId;
        const persona = council.personas.find((x) => x.id === pid);
        if (!persona) throw new MutationError('Persona missing', 'stale');
        if (b.systemPrompt !== undefined) councilStore.updatePersona(council.id, persona.id, { predisposition: { ...persona.predisposition, systemPrompt: b.systemPrompt } });
        const roles = councilStore.get(council.id)!.deliberation?.roleAssignments || [];
        councilStore.setRoleAssignments(council.id, roles.map((r) => (r.personaId === persona.id ? { ...r, suppressPersona: b.suppressPersona } : r)));
      } else {
        applyCouncilPatch(council.id, applyToCouncil(council, p, p.before));
      }
    } else if (p.kind === 'worker_prompt') {
      const next: CouncilStepConfig = JSON.parse(JSON.stringify(cfg));
      const { index } = findPersona(next, p.target);
      const b = p.before as { systemPrompt?: string; suppressPersona?: boolean };
      next.councilSetup.personas[index].systemPrompt = b.systemPrompt;
      next.councilSetup.personas[index].suppressPersona = b.suppressPersona;
      pipelineStore.updateStepConfig(pipelineId, step.id, next);
    } else {
      const { config } = applyToConfig(cfg, p, p.before);
      pipelineStore.updateStepConfig(pipelineId, step.id, config);
    }
    changelog(pipelineId, p.id, 'reverted', by);
    return done();
  } catch (err) {
    return improveStore.updateProposal(pipelineId, p.id, { reason: `Cannot revert: ${err instanceof Error ? err.message : String(err)}` })!;
  }
}
