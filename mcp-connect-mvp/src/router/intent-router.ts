/**
 * Intent Router — LLM-based classification, the primary routing tier.
 *
 * Reads every enabled model's description from the registry and asks a cheap
 * classifier LLM which one best matches the current phase. Ported from
 * kondi-chat with one key change: instead of importing kondi-chat's raw-fetch
 * `callLLM`, the classifier call is injected (`ClassifierComplete`) so it goes
 * through kondi's `llm-router.simpleCompletion()` — preserving OAuth, MCP
 * proxies, and the no-CLI/API-fallover rule.
 */

import type { LedgerPhase, TaskKind, ProviderId, PhaseContext, ClassifierComplete } from './types';
import type { ModelRegistry, ModelEntry } from './registry';

export interface IntentRouterConfig {
  /** Default classifier provider — overridden per-call by the profile scope. */
  provider?: ProviderId;
  model?: string;
  /** Phases to run intent routing on. Undefined = all phases eligible. */
  phases?: LedgerPhase[];
}

export interface IntentRouterCallOptions {
  allowedProviders?: ProviderId[];
  allowedModelIds?: string[];
  classifier?: { provider: ProviderId; model: string };
  phaseContext?: PhaseContext;
  phasePreference?: string;
}

export class IntentRouter {
  private config: IntentRouterConfig;
  private complete: ClassifierComplete;

  constructor(complete: ClassifierComplete, config?: Partial<IntentRouterConfig>) {
    this.complete = complete;
    this.config = { ...config };
  }

  async classify(
    promptText: string,
    phase: LedgerPhase,
    taskKind: TaskKind | undefined,
    registry: ModelRegistry,
    opts?: IntentRouterCallOptions,
  ): Promise<{ model: ModelEntry; intent: string } | null> {
    if (this.config.phases && !this.config.phases.includes(phase)) {
      return null;
    }

    // Candidate scope: specific model ids (rolePinning) > provider filter > all.
    let enabled = registry.getEnabled();
    if (opts?.allowedModelIds && opts.allowedModelIds.length > 0) {
      const allow = new Set(opts.allowedModelIds);
      enabled = enabled.filter(m => allow.has(m.id));
    } else if (opts?.allowedProviders && opts.allowedProviders.length > 0) {
      const allow = new Set(opts.allowedProviders);
      enabled = enabled.filter(m => allow.has(m.provider));
    }
    if (enabled.length <= 1) {
      return enabled.length === 1
        ? { model: enabled[0], intent: 'only-candidate' }
        : null;
    }

    // Classifier model: per-call override (profile) > config default.
    const classifierProvider = opts?.classifier?.provider ?? this.config.provider;
    const classifierModel = opts?.classifier?.model ?? this.config.model;
    if (!classifierProvider || !classifierModel) {
      // No classifier available — defer to the next tier (rules).
      return null;
    }

    const routesXml = enabled
      .map(m => `  <route name="${m.id}">${this.describeModel(m)}</route>`)
      .join('\n');

    let contextBlock = '';
    if (opts?.phaseContext?.priorPhases && opts.phaseContext.priorPhases.length > 0) {
      const lines = opts.phaseContext.priorPhases.map(p =>
        `  - ${p.phase}: handled by ${p.model}${p.succeeded === false ? ' (FAILED)' : ''}${p.summary ? ` — ${p.summary}` : ''}`,
      );
      contextBlock = `\n<prior_phases>\n${lines.join('\n')}\n</prior_phases>\n`;
    }

    let preferenceHint = '';
    if (opts?.phasePreference) {
      preferenceHint = `\nThe user's profile suggests "${opts.phasePreference}" for the ${phase} phase. Honor this preference unless another model is clearly better suited given the context above.\n`;
    }

    const phaseDescriptions: Record<string, string> = {
      discuss: 'Conversational Q&A, explanations, open-ended discussion. Needs good general reasoning at reasonable cost.',
      dispatch: 'Planning and task decomposition. Needs strong architectural reasoning — this call sets the direction for everything that follows.',
      execute: 'Code generation, file editing, tool calls. High-volume phase. Cost and speed matter; planning was already done.',
      reflect: 'Reviewing and critiquing work that was just produced. Catch issues without hallucinating new ones. Prefer a different model than wrote it.',
      compress: 'Summarizing old context to save tokens. Grunt work — use the cheapest model available.',
      state_update: 'Updating session state. Grunt work — use the cheapest model available.',
      verify: 'Local verification (no LLM needed).',
      consult: 'Domain-expert consultation.',
    };
    const phaseDesc = phaseDescriptions[phase] || `Phase: ${phase}`;

    const prompt = `You are a router that selects the best model for the current step of a multi-phase pipeline.

<routes>
${routesXml}
</routes>

<current_step>
Phase: ${phase}
Phase meaning: ${phaseDesc}
${taskKind ? `Task kind: ${taskKind}` : ''}
Original goal: ${(opts?.phaseContext?.currentGoal || promptText).slice(0, 800)}
</current_step>
${contextBlock}${preferenceHint}
Given the available models, the current phase, and what happened in prior phases, which model should handle this step? Consider capabilities, cost, and whether the reviewer should differ from the author.
Respond with ONLY a JSON object: {"route": "model_id"}`;

    try {
      const content = await this.complete({
        provider: classifierProvider,
        model: classifierModel,
        systemPrompt: 'You select the best model for a task. Respond with only JSON.',
        userMessage: prompt,
      });

      const parsed = this.parseResponse(content);
      if (!parsed) return null;

      const model = registry.getById(parsed);
      if (!model || !model.enabled) return null;
      if (opts?.allowedProviders && opts.allowedProviders.length > 0) {
        if (!opts.allowedProviders.includes(model.provider)) return null;
      }

      return { model, intent: parsed };
    } catch {
      return null;
    }
  }

  private describeModel(m: ModelEntry): string {
    const costTier = m.inputCostPer1M < 1 ? 'cheap' : m.inputCostPer1M < 5 ? 'mid-tier' : 'expensive';
    return (
      `${m.name} — ${costTier} model (${m.provider}). ` +
      `Good at: ${m.capabilities.join(', ')}. ` +
      `Context: ${(m.contextWindow / 1000).toFixed(0)}K tokens. ` +
      `Cost: $${m.inputCostPer1M}/M input, $${m.outputCostPer1M}/M output.`
    );
  }

  private parseResponse(content: string): string | null {
    try {
      const match = content.match(/\{[^}]*"route"\s*:\s*"([^"]+)"[^}]*\}/);
      if (match) return match[1];
      const cleaned = content.trim().replace(/^["']|["']$/g, '');
      if (cleaned && !cleaned.includes(' ')) return cleaned;
      return null;
    } catch {
      return null;
    }
  }
}
