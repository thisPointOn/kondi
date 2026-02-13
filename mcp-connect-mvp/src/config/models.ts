/**
 * Central model configuration
 * Single source of truth for all LLM model definitions across the app
 *
 * IMPORTANT: CLI models (subscription-based) and API models are DIFFERENT.
 * CLI tools like Claude Code and Codex have access to different/newer models
 * than what's available via direct API access.
 */

export type ModelProvider =
  | 'anthropic-api'    // Direct Anthropic API (requires API key)
  | 'anthropic-cli'    // Claude Code CLI (subscription-based)
  | 'openai-api'       // Direct OpenAI API (requires API key)
  | 'openai-cli'       // Codex CLI (subscription-based)
  | 'deepseek'
  | 'google';

/** Legacy provider names for backwards compatibility */
export type LegacyProvider = 'anthropic' | 'openai';

export interface ModelDefinition {
  id: string;
  name: string;
  provider: ModelProvider;
  contextWindow: number;
  capabilities: ('text' | 'vision' | 'code' | 'reasoning')[];
  /** Cost per 1K input tokens in USD */
  inputCostPer1K: number;
  /** Cost per 1K output tokens in USD */
  outputCostPer1K: number;
  /** Approximate cost per message for display */
  costDisplay: string;
  /** Whether this model is recommended/featured */
  featured?: boolean;
  /** Model tier for sorting: 1=frontier, 2=standard, 3=mini/fast */
  tier: 1 | 2 | 3;
}

// ============================================================================
// Anthropic API Models (Direct API key access)
// ============================================================================
export const ANTHROPIC_API_MODELS: ModelDefinition[] = [
  {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic-api',
    contextWindow: 200000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.003,
    outputCostPer1K: 0.015,
    costDisplay: '~$0.005/msg',
    featured: true,
    tier: 1,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic-api',
    contextWindow: 200000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.001,
    outputCostPer1K: 0.005,
    costDisplay: '~$0.002/msg',
    tier: 3,
  },
  {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    provider: 'anthropic-api',
    contextWindow: 200000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.003,
    outputCostPer1K: 0.015,
    costDisplay: '~$0.005/msg',
    tier: 2,
  },
];

// ============================================================================
// Anthropic CLI Models (Claude Code subscription - newer models)
// ============================================================================
export const ANTHROPIC_CLI_MODELS: ModelDefinition[] = [
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6 (Latest)',
    provider: 'anthropic-cli',
    contextWindow: 200000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.005,
    outputCostPer1K: 0.025,
    costDisplay: '~$0.01/msg',
    featured: true,
    tier: 1,
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic-cli',
    contextWindow: 200000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.003,
    outputCostPer1K: 0.015,
    costDisplay: '~$0.005/msg',
    featured: true,
    tier: 2,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic-cli',
    contextWindow: 200000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.001,
    outputCostPer1K: 0.005,
    costDisplay: '~$0.002/msg',
    tier: 3,
  },
  {
    id: 'claude-opus-4-5-20251101',
    name: 'Claude Opus 4.5',
    provider: 'anthropic-cli',
    contextWindow: 200000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.005,
    outputCostPer1K: 0.025,
    costDisplay: '~$0.01/msg',
    tier: 1,
  },
  {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    provider: 'anthropic-cli',
    contextWindow: 200000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.003,
    outputCostPer1K: 0.015,
    costDisplay: '~$0.005/msg',
    tier: 2,
  },
];

// ============================================================================
// OpenAI API Models (Direct API key access)
// ============================================================================
export const OPENAI_API_MODELS: ModelDefinition[] = [
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai-api',
    contextWindow: 128000,
    capabilities: ['text', 'vision', 'code'],
    inputCostPer1K: 0.005,
    outputCostPer1K: 0.015,
    costDisplay: '~$0.01/msg',
    featured: true,
    tier: 1,
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai-api',
    contextWindow: 128000,
    capabilities: ['text', 'code'],
    inputCostPer1K: 0.00015,
    outputCostPer1K: 0.0006,
    costDisplay: '~$0.001/msg',
    featured: true,
    tier: 3,
  },
  {
    id: 'gpt-4-turbo',
    name: 'GPT-4 Turbo',
    provider: 'openai-api',
    contextWindow: 128000,
    capabilities: ['text', 'vision', 'code'],
    inputCostPer1K: 0.01,
    outputCostPer1K: 0.03,
    costDisplay: '~$0.02/msg',
    tier: 2,
  },
  {
    id: 'o1-preview',
    name: 'o1 Preview (Reasoning)',
    provider: 'openai-api',
    contextWindow: 128000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0.015,
    outputCostPer1K: 0.06,
    costDisplay: '~$0.03/msg',
    tier: 1,
  },
  {
    id: 'o1-mini',
    name: 'o1 Mini (Reasoning)',
    provider: 'openai-api',
    contextWindow: 128000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0.003,
    outputCostPer1K: 0.012,
    costDisplay: '~$0.005/msg',
    tier: 2,
  },
  {
    id: 'gpt-3.5-turbo',
    name: 'GPT-3.5 Turbo',
    provider: 'openai-api',
    contextWindow: 16385,
    capabilities: ['text', 'code'],
    inputCostPer1K: 0.0005,
    outputCostPer1K: 0.0015,
    costDisplay: '~$0.001/msg',
    tier: 3,
  },
];

