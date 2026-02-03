/**
 * FlowForge Provider Registry
 * Manages provider selection, failover, and load balancing
 */

import {
  LLMProvider,
  CompletionParams,
  CompletionResult,
  StreamChunk,
  Model,
  ProviderConfig,
} from './interface.js';
import { AnthropicAdapter } from './anthropic-adapter.js';
import { OpenAIAdapter } from './openai-adapter.js';
import { OllamaAdapter } from './ollama-adapter.js';
import { GeminiAdapter } from './gemini-adapter.js';
import { BedrockAdapter } from './bedrock-adapter.js';
import { CopilotAdapter } from './copilot-adapter.js';
import { OpenAIOAuthAdapter } from './openai-oauth-adapter.js';
import {
  OpenAICompatibleAdapter,
  createOpenRouterAdapter,
  createGroqAdapter,
  createMoonshotAdapter,
  createVeniceAdapter,
  createTogetherAdapter,
  createDeepSeekAdapter,
  createXiaoMiAdapter,
} from './openai-compatible-adapter.js';
import {
  ProviderNotFoundError,
  ProviderUnavailableError,
} from '../core/errors.js';

// ============================================================================
// Provider Usage Stats (mirrors OpenClaw patterns)
// ============================================================================

export interface ProviderUsageStats {
  lastUsed?: number;
  cooldownUntil?: number;
  disabledUntil?: number;
  disabledReason?: ProviderFailureReason;
  errorCount?: number;
  failureCounts?: Partial<Record<ProviderFailureReason, number>>;
  lastFailureAt?: number;
  successCount?: number;
  totalLatency?: number;
  averageLatency?: number;
}

export type ProviderFailureReason =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'server_error'
  | 'unknown';

// ============================================================================
// Registry Configuration
// ============================================================================

export interface RegistryConfig {
  /** Default provider to use */
  defaultProvider: string;

  /** Fallback providers in order of preference */
  fallbackOrder: string[];

  /** Whether to enable automatic failover */
  enableFailover: boolean;

  /** Cooldown duration after error (ms) */
  cooldownDuration: number;

  /** Max errors before disabling provider temporarily */
  maxErrors: number;

  /** Duration to disable provider after max errors (ms) */
  disableDuration: number;
}

const DEFAULT_CONFIG: RegistryConfig = {
  defaultProvider: 'anthropic',
  fallbackOrder: [
    'anthropic',
    'openai',
    'openai-oauth',
    'gemini',
    'copilot',
    'openrouter',
    'groq',
    'together',
    'deepseek',
    'moonshot',
    'venice',
    'xiaomi',
    'ollama',
    'bedrock',
  ],
  enableFailover: true,
  cooldownDuration: 5000,
  maxErrors: 3,
  disableDuration: 60000,
};

// ============================================================================
// Provider Registry
// ============================================================================

export class ProviderRegistry {
  private providers: Map<string, LLMProvider> = new Map();
  private usageStats: Map<string, ProviderUsageStats> = new Map();
  private config: RegistryConfig;
  private lastGood: Map<string, string> = new Map(); // context -> providerId

  constructor(config?: Partial<RegistryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registerDefaultProviders();
  }

  private registerDefaultProviders(): void {
    // Primary providers (API key based)
    this.register(new AnthropicAdapter());
    this.register(new OpenAIAdapter());
    this.register(new GeminiAdapter());

    // OAuth-based providers
    this.register(new OpenAIOAuthAdapter());
    this.register(new CopilotAdapter());

    // OpenAI-compatible providers
    this.register(createOpenRouterAdapter());
    this.register(createGroqAdapter());
    this.register(createTogetherAdapter());
    this.register(createDeepSeekAdapter());
    this.register(createMoonshotAdapter());
    this.register(createVeniceAdapter());
    this.register(createXiaoMiAdapter());

    // Local/self-hosted
    this.register(new OllamaAdapter());

    // Cloud providers (AWS)
    this.register(new BedrockAdapter());
  }

