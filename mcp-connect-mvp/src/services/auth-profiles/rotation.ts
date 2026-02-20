/**
 * Profile Rotation & Failover
 * Manages profile ordering, failure tracking, and cooldown
 */

import type { AuthProvider } from './types';
import { getStore, saveStore } from './store';
import { RATE_LIMIT_COOLDOWN_MS, AUTH_ERROR_COOLDOWN_MS, MAX_CONSECUTIVE_FAILURES } from './constants';

/**
 * Report a successful API call for a profile
 */
export function reportSuccess(profileId: string): void {
  const store = getStore();
  const profile = store.profiles[profileId];
  if (!profile) return;

  profile.successCount += 1;
  profile.failCount = 0;
  profile.cooldownUntil = undefined;
  profile.lastUsed = Date.now();

  // Update lastGood
  store.lastGood[profile.provider] = profileId;

  // Update usage stats
  if (!store.usageStats[profileId]) {
    store.usageStats[profileId] = { totalCalls: 0, totalFailures: 0 };
  }
  store.usageStats[profileId].totalCalls += 1;
  store.usageStats[profileId].lastSuccess = Date.now();

  saveStore();
}

/**
 * Report a failed API call for a profile
 * @param httpStatus - HTTP status code (401, 429, etc.)
 */
export function reportFailure(profileId: string, httpStatus?: number): void {
  const store = getStore();
  const profile = store.profiles[profileId];
  if (!profile) return;

  profile.failCount += 1;

  // Determine cooldown based on error type
  if (httpStatus === 429) {
    // Rate limit — short cooldown
    profile.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    console.log(`[AuthRotation] ${profileId} rate limited, cooldown until`, new Date(profile.cooldownUntil).toISOString());
  } else if (httpStatus === 401 || httpStatus === 403) {
    // Auth error — longer cooldown
    profile.cooldownUntil = Date.now() + AUTH_ERROR_COOLDOWN_MS;
    console.log(`[AuthRotation] ${profileId} auth error (${httpStatus}), cooldown until`, new Date(profile.cooldownUntil).toISOString());
  }

  // Update usage stats
  if (!store.usageStats[profileId]) {
    store.usageStats[profileId] = { totalCalls: 0, totalFailures: 0 };
  }
  store.usageStats[profileId].totalCalls += 1;
  store.usageStats[profileId].totalFailures += 1;
  store.usageStats[profileId].lastFailure = Date.now();

  saveStore();
}

/**
 * Check if a profile is currently usable (not cooled down, not dead)
 */
export function isProfileUsable(profileId: string): boolean {
  const store = getStore();
  const profile = store.profiles[profileId];
  if (!profile) return false;

  // Too many failures — considered dead
  if (profile.failCount >= MAX_CONSECUTIVE_FAILURES) return false;

  // In cooldown period
  if (profile.cooldownUntil && Date.now() < profile.cooldownUntil) return false;

  return true;
}

/**
 * Get the next usable profile for a provider, respecting order and cooldowns
 * Prefers lastGood if still usable
 */
export function getNextUsableProfile(provider: AuthProvider): string | null {
  const store = getStore();
  const order = store.order[provider] || [];

  // Try lastGood first
  const lastGood = store.lastGood[provider];
  if (lastGood && order.includes(lastGood) && isProfileUsable(lastGood)) {
    return lastGood;
  }

  // Walk the order list
  for (const id of order) {
    if (isProfileUsable(id)) return id;
  }

  // No usable profiles — check if any have expired cooldowns
  for (const id of order) {
    const profile = store.profiles[id];
    if (!profile) continue;
    if (profile.failCount < MAX_CONSECUTIVE_FAILURES) {
      // Cooldown expired or never set — try it
      return id;
    }
  }

  return null;
}

/**
 * Reset all cooldowns and fail counts for a provider
 * (useful after user manually reconnects/refreshes)
 */
export function resetProvider(provider: AuthProvider): void {
  const store = getStore();
  const order = store.order[provider] || [];
  for (const id of order) {
    const profile = store.profiles[id];
    if (profile) {
      profile.failCount = 0;
      profile.cooldownUntil = undefined;
    }
  }
  saveStore();
}
