/**
 * Rule-Based Router — deterministic fallback.
 *
 * Maps (phase, task_kind) to the best model from the registry. Used when the
 * intent tier returns nothing (or as the last resort). Ported verbatim from
 * kondi-chat with imports pointed at the local registry/types.
 */

import type { LedgerPhase, ProviderId, TaskKind } from './types';
import { ModelRegistry, type ModelCapability, type ModelEntry } from './registry';
import type { BudgetProfile } from './profiles';

interface RegistryView {
  getEnabled(): ModelEntry[];
  getByCapability(capability: ModelCapability): ModelEntry[];
  getCheapest(capability: ModelCapability): ModelEntry | undefined;
  getBest(capability: ModelCapability): ModelEntry | undefined;
}

function scopedRegistry(registry: ModelRegistry, providers: ProviderId[]): RegistryView {
  const allowed = new Set(providers);
  const filter = (m: ModelEntry) => allowed.has(m.provider);
  return {
    getEnabled: () => registry.getEnabled().filter(filter),
    getByCapability: (cap) => registry.getByCapability(cap).filter(filter),
    getCheapest: (cap) => registry.getByCapability(cap).filter(filter)[0],
    getBest: (cap) => {
      const list = registry.getByCapability(cap).filter(filter);
      return list[list.length - 1];
    },
  };
}

export interface RouteDecision {
  model: ModelEntry;
  reason: string;
  promoted: boolean;
}

export class RuleRouter {
  private registry: ModelRegistry;
  private profile?: BudgetProfile;
  private override?: ModelEntry;

  constructor(registry: ModelRegistry) {
    this.registry = registry;
  }

  setProfile(profile: BudgetProfile): void {
    this.profile = profile;
  }

  /** Registry view scoped to the profile's declared models (via rolePinning). */
  private reg(): RegistryView {
    if (!this.profile?.rolePinning) return this.registry;
    const providers = new Set<ProviderId>();
    for (const modelId of Object.values(this.profile.rolePinning)) {
      const m = this.registry.getById(modelId);
      if (m) providers.add(m.provider);
    }
    return providers.size > 0
      ? scopedRegistry(this.registry, [...providers])
      : this.registry;
  }

  setOverride(model: ModelEntry | undefined): void {
    this.override = model;
  }

  getOverride(): ModelEntry | undefined {
    return this.override;
  }

  select(
    phase: LedgerPhase,
    taskKind?: TaskKind,
    failures = 0,
    promotionThreshold = 2,
  ): RouteDecision {
    if (this.override) {
      return { model: this.override, reason: `override: ${this.override.alias || this.override.id}`, promoted: false };
    }

    const promoted = failures >= promotionThreshold;

    if (promoted && phase === 'execute') {
      const best = this.reg().getBest('coding');
      if (best) {
        return { model: best, reason: `promoted after ${failures} failures`, promoted: true };
      }
    }

    switch (phase) {
      case 'discuss':
      case 'dispatch':
        return this.selectForReasoning();
      case 'reflect':
        return this.selectForReview();
      case 'execute':
        return this.selectForExecution(taskKind);
      case 'compress':
      case 'state_update':
        return this.selectForCheap();
      default:
        return this.selectForReasoning();
    }
  }

  private selectForReasoning(): RouteDecision {
    if (this.profile) {
      const prefs = this.profile.planningPreference;
      const selector = this.profile.preferLocal
        ? (cap: string) => this.reg().getCheapest(cap)
        : (cap: string) => this.reg().getBest(cap);
      for (const cap of prefs) {
        const model = selector(cap);
        if (model) return { model, reason: `${this.profile.name}: ${cap}`, promoted: false };
      }
    }

    const model = this.reg().getBest('planning')
      || this.reg().getBest('reasoning')
      || this.reg().getBest('coding')
      || this.fallback();
    return { model, reason: 'reasoning phase — best planner', promoted: false };
  }

  private selectForExecution(taskKind?: TaskKind): RouteDecision {
    if (this.profile) {
      if (taskKind) {
        const directMatch = this.profile.preferLocal
          ? this.reg().getCheapest(taskKind)
          : this.reg().getByCapability(taskKind)[0];
        if (directMatch) {
          return { model: directMatch, reason: `${this.profile.name}: ${taskKind} match`, promoted: false };
        }
      }

      const prefs = this.profile.executionPreference;
      for (const cap of prefs) {
        const model = this.reg().getCheapest(cap);
        if (model) return { model, reason: `${this.profile.name}: ${cap}`, promoted: false };
      }
    }

    if (taskKind) {
      const directMatch = this.reg().getCheapest(taskKind);
      if (directMatch) {
        return { model: directMatch, reason: `${taskKind} task — direct capability match`, promoted: false };
      }
    }

    switch (taskKind) {
      case 'analysis':
      case 'code-review': {
        const reviewer = this.reg().getBest('code-review')
          || this.reg().getBest('analysis')
          || this.reg().getBest('reasoning')
          || this.fallback();
        return { model: reviewer, reason: `${taskKind} task — best reviewer`, promoted: false };
      }
      case 'marketing':
      case 'writing': {
        const writer = this.reg().getCheapest('marketing')
          || this.reg().getCheapest('writing')
          || this.reg().getCheapest('general')
          || this.fallback();
        return { model: writer, reason: `${taskKind} task — best writer`, promoted: false };
      }
      case 'test':
      case 'fix': {
        const fixer = this.reg().getCheapest('fast-coding')
          || this.reg().getCheapest('coding')
          || this.fallback();
        return { model: fixer, reason: `${taskKind} task — cheapest coder`, promoted: false };
      }
      case 'implementation':
      case 'refactor':
      case 'refactoring': {
        const coder = this.reg().getCheapest('coding') || this.fallback();
        return { model: coder, reason: `${taskKind} task — cheapest coder`, promoted: false };
      }
      default: {
        const defaultModel = this.reg().getCheapest('coding')
          || this.reg().getCheapest('general')
          || this.fallback();
        return { model: defaultModel, reason: `${taskKind || 'unknown'} task — default`, promoted: false };
      }
    }
  }

  private selectForReview(): RouteDecision {
    if (this.profile && this.profile.reviewPreference.length > 0) {
      const selector = this.profile.preferLocal
        ? (cap: string) => this.reg().getCheapest(cap)
        : (cap: string) => this.reg().getBest(cap);
      for (const cap of this.profile.reviewPreference) {
        const model = selector(cap);
        if (model) return { model, reason: `${this.profile.name}: review ${cap}`, promoted: false };
      }
    }
    return this.selectForReasoning();
  }

  private selectForCheap(): RouteDecision {
    const model = this.reg().getCheapest('summarization')
      || this.reg().getCheapest('general')
      || this.fallback();
    return { model, reason: 'cheap phase — summarization', promoted: false };
  }

  private fallback(): ModelEntry {
    const enabled = this.reg().getEnabled();
    if (enabled.length === 0) {
      throw new Error('No models enabled in registry. Configure a provider in Settings.');
    }
    return enabled[0];
  }
}
