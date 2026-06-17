/**
 * Model Registry — catalog of routable models and their capabilities.
 *
 * Ported from kondi-chat, de-Node-ified: instead of reading a YAML file from
 * disk (unavailable in the Tauri webview), the registry is seeded in-memory
 * from kondi's `ALL_MODELS` catalog via `buildRegistryModels()`. The router
 * uses this to know what's available and how much it costs.
 */

import type { ProviderId } from './types';
import { ALL_MODELS, type ModelDefinition, type ModelProvider } from '../config/models';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Open-ended capability tags (e.g. 'planning', 'coding', 'summarization'). */
export type ModelCapability = string;

export interface ModelEntry {
  /** Unique ID used in API calls (e.g., "claude-sonnet-4-5-20250929") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Short alias for @mentions (unused in kondi UI, kept for parity) */
  alias?: string;
  /** Provider for API routing — a kondi ModelProvider */
  provider: ProviderId;
  /** What this model is good at — ordered by strength */
  capabilities: ModelCapability[];
  /** Cost per 1M input tokens (USD) */
  inputCostPer1M: number;
  /** Cost per 1M output tokens (USD) */
  outputCostPer1M: number;
  /** Context window size in tokens */
  contextWindow: number;
  /** Is this model currently routable? (provider configured) */
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Seeding from kondi's catalog
// ---------------------------------------------------------------------------

/**
 * Derive routing capability tags for a model that didn't declare any
 * `routingCapabilities`, from its coarse `capabilities` + `tier`.
 */
function deriveCapabilities(m: ModelDefinition): string[] {
  const tags = new Set<string>(['general']);
  if (m.capabilities.includes('reasoning')) tags.add('reasoning');
  if (m.capabilities.includes('code')) tags.add('coding');
  if (m.tier === 1) {
    tags.add('planning');
    tags.add('analysis');
    tags.add('code-review');
    if (m.capabilities.includes('reasoning')) tags.add('architecture');
  }
  if (m.tier === 2) tags.add('fast-coding');
  if (m.tier === 3) {
    tags.add('fast-coding');
    tags.add('summarization');
  }
  return [...tags];
}

export interface BuildRegistryOptions {
  /**
   * When provided, only models whose provider is in this set are `enabled`
   * (routable). When omitted, every catalog model is enabled — used in the
   * CLI / headless path where configured-provider state isn't available.
   */
  configuredProviders?: Set<ModelProvider>;
}

/**
 * Translate kondi's `ALL_MODELS` (cost per 1K) into router `ModelEntry`s
 * (cost per 1M), de-duplicating by model id. When a model id appears under
 * multiple providers (e.g. Sonnet under anthropic-api and anthropic-cli),
 * the configured provider wins; otherwise the first occurrence wins.
 */
export function buildRegistryModels(opts: BuildRegistryOptions = {}): ModelEntry[] {
  const { configuredProviders } = opts;
  const byId = new Map<string, ModelEntry>();

  for (const m of ALL_MODELS) {
    const entry: ModelEntry = {
      id: m.id,
      name: m.name,
      provider: m.provider,
      capabilities: m.routingCapabilities && m.routingCapabilities.length > 0
        ? m.routingCapabilities
        : deriveCapabilities(m),
      inputCostPer1M: m.inputCostPer1K * 1000,
      outputCostPer1M: m.outputCostPer1K * 1000,
      contextWindow: m.contextWindow,
      enabled: configuredProviders ? configuredProviders.has(m.provider) : true,
    };

    const existing = byId.get(m.id);
    if (!existing) {
      byId.set(m.id, entry);
      continue;
    }
    // Prefer the variant whose provider is actually configured.
    const existingConfigured = configuredProviders?.has(existing.provider) ?? true;
    const newConfigured = configuredProviders?.has(entry.provider) ?? true;
    if (!existingConfigured && newConfigured) {
      byId.set(m.id, entry);
    }
  }

  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ModelRegistry {
  private models: ModelEntry[];

  constructor(models: ModelEntry[]) {
    this.models = [...models];
  }

  getAll(): ModelEntry[] {
    return [...this.models];
  }

  getEnabled(): ModelEntry[] {
    return this.models.filter(m => m.enabled);
  }

  /** Enabled models are considered available (no async health checks here). */
  getAvailable(): ModelEntry[] {
    return this.getEnabled();
  }

  getById(id: string): ModelEntry | undefined {
    return this.models.find(m => m.id === id);
  }

  getByAlias(alias: string): ModelEntry | undefined {
    const lower = alias.toLowerCase();
    const enabled = this.models.filter(m => m.alias && m.enabled);
    const exact = enabled.find(m => m.alias!.toLowerCase() === lower);
    if (exact) return exact;
    const prefix = enabled.filter(m => m.alias!.toLowerCase().startsWith(lower));
    return prefix.length === 1 ? prefix[0] : undefined;
  }

  /** Models with a capability, sorted cheapest first. Excludes disabled. */
  getByCapability(capability: ModelCapability): ModelEntry[] {
    return this.getAvailable()
      .filter(m => m.capabilities.includes(capability))
      .sort((a, b) => a.inputCostPer1M - b.inputCostPer1M);
  }

  getCheapest(capability: ModelCapability): ModelEntry | undefined {
    return this.getByCapability(capability)[0];
  }

  getBest(capability: ModelCapability): ModelEntry | undefined {
    const models = this.getByCapability(capability);
    return models[models.length - 1];
  }

  add(entry: ModelEntry): void {
    const existing = this.models.findIndex(m => m.id === entry.id);
    if (existing >= 0) this.models[existing] = entry;
    else this.models.push(entry);
  }

  enable(id: string): boolean {
    const model = this.models.find(m => m.id === id);
    if (model) { model.enabled = true; return true; }
    return false;
  }

  disable(id: string): boolean {
    const model = this.models.find(m => m.id === id);
    if (model) { model.enabled = false; return true; }
    return false;
  }
}
