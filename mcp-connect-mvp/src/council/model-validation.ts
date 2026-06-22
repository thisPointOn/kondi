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

/** Cheap-first fallback order when a persona's own provider has no working model. */
const FALLBACK_PROVIDERS = ['google', 'deepseek', 'anthropic-api', 'openai-api', 'xai', 'zai'];

function pickWorking(provider: string): { provider: string; model: string } | null {
  const same = ALL_MODELS.filter((m) => m.provider === provider && !isModelBroken(m.id));
  if (same.length) return { provider, model: (same.find((m) => m.featured) || same[0]).id };
  for (const prov of FALLBACK_PROVIDERS) {
    const cand = ALL_MODELS.filter((m) => m.provider === prov && !isModelBroken(m.id));
    if (cand.length) return { provider: prov, model: (cand.find((m) => m.featured) || cand[0]).id };
  }
  return null;
}

/**
 * Validate + repair a council's persona models in place. Returns the list of
 * substitutions made (empty = everything was already available). Throws only if
 * a persona's model is unavailable AND no working model is configured at all.
 */
export function validateCouncilModels(council: Council): ModelSubstitution[] {
  const subs: ModelSubstitution[] = [];
  for (const p of council.personas) {
    // Routed pseudo-models resolve to a concrete model at dispatch time.
    if (!p.model || p.provider === 'router' || p.model.startsWith('route:')) continue;

    const known = ALL_MODELS.some((m) => m.id === p.model);
    if (known && !isModelBroken(p.model)) continue;

    const repl = pickWorking(p.provider);
    if (!repl) {
      throw new Error(
        `"${p.name}" uses model "${p.model}", which is unavailable, and no working model is configured. ` +
          `Open Settings → Providers and add an API key (Gemini or DeepSeek are the easiest), then try again.`
      );
    }
    subs.push({ persona: p.name, from: p.model, to: repl.model, provider: repl.provider });
    p.provider = repl.provider;
    p.model = repl.model;
  }
  return subs;
}
