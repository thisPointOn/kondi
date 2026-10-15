/**
 * Self-Improvement: pure recipe mutations.
 *
 * `applyToConfig` turns a Proposal into a NEW CouncilStepConfig (never
 * mutates its input); `applyToCouncil` computes the patch for a bound
 * council. Both are shared by apply.ts (real apply) and eval.ts (replay with
 * the change). Keeping them pure makes them trivially testable and lets the
 * same code produce the "before" snapshot for revert.
 */

import type { CouncilStepConfig, PipelinePersona } from '../pipeline/types';
import type { Council, Persona, DeliberationRoleAssignment } from '../council/types';
import type { Proposal } from './types';

export class MutationError extends Error {
  readonly code: 'stale' | 'invalid' | 'unsupported';
  constructor(message: string, code: 'stale' | 'invalid' | 'unsupported') {
    super(message);
    this.name = 'MutationError';
    this.code = code;
  }
}

const COUNCIL_SETTING_KEYS = new Set(['maxRounds', 'maxRevisions', 'expectedOutput', 'decisionCriteria', 'testCommand', 'maxDebugCycles', 'maxReviewCycles']);
const COUNCIL_SETTING_BOUNDS: Record<string, { min: number; max: number }> = {
  maxRounds: { min: 0, max: 10 },
  maxRevisions: { min: 0, max: 10 },
  maxDebugCycles: { min: 0, max: 10 },
  maxReviewCycles: { min: 0, max: 5 },
};

/** The COMPLETION SUMMARY contract the minimal worker prompt guarantees. */
export const COMPLETION_SUMMARY_RE = /##\s*COMPLETION SUMMARY/i;

function asString(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new MutationError(`${what} must be a non-empty string`, 'invalid');
  return v;
}

/** Locate the target persona by index AND name (unbound personas have no id). */
export function findPersona(config: CouncilStepConfig, target: Proposal['target']): { index: number; persona: PipelinePersona } {
  const personas = config.councilSetup?.personas || [];
  const t = target.persona;
  if (!t) throw new MutationError('Proposal has no persona target', 'invalid');
  const byIndex = personas[t.index];
  if (byIndex && byIndex.name === t.name) return { index: t.index, persona: byIndex };
  // Fall back to a unique name match (the step may have been re-ordered).
  const matches = personas.map((p, i) => ({ p, i })).filter((x) => x.p.name === t.name);
  if (matches.length === 1) return { index: matches[0].i, persona: matches[0].p };
  throw new MutationError(`Persona "${t.name}" (index ${t.index}) no longer exists in step "${target.stepName}"`, 'stale');
}

/**
 * Apply a proposal to an UNBOUND step config. Returns a deep-cloned config
 * with the change (and the `before` value it replaced, for revert).
 */
