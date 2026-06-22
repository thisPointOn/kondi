/**
 * Pre-flight model validation for council launches.
 *
 * A persona can carry a model that the user's account/plan no longer accepts —
 * e.g. a Codex/ChatGPT account rejecting a stale `gpt-5.x-codex` SKU, or a model
 * that was removed from the catalog after a `codex update`. Running the council
 * with such a model fails mid-deliberation with a cryptic provider error.
 *
 * This validates every persona's model BEFORE the deliberation starts, against:
 *   1. the live catalog (`ALL_MODELS`) — an unknown id means the model was
 *      retired/renamed, and
 *   2. the probe status (`isModelBroken`) — a model a prior call definitively
 *      rejected (CLAUDE.md rule #14).
 *
 * Unavailable models are swapped for a working one — same provider first, then a
 * cheap API fallback — so the council runs instead of crashing. Routed
 * pseudo-models (`route:*`) are resolved later in `llm-router` and are left as-is.
 */
import { ALL_MODELS } from '../config/models';
import { isModelBroken } from '../services/modelProbe';
import type { Council } from './types';

export interface ModelSubstitution {
  persona: string;
  from: string;
  to: string;
  provider: string;
}

/** Cheap-first fallback order when a persona's own provider can't be used. */
const FALLBACK_PROVIDERS = ['google', 'deepseek', 'anthropic-api', 'openai-api', 'xai', 'zai', 'anthropic-cli', 'openai-cli'];

/** A configured-providers map (id → enabled). When absent, treat all as usable. */
type Configured = Record<string, boolean> | undefined;

function usable(provider: string, configured: Configured): boolean {
  // No map → can't tell, don't block on configuration (catalog/probe still apply).
  return configured ? !!configured[provider] : true;
}

function pickWorking(provider: string, configured: Configured): { provider: string; model: string } | null {
  const ok = (prov: string) =>
    usable(prov, configured) && ALL_MODELS.some((m) => m.provider === prov && !isModelBroken(m.id));
  const first = (prov: string) => {
    const cand = ALL_MODELS.filter((m) => m.provider === prov && !isModelBroken(m.id));
    return cand.find((m) => m.featured) || cand[0];
  };
  // Prefer the persona's own provider when it's configured + has a working model.
  if (ok(provider)) return { provider, model: first(provider).id };
  for (const prov of FALLBACK_PROVIDERS) {
    if (ok(prov)) return { provider: prov, model: first(prov).id };
  }
  return null;
}

/**
 * Validate + repair a council's persona models in place. Returns the list of
 * substitutions made (empty = everything was already available). A model is
 * swapped when it is unknown (catalog-removed), proven-broken (probe), OR its
 * provider isn't configured — so a council can't launch into a provider the user
 * hasn't set up (e.g. a template persona hardcoded to `openai-api` on a machine
 * with only Gemini). Throws only if NO working, configured model exists at all.
 */
export function validateCouncilModels(council: Council, configured?: Configured): ModelSubstitution[] {
  const subs: ModelSubstitution[] = [];
  for (const p of council.personas) {
    // Routed pseudo-models resolve to a concrete model at dispatch time.
    if (!p.model || p.provider === 'router' || p.model.startsWith('route:')) continue;

    const known = ALL_MODELS.some((m) => m.id === p.model);
    if (known && !isModelBroken(p.model) && usable(p.provider, configured)) continue;

    const repl = pickWorking(p.provider, configured);
    if (!repl) {
      throw new Error(
        `"${p.name}" uses model "${p.model}" (${p.provider}), which isn't available, and no configured provider has a working model. ` +
          `Open Settings → Providers and add an API key (Gemini or DeepSeek are the easiest), then try again.`
      );
    }
    subs.push({ persona: p.name, from: p.model, to: repl.model, provider: repl.provider });
    p.provider = repl.provider;
    p.model = repl.model;
  }
  return subs;
}
