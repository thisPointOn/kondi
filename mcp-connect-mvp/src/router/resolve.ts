/**
 * Smart Router resolution (webview / Tauri path).
 *
 * Resolves a `route:<profile>` pseudo-model to a concrete { provider, model }
 * for the current phase. The classifier LLM call the router may make is wired
 * back through `simpleCompletion()` (a concrete model, never routed), so OAuth,
 * MCP proxies, and the no-CLI/API-fallover rule all still apply.
 *
 * Pure helpers (isRoutedModel, ROUTED_PROFILE_OPTIONS, roleToPhase, …) live in
 * ./profile-options so the headless CLI and React selectors can use them
 * without importing this module's Tauri-only dependencies. They're re-exported
 * here for convenience.
 */

import type { ModelProvider } from '../config/models';
import type { LedgerPhase } from './types';
import { Router, buildRegistryModels } from './index';
import { getProfile, type BudgetProfile } from './profiles';
import { getEffectiveProfile } from './profile-store';
import { resolveApiKeySync } from '../services/auth-profiles';
import { simpleCompletion } from '../services/llm-router';

export * from './profile-options';

// ---------------------------------------------------------------------------
// Configured-provider detection (best-effort, safe in webview & CLI)
// ---------------------------------------------------------------------------

/**
 * Best-effort set of configured kondi providers. Used to scope the registry so
 * capability-based profiles don't route to a provider the user hasn't set up.
 * Returns undefined (→ "enable everything") if detection isn't possible.
 */
function getConfiguredProviders(): Set<ModelProvider> | undefined {
  try {
    const s = new Set<ModelProvider>();
    s.add('ollama'); // local — always considered available
    const has = (p: Parameters<typeof resolveApiKeySync>[0]) => {
      try { return !!resolveApiKeySync(p); } catch { return false; }
    };
    if (has('anthropic')) { s.add('anthropic-api'); s.add('anthropic-cli'); }
    if (has('openai')) { s.add('openai-api'); s.add('openai-cli'); }
    if (has('deepseek')) s.add('deepseek');
    if (has('xai')) s.add('xai');
    if (has('zai')) s.add('zai');
    if (has('moonshot')) s.add('moonshot');
    if (has('google')) s.add('google');
    if (has('nvidia-router')) s.add('nvidia-router');
    return s.size > 1 ? s : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Pick a cheap, configured classifier model for the intent tier. */
function pickClassifier(
  models: ReturnType<typeof buildRegistryModels>,
  profile: BudgetProfile,
): { provider: ModelProvider; model: string } | undefined {
  let candidates = models.filter(m => m.enabled);
  if (profile.allowedProviders && profile.allowedProviders.length > 0) {
    const allow = new Set(profile.allowedProviders);
    candidates = candidates.filter(m => allow.has(m.provider));
  }
  if (candidates.length === 0) return undefined;
  const cheapest = candidates.sort((a, b) => a.inputCostPer1M - b.inputCostPer1M)[0];
  return { provider: cheapest.provider, model: cheapest.id };
}

const classifierComplete = async (req: {
  provider: ModelProvider;
  model: string;
  systemPrompt: string;
  userMessage: string;
}): Promise<string> => {
  const result = await simpleCompletion({
    provider: req.provider,
    model: req.model,
    systemPrompt: req.systemPrompt,
    userMessage: req.userMessage,
  });
  return result.content;
};

export interface ResolveOptions {
  /** Free-text prompt/goal that helps the intent classifier (optional). */
  prompt?: string;
}

export interface ResolvedRoute {
  provider: ModelProvider;
  model: string;
  /** The profile that produced this decision. */
  profile: string;
  /** Human-readable reason (pin/intent/rules). */
  reason: string;
}

/**
 * Resolve a routed profile to a concrete provider+model for `phase`.
 * Throws only if the profile yields no usable model at all.
 */
export async function resolveRoutedModel(
  profileName: string,
  phase: LedgerPhase,
  opts: ResolveOptions = {},
): Promise<ResolvedRoute> {
  // Honor user-added/edited profiles (Settings → Routing) over the built-ins.
  const profile = getEffectiveProfile(profileName) || getProfile(profileName);
  const models = buildRegistryModels({ configuredProviders: getConfiguredProviders() });
  const router = new Router(models, classifierComplete);
  router.setProfileScope({
    classifier: pickClassifier(models, profile),
    rolePinning: profile.rolePinning,
    allowedProviders: profile.allowedProviders,
  });

  const decision = await router.select(phase, opts.prompt || '');
  return {
    provider: decision.model.provider,
    model: decision.model.id,
    profile: profile.name,
    reason: decision.reason,
  };
}
