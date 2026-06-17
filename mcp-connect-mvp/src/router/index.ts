/**
 * Unified Router — chains Intent → Pin fallback → Rules for model selection.
 *
 * Ported from kondi-chat. The learned NN tier and its embedding/collector
 * dependencies are intentionally dropped (they require offline-trained weights
 * and Node fs, neither available here). The functional tiers — profile pinning,
 * the intent classifier, and the rule fallback — fully cover routing.
 *
 * Priority: direct profile pin → Intent (when a classifier is available) →
 * pin fallback → Rules.
 */

import type { LedgerPhase, TaskKind, ProviderId, PhaseContext, ClassifierComplete } from './types';
import { ModelRegistry, type ModelEntry } from './registry';
import { RuleRouter } from './rules';
import { IntentRouter, type IntentRouterConfig } from './intent-router';

export interface UnifiedRouteDecision {
  model: ModelEntry;
  reason: string;
  tier: 'intent' | 'rules';
  promoted: boolean;
  confidence?: number;
}

export class Router {
  readonly registry: ModelRegistry;
  readonly rules: RuleRouter;
  readonly intent: IntentRouter;

  private useIntent: boolean;
  private profileScope: {
    allowedProviders?: ProviderId[];
    classifier?: { provider: ProviderId; model: string };
    rolePinning?: Record<string, string>;
  } = {};

  constructor(
    models: ModelEntry[],
    complete: ClassifierComplete,
    options?: {
      intentConfig?: Partial<IntentRouterConfig>;
      useIntent?: boolean;
    },
  ) {
    this.registry = new ModelRegistry(models);
    this.rules = new RuleRouter(this.registry);
    this.intent = new IntentRouter(complete, options?.intentConfig);
    this.useIntent = options?.useIntent ?? true;
  }

  setProfileScope(scope: {
    classifier?: { provider: ProviderId; model: string };
    rolePinning?: Record<string, string>;
    allowedProviders?: ProviderId[];
  }): void {
    let allowedProviders: ProviderId[] | undefined = scope.allowedProviders;
    if (!allowedProviders && scope.rolePinning) {
      const providers = new Set<ProviderId>();
      for (const modelId of Object.values(scope.rolePinning)) {
        const m = this.registry.getById(modelId);
        if (m) providers.add(m.provider);
      }
      if (providers.size > 0) allowedProviders = [...providers];
    }
    this.profileScope = { ...scope, allowedProviders };
  }

  getClassifier(): { provider: ProviderId; model: string } | undefined {
    return this.profileScope.classifier;
  }

  async select(
    phase: LedgerPhase,
    promptText: string,
    taskKind?: TaskKind,
    failures?: number,
    promotionThreshold?: number,
    phaseContext?: PhaseContext,
  ): Promise<UnifiedRouteDecision> {
    // Fast path: direct profile pin for this phase — no LLM call, no latency.
    const directPin = this.profileScope.rolePinning?.[phase];
    if (directPin) {
      const pinned = this.registry.getById(directPin);
      if (pinned && pinned.enabled) {
        return { model: pinned, reason: `pin: ${pinned.alias || pinned.id}`, tier: 'rules', promoted: false };
      }
    }

    // Intent tier — only reached when no direct pin exists for this phase.
    const pinnedModelIds = this.profileScope.rolePinning
      ? [...new Set(Object.values(this.profileScope.rolePinning))]
      : undefined;

    try {
      if (this.useIntent) {
        const intentResult = await this.intent.classify(
          promptText, phase, taskKind, this.registry,
          {
            allowedProviders: this.profileScope.allowedProviders,
            allowedModelIds: pinnedModelIds,
            classifier: this.profileScope.classifier,
            phaseContext,
            phasePreference: this.profileScope.rolePinning?.[phase],
          },
        );
        if (intentResult) {
          return { model: intentResult.model, reason: `intent: ${intentResult.intent}`, tier: 'intent', promoted: false };
        }
      }
    } catch (e) {
      console.debug('[router] intent tier failed:', (e as Error).message);
    }

    // Pin fallback (pin existed but model was disabled above).
    const pinnedId = this.profileScope.rolePinning?.[phase];
    if (pinnedId) {
      const pinned = this.registry.getById(pinnedId);
      if (pinned && pinned.enabled) {
        return {
          model: pinned,
          reason: `pin: ${pinned.alias || pinned.id} (intent failed)`,
          tier: 'rules',
          promoted: false,
        };
      }
    }

    // Rule-based fallback — last resort.
    const ruleResult = this.rules.select(phase, taskKind, failures, promotionThreshold);
    const fallbackReason = pinnedId
      ? `⚠ "${pinnedId}" not available → ${ruleResult.model.alias || ruleResult.model.id} (fallback)`
      : ruleResult.reason;
    return {
      model: ruleResult.model,
      reason: ruleResult.promoted
        ? `⚠ promoted after ${failures} failures → ${ruleResult.model.alias || ruleResult.model.id}`
        : fallbackReason,
      tier: 'rules',
      promoted: ruleResult.promoted,
    };
  }

  /** Synchronous select — rules only. */
  selectSync(
    phase: LedgerPhase,
    taskKind?: TaskKind,
    failures?: number,
    promotionThreshold?: number,
  ): UnifiedRouteDecision {
    const ruleResult = this.rules.select(phase, taskKind, failures, promotionThreshold);
    return { model: ruleResult.model, reason: ruleResult.reason, tier: 'rules', promoted: ruleResult.promoted };
  }
}

export { ModelRegistry, type ModelEntry, buildRegistryModels } from './registry';
export { RuleRouter, type RouteDecision } from './rules';
export { IntentRouter } from './intent-router';