// ============================================================================
// OpenAI CLI Models (ChatGPT subscription - newer models)
// ============================================================================
export const OPENAI_CLI_MODELS: ModelDefinition[] = [
  {
    id: 'gpt-5.2',
    name: 'GPT-5.2 (Latest Frontier)',
    provider: 'openai-cli',
    contextWindow: 192000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.01,
    outputCostPer1K: 0.03,
    costDisplay: '~$0.02/msg',
    featured: true,
    tier: 1,
  },
  {
    id: 'gpt-5.2-codex',
    name: 'GPT-5.2 Codex (Agentic)',
    provider: 'openai-cli',
    contextWindow: 192000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0.01,
    outputCostPer1K: 0.03,
    costDisplay: '~$0.02/msg',
    featured: true,
    tier: 1,
  },
  {
    id: 'gpt-5.1-codex-max',
    name: 'GPT-5.1 Codex Max',
    provider: 'openai-cli',
    contextWindow: 192000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0.008,
    outputCostPer1K: 0.024,
    costDisplay: '~$0.015/msg',
    tier: 1,
  },
  {
    id: 'gpt-5.1-codex-mini',
    name: 'GPT-5.1 Codex Mini',
    provider: 'openai-cli',
    contextWindow: 128000,
    capabilities: ['text', 'code'],
    inputCostPer1K: 0.002,
    outputCostPer1K: 0.006,
    costDisplay: '~$0.003/msg',
    tier: 3,
  },
  {
    id: 'o3-mini',
    name: 'o3 Mini (Reasoning)',
    provider: 'openai-cli',
    contextWindow: 200000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0.0011,
    outputCostPer1K: 0.0044,
    costDisplay: '~$0.002/msg',
    tier: 2,
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai-cli',
    contextWindow: 128000,
    capabilities: ['text', 'vision', 'code'],
    inputCostPer1K: 0.005,
    outputCostPer1K: 0.015,
    costDisplay: '~$0.01/msg',
    tier: 2,
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai-cli',
    contextWindow: 128000,
    capabilities: ['text', 'code'],
    inputCostPer1K: 0.00015,
    outputCostPer1K: 0.0006,
    costDisplay: '~$0.001/msg',
    tier: 3,
  },
];

// ============================================================================
// DeepSeek Models
// ============================================================================
export const DEEPSEEK_MODELS: ModelDefinition[] = [
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek R1',
    provider: 'deepseek',
    contextWindow: 64000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0.00055,
    outputCostPer1K: 0.00219,
    costDisplay: '~$0.002/msg',
    featured: true,
    tier: 1,
  },
  {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    provider: 'deepseek',
    contextWindow: 64000,
    capabilities: ['text', 'code'],
    inputCostPer1K: 0.00014,
    outputCostPer1K: 0.00028,
    costDisplay: '~$0.0003/msg',
    tier: 2,
  },
];

// ============================================================================
// Google Models
// ============================================================================
export const GOOGLE_MODELS: ModelDefinition[] = [
  {
    id: 'gemini-2.0-flash-exp',
    name: 'Gemini 2.0 Flash',
    provider: 'google',
    contextWindow: 1048576,
    capabilities: ['text', 'vision', 'code'],
    inputCostPer1K: 0.00035,
    outputCostPer1K: 0.00105,
    costDisplay: '~$0.001/msg',
    featured: true,
    tier: 2,
  },
  {
    id: 'gemini-1.5-pro',
    name: 'Gemini 1.5 Pro',
    provider: 'google',
    contextWindow: 2097152,
    capabilities: ['text', 'vision', 'code'],
    inputCostPer1K: 0.00125,
    outputCostPer1K: 0.005,
    costDisplay: '~$0.003/msg',
    tier: 2,
  },
  {
    id: 'gemini-1.5-flash',
    name: 'Gemini 1.5 Flash',
    provider: 'google',
    contextWindow: 1048576,
    capabilities: ['text', 'vision', 'code'],
    inputCostPer1K: 0.000075,
    outputCostPer1K: 0.0003,
    costDisplay: '~$0.0002/msg',
    tier: 3,
  },
];

