/**
 * Token Refresh
 * Wraps existing Tauri refresh_anthropic_token / refresh_openai_token commands
 */

import { invoke } from '@tauri-apps/api/core';
import type { AuthProfile, OAuthCredential, GeminiOAuthCredential } from './types';
import { REFRESH_BUFFER_MS } from './constants';
import { getStore, saveStore } from './store';

interface RefreshResult {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
}

/** Check if an OAuth credential needs refresh */
export function needsRefresh(credential: OAuthCredential | GeminiOAuthCredential): boolean {
  return Date.now() + REFRESH_BUFFER_MS >= credential.expiresAt;
}

/** Check if an OAuth credential is fully expired */
export function isExpired(credential: OAuthCredential | GeminiOAuthCredential): boolean {
  return Date.now() >= credential.expiresAt;
}

/**
 * Refresh an OAuth profile's token
 * Returns the updated profile, or throws on failure
 */
export async function refreshProfile(profileId: string): Promise<AuthProfile> {
  const store = getStore();
  const profile = store.profiles[profileId];
  if (!profile) throw new Error(`Profile not found: ${profileId}`);
  if (profile.credential.type !== 'oauth' && profile.credential.type !== 'gemini_oauth') {
    throw new Error(`Profile ${profileId} is not OAuth`);
  }

  const credential = profile.credential;
  if (!credential.refreshToken) {
    throw new Error(`No refresh token for profile ${profileId}`);
  }

  console.log(`[AuthRefresh] Refreshing ${profileId}...`);

  try {
    if (credential.type === 'gemini_oauth') {
      // Gemini uses its own refresh endpoint
      const newTokens = await invoke<RefreshResult>('refresh_gemini_token', {
        refreshToken: credential.refreshToken,
      });

      profile.credential = {
        type: 'gemini_oauth',
        accessToken: newTokens.access_token,
        refreshToken: newTokens.refresh_token || credential.refreshToken,
        expiresAt: newTokens.expires_at,
        projectId: credential.projectId,
        email: credential.email,
      };
    } else {
      const newTokens = profile.provider === 'anthropic'
        ? await invoke<RefreshResult>('refresh_anthropic_token', { refreshToken: credential.refreshToken })
        : await invoke<RefreshResult>('refresh_openai_token', { refreshToken: credential.refreshToken });

      profile.credential = {
        type: 'oauth',
        accessToken: newTokens.access_token,
        refreshToken: newTokens.refresh_token || credential.refreshToken,
        expiresAt: newTokens.expires_at,
      };
    }

    profile.lastUsed = Date.now();
    // Reset fail count on successful refresh
    profile.failCount = 0;
    profile.cooldownUntil = undefined;

    saveStore();
    const expiresAt = profile.credential.type === 'gemini_oauth' || profile.credential.type === 'oauth'
      ? profile.credential.expiresAt : 0;
    console.log(`[AuthRefresh] ${profileId} refreshed successfully, expires:`, new Date(expiresAt).toISOString());
    return profile;
  } catch (err) {
    console.error(`[AuthRefresh] Failed to refresh ${profileId}:`, err);
    // Mark as failed but don't delete — user can reconnect
    profile.failCount += 1;
    saveStore();
    throw err;
  }
}

/**
 * Proactively refresh all near-expiry OAuth profiles
 */
export async function refreshExpiring(): Promise<void> {
  const store = getStore();
  for (const profile of Object.values(store.profiles)) {
    if (profile.credential.type !== 'oauth') continue;
    if (!needsRefresh(profile.credential)) continue;

    try {
      await refreshProfile(profile.id);
    } catch (err) {
      console.warn(`[AuthRefresh] Proactive refresh failed for ${profile.id}:`, err);
    }
  }
}
