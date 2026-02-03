/**
 * FlowForge Auth Bridge
 * Bridges OpenClaw's auth-profiles system for credential management
 */

import { ProviderAuthError } from '../core/errors.js';
import { providerRegistry, ProviderUsageStats } from './registry.js';

// ============================================================================
// Auth Profile Types (mirrors OpenClaw auth-profiles/types.ts)
// ============================================================================

export type ApiKeyCredential = {
  type: 'api_key';
  provider: string;
  key: string;
  email?: string;
};

export type TokenCredential = {
  type: 'token';
  provider: string;
  token: string;
  expires?: number;
  email?: string;
};

export type OAuthCredential = {
  type: 'oauth';
  provider: string;
  access: string;
  refresh: string;
  expires: number;
  enterpriseUrl?: string;
  projectId?: string;
  accountId?: string;
  clientId?: string;
  email?: string;
};

export type AuthProfileCredential = ApiKeyCredential | TokenCredential | OAuthCredential;

export type AuthProfileFailureReason =
  | 'auth'
  | 'format'
  | 'rate_limit'
  | 'billing'
  | 'timeout'
  | 'unknown';

export interface ProfileUsageStats {
  lastUsed?: number;
  cooldownUntil?: number;
  disabledUntil?: number;
  disabledReason?: AuthProfileFailureReason;
  errorCount?: number;
  failureCounts?: Partial<Record<AuthProfileFailureReason, number>>;
  lastFailureAt?: number;
}

export interface AuthProfileStore {
  version: number;
  profiles: Record<string, AuthProfileCredential>;
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
  usageStats?: Record<string, ProfileUsageStats>;
}

// ============================================================================
// Auth Bridge Configuration
// ============================================================================

export interface AuthBridgeConfig {
  /** Path to auth store file (if using file-based storage) */
  authStorePath?: string;

  /** Function to load auth store */
  loadStore?: () => Promise<AuthProfileStore | null>;

  /** Function to save auth store */
  saveStore?: (store: AuthProfileStore) => Promise<void>;

  /** Function to refresh OAuth tokens */
  refreshOAuthToken?: (credential: OAuthCredential) => Promise<OAuthCredential>;

  /** Cooldown duration after failures (ms) */
  cooldownDuration?: number;

  /** Token expiry buffer (ms) - refresh if expiring within this time */
  tokenExpiryBuffer?: number;
}

const DEFAULT_CONFIG: Required<Omit<AuthBridgeConfig, 'authStorePath' | 'loadStore' | 'saveStore' | 'refreshOAuthToken'>> = {
  cooldownDuration: 5000,
  tokenExpiryBuffer: 60000, // 1 minute
};

// ============================================================================
// Auth Bridge
// ============================================================================

export class AuthBridge {
  private config: AuthBridgeConfig;
  private store: AuthProfileStore | null = null;
  private initialized = false;

  constructor(config?: AuthBridgeConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the auth bridge
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.config.loadStore) {
      this.store = await this.config.loadStore();
    }

