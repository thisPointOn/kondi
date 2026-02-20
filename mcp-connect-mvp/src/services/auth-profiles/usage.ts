/**
 * Usage Stats
 * Provides read-only access to usage statistics for UI display
 */

import type { AuthProvider, UsageStats } from './types';
import { getStore } from './store';

/** Get usage stats for a specific profile */
export function getProfileStats(profileId: string): UsageStats | undefined {
  return getStore().usageStats[profileId];
}

/** Get aggregated stats for a provider */
export function getProviderStats(provider: AuthProvider): {
  totalCalls: number;
  totalFailures: number;
  successRate: number;
  lastActivity?: number;
} {
  const store = getStore();
  const order = store.order[provider] || [];
  let totalCalls = 0;
  let totalFailures = 0;
  let lastActivity: number | undefined;

  for (const id of order) {
    const stats = store.usageStats[id];
    if (!stats) continue;
    totalCalls += stats.totalCalls;
    totalFailures += stats.totalFailures;
    const latest = Math.max(stats.lastSuccess || 0, stats.lastFailure || 0);
    if (latest > 0 && (!lastActivity || latest > lastActivity)) {
      lastActivity = latest;
    }
  }

  return {
    totalCalls,
    totalFailures,
    successRate: totalCalls > 0 ? Math.round(((totalCalls - totalFailures) / totalCalls) * 100) : 100,
    lastActivity,
  };
}