export function applyToConfig(config: CouncilStepConfig, proposal: Proposal, value: unknown = proposal.after): { config: CouncilStepConfig; before: unknown } {
  const next: CouncilStepConfig = JSON.parse(JSON.stringify(config));
  next.councilSetup = next.councilSetup || { name: 'council', personas: [] };
  next.councilSetup.personas = next.councilSetup.personas || [];

  switch (proposal.kind) {
    case 'persona_prompt': {
      const { index } = findPersona(next, proposal.target);
      const p = next.councilSetup.personas[index];
      const before = p.systemPrompt;
      p.systemPrompt = asString(value, 'systemPrompt');
      if (p.systemPrompt.length < 10) throw new MutationError('System prompt must be at least 10 characters', 'invalid');
      return { config: next, before };
    }
    case 'worker_prompt': {
      const { index } = findPersona(next, proposal.target);
      const p = next.councilSetup.personas[index];
      if (p.role !== 'worker') throw new MutationError('worker_prompt targets a non-worker persona', 'invalid');
      const text = asString(value, 'systemPrompt');
      if (!COMPLETION_SUMMARY_RE.test(text)) {
        throw new MutationError('A worker system prompt must keep the "## COMPLETION SUMMARY" contract', 'invalid');
      }
      const before = { systemPrompt: p.systemPrompt, suppressPersona: p.suppressPersona };
      p.systemPrompt = text;
      // The minimal worker prompt is used unless suppressPersona is explicitly
      // false — flip it atomically so the new prompt actually reaches the model.
      p.suppressPersona = false;
      return { config: next, before };
    }
    case 'focus_area': {
      const { index } = findPersona(next, proposal.target);
      const p = next.councilSetup.personas[index];
      const before = p.focusArea;
      p.focusArea = asString(value, 'focusArea');
      return { config: next, before };
    }
    case 'step_task': {
      const before = next.task;
      next.task = asString(value, 'task');
      return { config: next, before };
    }
    case 'expected_output': {
      const before = next.councilSetup.expectedOutput;
      next.councilSetup.expectedOutput = asString(value, 'expectedOutput');
      return { config: next, before };
    }
    case 'decision_criteria': {
      if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) {
        throw new MutationError('decisionCriteria must be a string array', 'invalid');
      }
      const before = next.councilSetup.decisionCriteria;
      next.councilSetup.decisionCriteria = value as string[];
      return { config: next, before };
    }
    case 'council_setting': {
      const key = (proposal.target.path || '').replace(/^councilSetup\./, '');
      if (!COUNCIL_SETTING_KEYS.has(key)) throw new MutationError(`Unsupported council setting "${key}"`, 'unsupported');
      const bounds = COUNCIL_SETTING_BOUNDS[key];
      if (bounds) {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
          throw new MutationError(`${key} must be an integer in [${bounds.min}, ${bounds.max}]`, 'invalid');
        }
      }
      const setup = next.councilSetup as unknown as Record<string, unknown>;
      const before = setup[key];
      setup[key] = value;
      return { config: next, before };
    }
    case 'model_swap': {
      const { index } = findPersona(next, proposal.target);
      const p = next.councilSetup.personas[index];
      const v = value as { model?: string; provider?: string } | null;
      if (!v || typeof v.model !== 'string' || typeof v.provider !== 'string') {
        throw new MutationError('model_swap value must be { model, provider }', 'invalid');
      }
      const before = { model: p.model, provider: p.provider };
      p.model = v.model;
      p.provider = v.provider;
      return { config: next, before };
    }
    case 'lesson':
    case 'router_profile':
    case 'structure':
      throw new MutationError(`Proposal kind "${proposal.kind}" is not a step-config mutation`, 'unsupported');
    default:
      throw new MutationError(`Unknown proposal kind "${String((proposal as Proposal).kind)}"`, 'unsupported');
  }
}

/** Patch for a BOUND council record. */
export interface CouncilPatch {
  persona?: { personaId: string; updates: Partial<Omit<Persona, 'id'>> };
  roleAssignments?: DeliberationRoleAssignment[];
  deliberation?: Partial<NonNullable<Council['deliberation']>>;
  savedProblem?: string;
  before: unknown;
}

