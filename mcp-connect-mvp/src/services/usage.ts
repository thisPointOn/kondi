/**
 * Usage accounting — one place that decides which numbers a completion reports.
 *
 * Clients fill `MessageUsage` from the provider (per-turn usage summed across a
 * tool loop); `billedInputTokens` is the across-turns input sum (incl. cache
 * read/write) and is preferred over `inputTokens` (last turn only). When the
 * provider reported nothing, callers fall back to a chars/4 estimate and say so
 * (`reported: false`) so the ledger/scorecard never presents a guess as a bill.
 */
import type { MessageUsage } from '../types/mcp';

export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

export function pickUsage(
  usage: MessageUsage | undefined,
  estimate: { input: string; output: string },
): { inputTokens: number; outputTokens: number; reported: boolean } {
  const reported = !!usage && ((usage.billedInputTokens || 0) > 0 || (usage.inputTokens || 0) > 0 || (usage.outputTokens || 0) > 0);
  if (!reported) {
    return { inputTokens: estimateTokens(estimate.input), outputTokens: estimateTokens(estimate.output), reported: false };
  }
  const inputTokens = (usage!.billedInputTokens && usage!.billedInputTokens > 0) ? usage!.billedInputTokens : (usage!.inputTokens || 0);
  return { inputTokens, outputTokens: usage!.outputTokens || 0, reported: true };
}
