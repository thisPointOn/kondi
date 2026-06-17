/**
 * Lightweight cost estimation for council/pipeline runs.
 *
 * Ledger entries record combined `tokensUsed` (no input/output split and no
 * per-entry model), so cost is attributed via the authoring persona's model
 * and a 50/50 input/output blend. For routed personas (`route:<profile>`) the
 * concrete model isn't recorded on the entry, so the estimate falls back to
 * `getModelCostRates`' default rate — treat routed costs as approximate.
 */

import { getModelCostRates } from '../config/models';

/** Blended USD cost estimate for `tokensUsed` total tokens on `modelId`. */
export function estimateCostUsd(modelId: string | undefined, tokensUsed: number): number {
  if (!tokensUsed || tokensUsed <= 0) return 0;
  const { input, output } = getModelCostRates(modelId || '');
  const blendedPer1K = (input + output) / 2;
  return (tokensUsed / 1000) * blendedPer1K;
}

/** Compact USD formatting for the UI. */
export function formatUsd(n: number): string {
  if (!n || n <= 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}