// ============================================================================
// Combined & Helper Functions
// ============================================================================

/** All available models across all providers */
export const ALL_MODELS: ModelDefinition[] = [
  ...ANTHROPIC_API_MODELS,
  ...ANTHROPIC_CLI_MODELS,
  ...OPENAI_API_MODELS,
  ...OPENAI_CLI_MODELS,
  ...DEEPSEEK_MODELS,
  ...GOOGLE_MODELS,
];

/** Get models by provider */
export function getModelsByProvider(provider: ModelProvider): ModelDefinition[] {
  return ALL_MODELS.filter(m => m.provider === provider);
}

/** Get featured/recommended models */
export function getFeaturedModels(): ModelDefinition[] {
  return ALL_MODELS.filter(m => m.featured);
}

/** Get a model by ID (searches all providers) */
export function getModelById(id: string): ModelDefinition | undefined {
  return ALL_MODELS.find(m => m.id === id);
}

/** Get cost rates for a model (for orchestrator cost calculation) */
export function getModelCostRates(modelId: string): { input: number; output: number } {
  const model = getModelById(modelId);
  if (model) {
    return { input: model.inputCostPer1K, output: model.outputCostPer1K };
  }
  // Default fallback rates
  return { input: 0.01, output: 0.03 };
}

/**
 * Get models formatted for the AddPersonaModal dropdown
 * Includes both API and CLI models, sorted by provider then by tier
 */
export function getModelsForPersonaSelector(): Array<{
  id: string;
  name: string;
  provider: string;
  cost: string;
}> {
  // For council, we want to show all usable models grouped logically
  // We'll use a display provider name that's cleaner
  const getDisplayProvider = (provider: ModelProvider): string => {
    switch (provider) {
      case 'anthropic-api': return 'anthropic';
      case 'anthropic-cli': return 'anthropic-cli';
      case 'openai-api': return 'openai';
      case 'openai-cli': return 'openai-cli';
      default: return provider;
    }
  };

  const providerOrder: Record<string, number> = {
    'anthropic-cli': 0,
    'anthropic-api': 1,
    'openai-cli': 2,
    'openai-api': 3,
    'deepseek': 4,
    'google': 5,
  };

  return ALL_MODELS
    .filter(m => m.provider !== 'google') // Google not yet supported in council
    .sort((a, b) => {
      // Sort by provider first, then by tier
      const aOrder = providerOrder[a.provider] ?? 99;
      const bOrder = providerOrder[b.provider] ?? 99;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.tier - b.tier;
    })
    .map(m => ({
      id: m.id,
      name: m.name,
      provider: getDisplayProvider(m.provider),
      cost: m.costDisplay,
    }));
}

/**
 * Get models formatted for the LLM Provider settings panel
 */
export function getModelsForProviderSettings(provider: ModelProvider): Array<{
  id: string;
  name: string;
  contextWindow: number;
  capabilities: string[];
}> {
  return getModelsByProvider(provider).map(m => ({
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    capabilities: m.capabilities,
  }));
}

/**
 * Build cost lookup table for orchestrator (backwards compatible)
 */
export function getCostPer1KTokens(): Record<string, { input: number; output: number }> {
  const result: Record<string, { input: number; output: number }> = {};
  for (const model of ALL_MODELS) {
    result[model.id] = { input: model.inputCostPer1K, output: model.outputCostPer1K };
  }
  return result;
}

/**
 * Map legacy provider names to the appropriate model provider based on auth method
 */
export function resolveProvider(
  legacyProvider: 'anthropic' | 'openai',
  authMethod: 'api' | 'cli' | 'oauth'
): ModelProvider {
  if (legacyProvider === 'anthropic') {
    return authMethod === 'cli' ? 'anthropic-cli' : 'anthropic-api';
  }
  return authMethod === 'cli' ? 'openai-cli' : 'openai-api';
}
