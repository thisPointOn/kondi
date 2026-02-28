/**
 * Credential Resolution
 * Resolves the best available credential for a provider,
 * handling rotation, cooldown, and auto-refresh
 */

import type { AuthProvider, ResolvedCredential } from './types';
import { getStore } from './store';
import { getNextUsableProfile } from './rotation';
import { needsRefresh, refreshProfile } from './refresh';
import { getCredentialKey } from './profiles';
import { ANTHROPIC_OAUTH_PREFIX, JWT_PREFIX, OAUTH_BETAS, API_KEY_BETAS } from './constants';

/**
 * Resolve the best available API key/token for a provider.
 * If preferredProfileId is given, ONLY that profile is used (no fallback).
 * Otherwise walks the profile order, skips cooled-down profiles, auto-refreshes expired OAuth.
 * Returns null if no usable credential is found.
 */
export async function resolveApiKey(provider: AuthProvider, preferredProfileId?: string): Promise<ResolvedCredential | null> {
  const store = getStore();

  // If a specific profile is requested, use ONLY that profile — no fallback
  if (preferredProfileId) {
    const profile = store.profiles[preferredProfileId];
    if (!profile) return null;

    // Auto-refresh if needed
    if ((profile.credential.type === 'oauth' || profile.credential.type === 'gemini_oauth') && needsRefresh(profile.credential)) {
      try {
        const refreshed = await refreshProfile(preferredProfileId);
        return {
          profileId: preferredProfileId,
          credential: refreshed.credential,
          apiKey: getCredentialKey(refreshed.credential),
        };
      } catch {
        // Refresh failed — no fallback when a specific profile is requested
        return null;
      }
    }

    return {
      profileId: preferredProfileId,
      credential: profile.credential,
      apiKey: getCredentialKey(profile.credential),
    };
  }

  // No preference — use rotation to pick best available profile
  const profileId = getNextUsableProfile(provider);
  if (!profileId) return null;

  const profile = store.profiles[profileId];
  if (!profile) return null;

  // Auto-refresh OAuth/Gemini OAuth if needed
  if ((profile.credential.type === 'oauth' || profile.credential.type === 'gemini_oauth') && needsRefresh(profile.credential)) {
    try {
      const refreshed = await refreshProfile(profileId);
      return {
        profileId,
        credential: refreshed.credential,
        apiKey: getCredentialKey(refreshed.credential),
      };
    } catch {
      // Refresh failed — try next profile
      const nextId = getNextUsableProfile(provider);
      if (nextId && nextId !== profileId) {
        const nextProfile = store.profiles[nextId];
        if (nextProfile) {
          return {
            profileId: nextId,
            credential: nextProfile.credential,
            apiKey: getCredentialKey(nextProfile.credential),
          };
        }
      }
      return null;
    }
  }

  return {
    profileId,
    credential: profile.credential,
    apiKey: getCredentialKey(profile.credential),
  };
}

/**
 * Synchronous resolve — does NOT auto-refresh.
 * Used when you need a credential immediately without async.
 */
export function resolveApiKeySync(provider: AuthProvider): ResolvedCredential | null {
  const profileId = getNextUsableProfile(provider);
  if (!profileId) return null;

  const store = getStore();
  const profile = store.profiles[profileId];
  if (!profile) return null;

  return {
    profileId,
    credential: profile.credential,
    apiKey: getCredentialKey(profile.credential),
  };
}

/**
 * Detect whether a token is an OAuth token (needs Bearer auth + OAuth betas)
 */
export function isOAuthToken(token: string): boolean {
  return token.includes(ANTHROPIC_OAUTH_PREFIX) || token.startsWith(JWT_PREFIX);
}

/**
 * Get the appropriate beta headers for a token
 */
export function getBetasForToken(token: string): string[] {
  return isOAuthToken(token) ? [...OAUTH_BETAS] : [...API_KEY_BETAS];
}