export function applyToCouncil(council: Council, proposal: Proposal, value: unknown = proposal.after): CouncilPatch {
  const personaId = proposal.target.bound?.personaId;
  const persona = personaId ? council.personas.find((p) => p.id === personaId) : undefined;
  const needPersona = () => {
    if (!persona) throw new MutationError(`Persona ${personaId || '(none)'} not found in council "${council.name}"`, 'stale');
    return persona;
  };
  const roles = council.deliberation?.roleAssignments || [];

  switch (proposal.kind) {
    case 'persona_prompt':
    case 'worker_prompt': {
      const p = needPersona();
      const text = asString(value, 'systemPrompt');
      if (text.length < 10) throw new MutationError('System prompt must be at least 10 characters', 'invalid');
      if (proposal.kind === 'worker_prompt' && !COMPLETION_SUMMARY_RE.test(text)) {
        throw new MutationError('A worker system prompt must keep the "## COMPLETION SUMMARY" contract', 'invalid');
      }
      const patch: CouncilPatch = {
        persona: { personaId: p.id, updates: { predisposition: { ...p.predisposition, systemPrompt: text } } },
        before: p.predisposition.systemPrompt,
      };
      if (proposal.kind === 'worker_prompt') {
        patch.roleAssignments = roles.map((r) => (r.personaId === p.id ? { ...r, suppressPersona: false } : r));
        patch.before = { systemPrompt: p.predisposition.systemPrompt, suppressPersona: roles.find((r) => r.personaId === p.id)?.suppressPersona };
      }
      return patch;
    }
    case 'focus_area': {
      const p = needPersona();
      const text = asString(value, 'focusArea');
      const ra = roles.find((r) => r.personaId === p.id);
      return {
        roleAssignments: roles.map((r) => (r.personaId === p.id ? { ...r, focusArea: text } : r)),
        before: ra?.focusArea,
      };
    }
    case 'step_task':
      return { savedProblem: asString(value, 'task'), before: council.deliberation?.savedProblem };
    case 'expected_output':
      return { deliberation: { expectedOutput: asString(value, 'expectedOutput') }, before: council.deliberation?.expectedOutput };
    case 'decision_criteria':
      if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) {
        throw new MutationError('decisionCriteria must be a string array', 'invalid');
      }
      return { deliberation: { decisionCriteria: value as string[] }, before: council.deliberation?.decisionCriteria };
    case 'council_setting': {
      const key = (proposal.target.path || '').replace(/^councilSetup\./, '');
      if (!COUNCIL_SETTING_KEYS.has(key)) throw new MutationError(`Unsupported council setting "${key}"`, 'unsupported');
      const bounds = COUNCIL_SETTING_BOUNDS[key];
      if (bounds && (typeof value !== 'number' || !Number.isInteger(value) || value < bounds.min || value > bounds.max)) {
        throw new MutationError(`${key} must be an integer in [${bounds.min}, ${bounds.max}]`, 'invalid');
      }
      const d = (council.deliberation || {}) as unknown as Record<string, unknown>;
      return { deliberation: { [key]: value } as Partial<NonNullable<Council['deliberation']>>, before: d[key] };
    }
    case 'model_swap': {
      const p = needPersona();
      const v = value as { model?: string; provider?: string } | null;
      if (!v || typeof v.model !== 'string' || typeof v.provider !== 'string') {
        throw new MutationError('model_swap value must be { model, provider }', 'invalid');
      }
      return { persona: { personaId: p.id, updates: { model: v.model, provider: v.provider } }, before: { model: p.model, provider: p.provider } };
    }
    default:
      throw new MutationError(`Proposal kind "${proposal.kind}" is not a council mutation`, 'unsupported');
  }
}

/** Human-readable path of what a proposal changes (for the UI/CLI). */
export function describeTarget(p: Proposal): string {
  const who = p.target.persona ? `${p.target.persona.name} (${p.target.persona.role})` : p.target.stepName;
  switch (p.kind) {
    case 'persona_prompt': return `${who} · system prompt`;
    case 'worker_prompt': return `${who} · worker system prompt (+ unsuppress persona)`;
    case 'focus_area': return `${who} · focus area`;
    case 'step_task': return `${p.target.stepName} · task`;
    case 'expected_output': return `${p.target.stepName} · expected output`;
    case 'decision_criteria': return `${p.target.stepName} · decision criteria`;
    case 'council_setting': return `${p.target.stepName} · ${(p.target.path || '').replace(/^councilSetup\./, '')}`;
    case 'model_swap': return `${who} · model`;
    case 'lesson': return `${p.target.stepName || 'all steps'} · lesson`;
    case 'router_profile': return `routing profile`;
    case 'structure': return `${p.target.stepName} · structure`;
    default: return p.target.stepName;
  }
}
