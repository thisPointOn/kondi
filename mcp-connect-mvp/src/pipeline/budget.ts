/**
 * Run budget — a hard ceiling on what a pipeline run may spend.
 *
 * `Pipeline.settings.budget` sets limits in USD, tokens and/or minutes. The
 * executor wraps every agent call in a `BudgetMeter`: each call is checked
 * BEFORE it starts and recorded AFTER it returns (cost via `costForCall`, so a
 * provider-reported in/out split prices exactly and an estimate otherwise).
 *
 * Exceeding the budget is an HONEST FAILURE, distinct from a user abort: the
 * council gets an `error` entry (`structured.budget`) and ends `failed`, the
 * step fails, the run stops at the stage boundary, and the scorecard is still
 * written (so the self-improvement loop sees the overspend).
 *
 *   onExceeded: 'finish_call' (default) — the in-flight call completes, the
 *               NEXT call is refused;
 *               'abort_now'  — the meter's signal fires so in-flight calls are
 *               cancelled too (composed into the orchestrators' run signal).
 *
 * Every persona also sees a one-line budget status in its prompt
 * (`formatBudgetLine`) so it can trade depth for finishing.
 */
import type { Persona } from '../council/types';
import type { AgentInvocation, AgentResponse } from '../council/deliberation-orchestrator';
import { costForCall } from '../improve/run-metrics';

export interface RunBudget {
  maxUsd?: number;
  maxTokens?: number;
  maxMinutes?: number;
  onExceeded?: 'finish_call' | 'abort_now';
}

export interface BudgetState {
  usd: number;
  tokens: number;
  calls: number;
  startedAt: number;
  /** Wall-clock minutes at the last tick (so renderers stay pure). */
  elapsedMinutes: number;
  limits: RunBudget;
  exceeded?: { kind: 'usd' | 'tokens' | 'minutes'; at: number; detail: string };
}

export class BudgetExceededError extends Error {
  readonly name = 'BudgetExceededError' as const;
  readonly state: BudgetState;
  constructor(state: BudgetState) {
    super(`Budget exceeded: ${state.exceeded?.detail || 'limit reached'}`);
    this.state = state;
  }
}

export function isBudgetExceededError(e: unknown): e is BudgetExceededError {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'BudgetExceededError';
}

export function hasBudget(b: RunBudget | undefined): boolean {
  return !!b && ((b.maxUsd ?? 0) > 0 || (b.maxTokens ?? 0) > 0 || (b.maxMinutes ?? 0) > 0);
}

export class BudgetMeter {
  readonly state: BudgetState;
  private readonly ac = new AbortController();
  private readonly onTick?: (state: BudgetState) => void;

  constructor(limits: RunBudget, opts: { now?: number; onTick?: (state: BudgetState) => void } = {}) {
    this.state = { usd: 0, tokens: 0, calls: 0, startedAt: opts.now ?? Date.now(), elapsedMinutes: 0, limits };
    this.onTick = opts.onTick;
  }

  /** Fires (with a BudgetExceededError reason) only under `onExceeded: 'abort_now'`. */
  get signal(): AbortSignal { return this.ac.signal; }

  get exceeded(): boolean { return !!this.state.exceeded; }

  /** Minutes elapsed since the run started. */
  elapsedMinutes(now = Date.now()): number { return (now - this.state.startedAt) / 60_000; }

  /** Re-evaluate the limits; returns the breach (if any) and arms the signal. */
  check(now = Date.now()): BudgetState['exceeded'] {
    this.state.elapsedMinutes = this.elapsedMinutes(now);
    if (this.state.exceeded) return this.state.exceeded;
    const { maxUsd, maxTokens, maxMinutes } = this.state.limits;
    let breach: BudgetState['exceeded'];
    if (maxUsd && maxUsd > 0 && this.state.usd >= maxUsd) {
      breach = { kind: 'usd', at: now, detail: `$${this.state.usd.toFixed(4)} spent of a $${maxUsd} budget` };
    } else if (maxTokens && maxTokens > 0 && this.state.tokens >= maxTokens) {
      breach = { kind: 'tokens', at: now, detail: `${this.state.tokens.toLocaleString()} tokens used of a ${maxTokens.toLocaleString()} budget` };
    } else if (maxMinutes && maxMinutes > 0 && this.elapsedMinutes(now) >= maxMinutes) {
      breach = { kind: 'minutes', at: now, detail: `${this.elapsedMinutes(now).toFixed(1)} min elapsed of a ${maxMinutes} min budget` };
    }
    if (breach) {
      this.state.exceeded = breach;
      if (this.state.limits.onExceeded === 'abort_now') this.ac.abort(new BudgetExceededError(this.state));
      this.onTick?.(this.state);
    }
    return breach;
  }

  /** Throw if the budget is already spent (called BEFORE each agent call). */
  assert(now = Date.now()): void {
    if (this.check(now)) throw new BudgetExceededError(this.state);
  }

  /** Record a finished call's spend (called AFTER each agent call). */
  record(model: string | undefined, response: { tokensUsed?: number; inputTokens?: number; outputTokens?: number }, now = Date.now()): void {
    const tokens = response.tokensUsed || ((response.inputTokens || 0) + (response.outputTokens || 0));
    this.state.tokens += tokens;
    this.state.usd += costForCall(model, tokens, response.inputTokens, response.outputTokens);
    this.state.calls++;
    this.check(now);
    this.onTick?.(this.state);
  }

  /** Wrap an invoker: assert → call → record. */
  wrap(invoke: (inv: AgentInvocation, persona: Persona) => Promise<AgentResponse>) {
    return async (inv: AgentInvocation, persona: Persona): Promise<AgentResponse> => {
      this.assert();
      const res = await invoke(inv, persona);
      this.record(res.model || persona.model, res);
      return res;
    };
  }

  /** Rough number of calls the remaining budget still affords, by average spend so far. */
  estimatedCallsLeft(): number | undefined {
    const { maxUsd, maxTokens } = this.state.limits;
    if (this.state.calls === 0) return undefined;
    const avgUsd = this.state.usd / this.state.calls;
    const avgTok = this.state.tokens / this.state.calls;
    const byUsd = maxUsd && avgUsd > 0 ? Math.floor((maxUsd - this.state.usd) / avgUsd) : undefined;
    const byTok = maxTokens && avgTok > 0 ? Math.floor((maxTokens - this.state.tokens) / avgTok) : undefined;
    const candidates = [byUsd, byTok].filter((n): n is number => n !== undefined);
    return candidates.length ? Math.max(0, Math.min(...candidates)) : undefined;
  }
}

/** One line for prompts: what is spent, what is left, how to behave. */
export function formatBudgetLine(meter: BudgetMeter, now = Date.now()): string {
  const { limits, usd, tokens } = meter.state;
  const parts: string[] = [];
  if (limits.maxUsd) parts.push(`$${usd.toFixed(3)} of $${limits.maxUsd} spent`);
  if (limits.maxTokens) parts.push(`${tokens.toLocaleString()} of ${limits.maxTokens.toLocaleString()} tokens used`);
  if (limits.maxMinutes) parts.push(`${meter.elapsedMinutes(now).toFixed(1)} of ${limits.maxMinutes} min elapsed`);
  if (parts.length === 0) return '';
  const left = meter.estimatedCallsLeft();
  const tail = left !== undefined ? ` (~${left} more calls at the current rate)` : '';
  return `RUN BUDGET: ${parts.join('; ')}${tail}. When the budget is tight, prefer a smaller CORRECT deliverable over an ambitious incomplete one — finish, verify, and say what you left out.`;
}