    this.initialized = true;
  }

  /**
   * Set the auth store directly (for in-memory usage)
   */
  setStore(store: AuthProfileStore): void {
    this.store = store;
    this.initialized = true;
  }

  /**
   * Get credential for a provider
   */
  async getCredential(
    providerId: string,
    context?: string
  ): Promise<{ profileId: string; credential: AuthProfileCredential } | null> {
    await this.ensureInitialized();

    if (!this.store) return null;

    // Get profiles for this provider
    const profileIds = this.getProfilesForProvider(providerId, context);

    for (const profileId of profileIds) {
      const profile = this.store.profiles[profileId];
      if (!profile) continue;

      // Check if profile is available
      if (!this.isProfileReady(profileId)) continue;

      // Check if OAuth token needs refresh
      if (profile.type === 'oauth') {
        const refreshed = await this.ensureOAuthFresh(profileId, profile);
        if (refreshed) {
          return { profileId, credential: refreshed };
        }
        continue; // Skip if refresh failed
      }

      // Check if token credential is expired
      if (profile.type === 'token' && profile.expires) {
        if (Date.now() >= profile.expires) continue;
      }

      return { profileId, credential: profile };
    }

    return null;
  }

  /**
   * Get API key for a provider (convenience method)
   */
  async getApiKey(providerId: string, context?: string): Promise<string | null> {
    const result = await this.getCredential(providerId, context);
    if (!result) return null;

    const { credential } = result;
    if (credential.type === 'api_key') {
      return credential.key;
    }
    if (credential.type === 'token') {
      return credential.token;
    }
    if (credential.type === 'oauth') {
      return credential.access;
    }

    return null;
  }

  /**
   * Configure providers from auth store
   */
  async configureProviders(): Promise<void> {
    await this.ensureInitialized();

    if (!this.store) return;

    // Group profiles by provider
    const byProvider = new Map<string, string[]>();
    for (const [profileId, profile] of Object.entries(this.store.profiles)) {
      const providerId = this.mapToProviderId(profile.provider);
      if (!byProvider.has(providerId)) {
        byProvider.set(providerId, []);
      }
      byProvider.get(providerId)!.push(profileId);
    }

    // Configure each provider with first available credential
    for (const [providerId, profileIds] of byProvider) {
      for (const profileId of profileIds) {
        const apiKey = await this.getApiKey(providerId);
        if (apiKey) {
          try {
            providerRegistry.setApiKey(providerId, apiKey);
            break; // Successfully configured
          } catch {
            // Provider doesn't exist, skip
          }
        }
      }
    }
  }

  /**
   * Record successful usage
   */
  recordSuccess(profileId: string, context?: string): void {
    if (!this.store) return;

    const stats = this.getUsageStats(profileId);
    stats.lastUsed = Date.now();
    stats.errorCount = 0;
    stats.cooldownUntil = undefined;

    this.setUsageStats(profileId, stats);

    // Update lastGood for context
    if (context) {
      if (!this.store.lastGood) this.store.lastGood = {};
      this.store.lastGood[context] = profileId;
    }

    this.saveStoreAsync();
  }

  /**
   * Record failure
   */
  recordFailure(profileId: string, reason: AuthProfileFailureReason): void {
    if (!this.store) return;

    const stats = this.getUsageStats(profileId);
    const now = Date.now();

    stats.lastFailureAt = now;
    stats.errorCount = (stats.errorCount || 0) + 1;

    if (!stats.failureCounts) stats.failureCounts = {};
    stats.failureCounts[reason] = (stats.failureCounts[reason] || 0) + 1;

    stats.cooldownUntil = now + (this.config.cooldownDuration || DEFAULT_CONFIG.cooldownDuration);

    // Disable if too many errors
    if (stats.errorCount >= 3) {
      stats.disabledUntil = now + 60000; // 1 minute
      stats.disabledReason = reason;
    }

    this.setUsageStats(profileId, stats);
    this.saveStoreAsync();
  }

  /**
   * Add a new profile
   */
  addProfile(profileId: string, credential: AuthProfileCredential): void {
    if (!this.store) {
      this.store = { version: 1, profiles: {} };
    }

    this.store.profiles[profileId] = credential;
    this.saveStoreAsync();
  }

  /**
   * Remove a profile
   */
  removeProfile(profileId: string): void {
    if (!this.store) return;

    delete this.store.profiles[profileId];
    if (this.store.usageStats) {
      delete this.store.usageStats[profileId];
    }

    this.saveStoreAsync();
  }

  /**
   * Get all profiles
   */
  getProfiles(): Record<string, AuthProfileCredential> {
    return this.store?.profiles || {};
  }

  /**
   * Get profiles for a specific provider
   */
  getProviderProfiles(providerId: string): Array<{ profileId: string; credential: AuthProfileCredential }> {
    if (!this.store) return [];

    const results: Array<{ profileId: string; credential: AuthProfileCredential }> = [];

    for (const [profileId, credential] of Object.entries(this.store.profiles)) {
      if (this.mapToProviderId(credential.provider) === providerId) {
        results.push({ profileId, credential });
      }
    }

    return results;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private getProfilesForProvider(providerId: string, context?: string): string[] {
    if (!this.store) return [];

    const profiles: string[] = [];

    // Check for context-specific order
    if (context && this.store.order?.[context]) {
      profiles.push(...this.store.order[context]);
    }

    // Check last good for context
    if (context && this.store.lastGood?.[context]) {
      const lastGood = this.store.lastGood[context];
      if (!profiles.includes(lastGood)) {
        profiles.unshift(lastGood);
      }
    }

    // Add all profiles for this provider
    for (const [profileId, credential] of Object.entries(this.store.profiles)) {
      if (this.mapToProviderId(credential.provider) === providerId) {
        if (!profiles.includes(profileId)) {
          profiles.push(profileId);
        }
      }
    }

    return profiles;
  }

  private mapToProviderId(provider: string): string {
    // Map common provider names to our standard IDs
    const map: Record<string, string> = {
      anthropic: 'anthropic',
      claude: 'anthropic',
      openai: 'openai',
      'gpt-4': 'openai',
      chatgpt: 'openai',
    };

    return map[provider.toLowerCase()] || provider.toLowerCase();
  }

  private isProfileReady(profileId: string): boolean {
    const stats = this.getUsageStats(profileId);
    const now = Date.now();

    if (stats.disabledUntil && stats.disabledUntil > now) {
      return false;
    }

    if (stats.cooldownUntil && stats.cooldownUntil > now) {
      return false;
    }

    return true;
  }

  private getUsageStats(profileId: string): ProfileUsageStats {
    if (!this.store) return {};
    if (!this.store.usageStats) this.store.usageStats = {};
    if (!this.store.usageStats[profileId]) this.store.usageStats[profileId] = {};
    return this.store.usageStats[profileId];
  }

  private setUsageStats(profileId: string, stats: ProfileUsageStats): void {
    if (!this.store) return;
    if (!this.store.usageStats) this.store.usageStats = {};
    this.store.usageStats[profileId] = stats;
  }

  private async ensureOAuthFresh(
    profileId: string,
    credential: OAuthCredential
  ): Promise<OAuthCredential | null> {
    const buffer = this.config.tokenExpiryBuffer || DEFAULT_CONFIG.tokenExpiryBuffer;
    const now = Date.now();

    // Check if token needs refresh
    if (credential.expires > now + buffer) {
      return credential; // Still fresh
    }

    // Need to refresh
    if (!this.config.refreshOAuthToken) {
      // No refresh function, mark as unusable
      this.recordFailure(profileId, 'auth');
      return null;
    }

    try {
      const refreshed = await this.config.refreshOAuthToken(credential);

      // Update stored credential
      if (this.store) {
        this.store.profiles[profileId] = refreshed;
        await this.saveStoreAsync();
      }

      return refreshed;
    } catch (error) {
      this.recordFailure(profileId, 'auth');
      return null;
    }
  }

  private async saveStoreAsync(): Promise<void> {
    if (!this.store || !this.config.saveStore) return;

    try {
      await this.config.saveStore(this.store);
    } catch {
      // Ignore save errors
    }
  }
}

// ============================================================================
// Default Instance
// ============================================================================

export const authBridge = new AuthBridge();

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Initialize auth bridge with OpenClaw-compatible store loader
 */
export async function initializeAuthBridge(config: AuthBridgeConfig): Promise<AuthBridge> {
  const bridge = new AuthBridge(config);
  await bridge.initialize();
  return bridge;
}

/**
 * Configure all providers from auth store
 */
export async function configureProvidersFromAuth(bridge?: AuthBridge): Promise<void> {
  const b = bridge || authBridge;
  await b.configureProviders();
}

/**
 * Get API key for a provider, falling back to environment variable
 */
export async function getApiKeyWithFallback(
  providerId: string,
  envVar?: string
): Promise<string | null> {
  // Try auth bridge first
  const fromBridge = await authBridge.getApiKey(providerId);
  if (fromBridge) return fromBridge;

  // Fall back to environment variable
  if (envVar && typeof process !== 'undefined' && process.env) {
    return process.env[envVar] || null;
  }

  return null;
}
