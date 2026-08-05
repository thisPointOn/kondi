/**
 * Model Catalog Sync
 *
 * For API providers, the authoritative "what models exist" answer is the
 * provider's own `GET /models` endpoint (the API equivalent of reading the
 * Codex binary's embedded list). This service fetches each configured API
 * provider's live model list and reconciles it against our static catalog
 * (`config/models.ts`) so we can tell when our listings drift:
 *
 *   - confirmed         — catalog ids the provider also lists (good)
 *   - staleInCatalog    — catalog ids the provider does NOT list (suspect; the
 *                         live probe in modelProbe decides whether to hide them)
 *   - missingFromCatalog— chat-ish ids the provider offers that we don't list
 *                         (candidates to add)
 *
 * This is ADVISORY. It never hides a model on its own — "hide only proven-broken"
 * stays the job of modelProbe (a real call must fail). A `/models` list can be
 * incomplete (restricted key scopes, partial catalogs), so a missing listing is
 * a hint, not a verdict.
 */

import type { ModelProvider } from '../config/models';
import { ALL_MODELS } from '../config/models';
import { anthropicClient } from './anthropicClient';
import { openaiClient } from './openaiClient';
import { deepseekClient, xaiClient, zaiClient, moonshotClient, nvidiaRouterClient, ollamaClient } from './openaiCompatibleClient';
import { resolveApiKey, PROFILE_IDS } from './auth-profiles';
import { safeSetItem } from '../utils/safeStorage';

export interface CatalogDiff {
  provider: ModelProvider;
  /** Discovery succeeded (we got a usable live list). */
  ok: boolean;
  /** Raw model ids reported by the provider. */
  live: string[];
  /** Catalog ids the provider also lists. */
  confirmed: string[];
  /** Catalog ids the provider does NOT list (suspect — verify via probe). */
  staleInCatalog: string[];
  /** Chat-capable live ids we don't carry in the catalog (candidates to add). */
  missingFromCatalog: string[];
  error?: string;
}

const STORAGE_KEY = 'kondi-catalog-sync';
const EVENT = 'kondi-catalog-sync-updated';

// Discovery is only meaningful for HTTP API providers. CLI providers are
// verified against their binary + the live probe; Google uses the cloudcode-pa
// OAuth endpoint which has no clean public list, so it's excluded here.
export const DISCOVERY_PROVIDERS: ModelProvider[] = [
  'anthropic-api',
  'openai-api',
  'deepseek',
  'xai',
  'zai',
  'moonshot',
  'nvidia-router',
  'ollama',
];

export function isDiscoverable(provider: string): boolean {
  return (DISCOVERY_PROVIDERS as string[]).includes(provider);
}

// Filter out clearly non-chat SKUs so "new models" stays signal, not noise.
const NON_CHAT = /(embed|whisper|tts|audio|speech|dall[-_]?e|image|moderation|rerank|search|transcrib|realtime|davinci|babbage|^ada|curie|computer-use|guard|clip|^text-|nemoretriever|reward)/i;

async function fetchLiveModels(provider: ModelProvider): Promise<string[]> {
  switch (provider) {
    case 'anthropic-api': {
      const cred = await resolveApiKey('anthropic', PROFILE_IDS.anthropicApiKey);
      if (!cred) throw new Error('No Anthropic API key configured');
      return anthropicClient.listModels(cred.apiKey);
    }
    case 'openai-api': {
      const cred = await resolveApiKey('openai', PROFILE_IDS.openaiApiKey);
      if (!cred) throw new Error('No OpenAI API key configured');
      return openaiClient.listModels(cred.apiKey);
    }
    case 'deepseek':
      return deepseekClient.listModels();
    case 'xai':
      return xaiClient.listModels();
    case 'moonshot':
      return moonshotClient.listModels();
    case 'zai':
      return zaiClient.listModels();
    case 'nvidia-router':
      return nvidiaRouterClient.listModels();
    case 'ollama':
      return (await ollamaClient.discoverModels()).map((m) => m.name);
    default:
      throw new Error(`Catalog discovery not supported for ${provider}`);
  }
}

/** Discover one provider's live models and diff against the catalog. */
export async function syncProviderCatalog(provider: ModelProvider): Promise<CatalogDiff> {
  const catalog = ALL_MODELS.filter((m) => m.provider === provider).map((m) => m.id);
  try {
    const live = await fetchLiveModels(provider);
    if (!live || live.length === 0) {
      return {
        provider, ok: false, live: [], confirmed: [], staleInCatalog: [], missingFromCatalog: [],
        error: 'Provider returned no models (endpoint empty, blocked, or unsupported)',
      };
    }
    const liveSet = new Set(live);
    const catSet = new Set(catalog);
    const confirmed = catalog.filter((id) => liveSet.has(id));
    const staleInCatalog = catalog.filter((id) => !liveSet.has(id));
    const missingFromCatalog = live.filter((id) => !catSet.has(id) && !NON_CHAT.test(id));
    return { provider, ok: true, live, confirmed, staleInCatalog, missingFromCatalog };
  } catch (err) {
    return {
      provider, ok: false, live: [], confirmed: [], staleInCatalog: [], missingFromCatalog: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// Persistence + sweep
// ============================================================================

function persist(diffs: Record<string, CatalogDiff>) {
  try {
    safeSetItem(STORAGE_KEY, JSON.stringify({ at: Date.now(), diffs }));
  } catch {
    // best-effort
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    // no window — fine
  }
}

export function getLastCatalogSync(): { at: number; diffs: Record<string, CatalogDiff> } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Discover + reconcile every discoverable provider in `providers` (defaults to
 * all). Results are persisted and returned.
 */
export async function syncAllCatalogs(providers?: string[]): Promise<CatalogDiff[]> {
  const targets = DISCOVERY_PROVIDERS.filter((p) => !providers || providers.includes(p));
  const results = await Promise.all(targets.map((p) => syncProviderCatalog(p)));
  const map: Record<string, CatalogDiff> = {};
  for (const r of results) map[r.provider] = r;
  persist(map);
  return results;
}