  /**
   * Register a provider
   */
  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
    if (!this.usageStats.has(provider.id)) {
      this.usageStats.set(provider.id, {});
    }
  }

  /**
   * Get a provider by ID
   */
  get(providerId: string): LLMProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new ProviderNotFoundError(providerId);
    }
    return provider;
  }

  /**
   * Get all registered providers
   */
  getAll(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get all available providers (with valid credentials)
   */
  getAvailable(): LLMProvider[] {
    return this.getAll().filter((p) => p.available && this.isProviderReady(p.id));
  }

  /**
   * Set API key for a provider
   */
  setApiKey(providerId: string, apiKey: string): void {
    const provider = this.get(providerId);
    provider.setApiKey(apiKey);
  }

  /**
   * Select the best available provider
   */
  selectProvider(preferredId?: string, context?: string): LLMProvider {
    // Try preferred provider first
    if (preferredId) {
      const preferred = this.providers.get(preferredId);
      if (preferred && preferred.available && this.isProviderReady(preferredId)) {
        return preferred;
      }
    }

    // Try last known good provider for this context
    if (context && this.lastGood.has(context)) {
      const lastGoodId = this.lastGood.get(context)!;
      const lastGoodProvider = this.providers.get(lastGoodId);
      if (lastGoodProvider && lastGoodProvider.available && this.isProviderReady(lastGoodId)) {
        return lastGoodProvider;
      }
    }

    // Try default provider
    const defaultProvider = this.providers.get(this.config.defaultProvider);
    if (
      defaultProvider &&
      defaultProvider.available &&
      this.isProviderReady(this.config.defaultProvider)
    ) {
      return defaultProvider;
    }

    // Try fallback order
    for (const providerId of this.config.fallbackOrder) {
      const provider = this.providers.get(providerId);
      if (provider && provider.available && this.isProviderReady(providerId)) {
        return provider;
      }
    }

    throw new ProviderUnavailableError('all', 'No available providers');
  }

  /**
   * Execute a completion with automatic failover
   */
  async complete(
    params: CompletionParams,
    options?: {
      preferredProvider?: string;
      context?: string;
      maxRetries?: number;
    }
  ): Promise<CompletionResult & { providerId: string }> {
    const maxRetries = options?.maxRetries ?? (this.config.enableFailover ? 2 : 0);
    let lastError: Error | null = null;
    const triedProviders = new Set<string>();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Select provider, avoiding already-tried ones
      let provider: LLMProvider;
      try {
        provider = this.selectProviderExcluding(
          triedProviders,
          options?.preferredProvider,
          options?.context
        );
      } catch {
        break; // No more providers available
      }

      triedProviders.add(provider.id);

      try {
        const result = await provider.complete(params);
        this.recordSuccess(provider.id, options?.context);
        return { ...result, providerId: provider.id };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.recordFailure(provider.id, this.categorizeError(lastError));

        // Don't retry if failover is disabled
        if (!this.config.enableFailover) {
          throw lastError;
        }
      }
    }

    throw lastError || new ProviderUnavailableError('all', 'All providers failed');
  }

  /**
   * Stream a completion with automatic failover
   */
  async *stream(
    params: CompletionParams,
    options?: {
      preferredProvider?: string;
      context?: string;
    }
  ): AsyncIterable<StreamChunk & { providerId?: string }> {
    const provider = this.selectProvider(options?.preferredProvider, options?.context);

    try {
      for await (const chunk of provider.stream(params)) {
        yield { ...chunk, providerId: provider.id };
      }
      this.recordSuccess(provider.id, options?.context);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.recordFailure(provider.id, this.categorizeError(err));
      throw err;
    }
  }

  /**
   * List models from all available providers
   */
  async listAllModels(): Promise<Array<Model & { providerId: string }>> {
    const results: Array<Model & { providerId: string }> = [];

    for (const provider of this.getAvailable()) {
      try {
        const models = await provider.listModels();
        results.push(...models.map((m) => ({ ...m, providerId: provider.id })));
      } catch {
        // Ignore errors, just skip this provider
      }
    }

    return results;
  }

  /**
   * Get provider config
   */
  getProviderConfig(providerId: string): ProviderConfig {
    return this.get(providerId).getConfig();
  }

  /**
   * Get usage stats for a provider
   */
  getUsageStats(providerId: string): ProviderUsageStats {
    return this.usageStats.get(providerId) || {};
  }

  /**
   * Reset usage stats for a provider
   */
  resetUsageStats(providerId: string): void {
    this.usageStats.set(providerId, {});
  }

  /**
   * Update registry configuration
   */
  updateConfig(config: Partial<RegistryConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private selectProviderExcluding(
    excluded: Set<string>,
    preferredId?: string,
    context?: string
  ): LLMProvider {
    // Try preferred if not excluded
    if (preferredId && !excluded.has(preferredId)) {
      const preferred = this.providers.get(preferredId);
      if (preferred && preferred.available && this.isProviderReady(preferredId)) {
        return preferred;
      }
    }

    // Try last good if not excluded
    if (context && this.lastGood.has(context)) {
      const lastGoodId = this.lastGood.get(context)!;
      if (!excluded.has(lastGoodId)) {
        const provider = this.providers.get(lastGoodId);
        if (provider && provider.available && this.isProviderReady(lastGoodId)) {
          return provider;
        }
      }
    }

    // Try fallback order
    for (const providerId of this.config.fallbackOrder) {
      if (excluded.has(providerId)) continue;
      const provider = this.providers.get(providerId);
      if (provider && provider.available && this.isProviderReady(providerId)) {
        return provider;
      }
    }

    throw new ProviderUnavailableError('all', 'No available providers');
  }

  private isProviderReady(providerId: string): boolean {
    const stats = this.usageStats.get(providerId);
    if (!stats) return true;

    const now = Date.now();

    // Check if disabled
    if (stats.disabledUntil && stats.disabledUntil > now) {
      return false;
    }

    // Check cooldown
    if (stats.cooldownUntil && stats.cooldownUntil > now) {
      return false;
    }

    return true;
  }

  private recordSuccess(providerId: string, context?: string): void {
    const stats = this.usageStats.get(providerId) || {};
    stats.lastUsed = Date.now();
    stats.errorCount = 0;
    stats.cooldownUntil = undefined;
    stats.successCount = (stats.successCount || 0) + 1;
    this.usageStats.set(providerId, stats);

    // Update last good for context
    if (context) {
      this.lastGood.set(context, providerId);
    }
  }

  private recordFailure(providerId: string, reason: ProviderFailureReason): void {
    const stats = this.usageStats.get(providerId) || {};
    const now = Date.now();

    stats.lastFailureAt = now;
    stats.errorCount = (stats.errorCount || 0) + 1;

    // Track failure by reason
    if (!stats.failureCounts) stats.failureCounts = {};
    stats.failureCounts[reason] = (stats.failureCounts[reason] || 0) + 1;

    // Apply cooldown
    stats.cooldownUntil = now + this.config.cooldownDuration;

    // Check if should disable
    if (stats.errorCount >= this.config.maxErrors) {
      stats.disabledUntil = now + this.config.disableDuration;
      stats.disabledReason = reason;
    }

    this.usageStats.set(providerId, stats);
  }

  private categorizeError(error: Error): ProviderFailureReason {
    const msg = error.message.toLowerCase();

    if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized')) {
      return 'auth';
    }
    if (msg.includes('429') || msg.includes('rate')) {
      return 'rate_limit';
    }
    if (msg.includes('timeout') || msg.includes('timed out')) {
      return 'timeout';
    }
    if (msg.includes('500') || msg.includes('502') || msg.includes('503')) {
      return 'server_error';
    }

    return 'unknown';
  }
}

// ============================================================================
// Default Registry Instance
// ============================================================================

export const providerRegistry = new ProviderRegistry();

// ============================================================================
// Helper Functions
// ============================================================================

export function getProvider(providerId: string): LLMProvider {
  return providerRegistry.get(providerId);
}

export function selectBestProvider(context?: string): LLMProvider {
  return providerRegistry.selectProvider(undefined, context);
}

export async function completeWithFailover(
  params: CompletionParams,
  preferredProvider?: string
): Promise<CompletionResult> {
  return providerRegistry.complete(params, { preferredProvider });
}
