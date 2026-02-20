/**
 * Auth Profile Store
 * Persists auth profiles to localStorage with migration from legacy keys
 */

import type { AuthProfile, AuthProfileStoreData, AuthProvider } from './types';
import { STORAGE_KEY, LEGACY_AUTH_PROFILES_KEY, LEGACY_API_KEYS_KEY, PROFILE_IDS } from './constants';

function createEmptyStore(): AuthProfileStoreData {
  return {
    version: 1,
    profiles: {},
    order: { anthropic: [], openai: [] },
    lastGood: { anthropic: null, openai: null },
    usageStats: {},
  };
}

let storeData: AuthProfileStoreData = createEmptyStore();

/** Load store from localStorage, migrating legacy data if needed */
export function loadStore(): AuthProfileStoreData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AuthProfileStoreData;
      if (parsed.version === 1) {
        storeData = parsed;
        console.log('[AuthProfileStore] Loaded', Object.keys(parsed.profiles).length, 'profiles');
        return storeData;
      }
    }
  } catch (e) {
    console.error('[AuthProfileStore] Failed to load:', e);
  }

  // No existing store — try migration
  storeData = createEmptyStore();
  migrateFromLegacy();
  return storeData;
}

/** Save current store to localStorage */
export function saveStore(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(storeData));
  } catch (e) {
    // Quota exceeded — try to recover
    console.error('[AuthProfileStore] Save failed:', e);
    try {
      // Clear old usage stats to free space
      storeData.usageStats = {};
      localStorage.setItem(STORAGE_KEY, JSON.stringify(storeData));
    } catch {
      console.error('[AuthProfileStore] Save failed even after cleanup');
    }
  }
}

/** Get the current in-memory store data */
export function getStore(): AuthProfileStoreData {
  return storeData;
}

/** Replace the entire store (for testing or bulk updates) */
export function setStore(data: AuthProfileStoreData): void {
  storeData = data;
  saveStore();
}

/** Migrate from legacy localStorage keys */
function migrateFromLegacy(): void {
  let migrated = false;

  // Migrate from kondi-auth-profiles (oauthService tokens)
  try {
    const raw = localStorage.getItem(LEGACY_AUTH_PROFILES_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      const profiles = data.profiles || {};

      for (const [key, profile] of Object.entries(profiles) as [string, any][]) {
        if (key === 'anthropic' && profile.tokens?.access_token) {
          const profileId = PROFILE_IDS.anthropicOAuth;
          storeData.profiles[profileId] = {
            id: profileId,
            provider: 'anthropic',
            credential: {
              type: 'oauth',
              accessToken: profile.tokens.access_token,
              refreshToken: profile.tokens.refresh_token || '',
              expiresAt: profile.tokens.expires_at || 0,
            },
            label: 'OAuth (browser)',
            createdAt: profile.createdAt ? new Date(profile.createdAt).getTime() : Date.now(),
            failCount: 0,
            successCount: 0,
          };
          storeData.order.anthropic.push(profileId);
          migrated = true;
          console.log('[AuthProfileStore] Migrated Anthropic OAuth from legacy');
        }

        if (key === 'openai' && profile.tokens?.access_token) {
          const profileId = PROFILE_IDS.openaiOAuth;
          storeData.profiles[profileId] = {
            id: profileId,
            provider: 'openai',
            credential: {
              type: 'oauth',
              accessToken: profile.tokens.access_token,
              refreshToken: profile.tokens.refresh_token || '',
              expiresAt: profile.tokens.expires_at || 0,
            },
            label: 'OAuth (browser)',
            createdAt: profile.createdAt ? new Date(profile.createdAt).getTime() : Date.now(),
            failCount: 0,
            successCount: 0,
          };
          storeData.order.openai.push(profileId);
          migrated = true;
          console.log('[AuthProfileStore] Migrated OpenAI OAuth from legacy');
        }
      }
    }
  } catch (e) {
    console.warn('[AuthProfileStore] Failed to migrate from kondi-auth-profiles:', e);
  }

  // Migrate from mcp-api-keys
  try {
    const raw = localStorage.getItem(LEGACY_API_KEYS_KEY);
    if (raw) {
      const keys = JSON.parse(raw);

      if (keys.anthropic) {
        const profileId = PROFILE_IDS.anthropicApiKey;
        storeData.profiles[profileId] = {
          id: profileId,
          provider: 'anthropic',
          credential: { type: 'api_key', key: keys.anthropic },
          label: 'API Key',
          createdAt: Date.now(),
          failCount: 0,
          successCount: 0,
        };
        if (!storeData.order.anthropic.includes(profileId)) {
          storeData.order.anthropic.push(profileId);
        }
        migrated = true;
        console.log('[AuthProfileStore] Migrated Anthropic API key from legacy');
      }

      if (keys.openai) {
        const profileId = PROFILE_IDS.openaiApiKey;
        storeData.profiles[profileId] = {
          id: profileId,
          provider: 'openai',
          credential: { type: 'api_key', key: keys.openai },
          label: 'API Key',
          createdAt: Date.now(),
          failCount: 0,
          successCount: 0,
        };
        if (!storeData.order.openai.includes(profileId)) {
          storeData.order.openai.push(profileId);
        }
        migrated = true;
        console.log('[AuthProfileStore] Migrated OpenAI API key from legacy');
      }
    }
  } catch (e) {
    console.warn('[AuthProfileStore] Failed to migrate from mcp-api-keys:', e);
  }

  if (migrated) {
    saveStore();
    // Clean up legacy keys
    try {
      localStorage.removeItem(LEGACY_AUTH_PROFILES_KEY);
      console.log('[AuthProfileStore] Removed legacy kondi-auth-profiles');
    } catch { /* ignore */ }
  }
}

// Initialize on import
loadStore();
