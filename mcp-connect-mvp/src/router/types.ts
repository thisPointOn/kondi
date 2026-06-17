/**
 * Smart Router — shared types.
 *
 * Ported from kondi-chat's per-phase router. The router selects a concrete
 * model for each pipeline/council phase based on a budget profile. Unlike
 * kondi-chat (which had its own 8-value ProviderId), this port reuses kondi's
 * own `ModelProvider` so a routing decision can be dispatched directly through
 * `llm-router.ts` with no provider translation.
 */

import type { ModelProvider } from '../config/models';

/** Provider IDs the router reasons about — kondi's own provider union. */
export type ProviderId = ModelProvider;

/**
 * Pipeline phases. A phase is a hint about what kind of work a call performs,
 * so the router can pick an appropriately-priced model. Council roles and chat
 * map onto these (see `roleToPhase` in resolve.ts).
 */
export type LedgerPhase =
  | 'consult'        // domain-expert consultation
  | 'discuss'        // conversational / general reasoning (chat, consultants)
  | 'commit'         // system state update
  | 'dispatch'       // planning & decomposition (managers)
  | 'execute'        // code generation / work (workers)
  | 'verify'         // local verification (no LLM)
  | 'reflect'        // review / critique (reviewers)
  | 'compress'       // summarization / compaction
  | 'state_update';  // cheap bookkeeping

/** Task kinds used by the rule tier to refine execute-phase selection. */
export type TaskKind =
  | 'implementation'
  | 'refactor'
  | 'refactoring'
  | 'test'
  | 'fix'
  | 'analysis'
  | 'code-review'
  | 'marketing'
  | 'writing'
  | string;

/**
 * Context about what happened in prior phases of the current pipeline.
 * Fed to the intent router so the classifier can make informed decisions
 * (e.g. "the worker just wrote the code — pick a different reviewer").
 */
export interface PhaseContext {
  priorPhases?: Array<{
    phase: string;
    model: string;
    summary?: string;
    succeeded?: boolean;
  }>;
  currentGoal?: string;
}

/** Signature for the injected classifier completion (wired to llm-router). */
export type ClassifierComplete = (req: {
  provider: ProviderId;
  model: string;
  systemPrompt: string;
  userMessage: string;
}) => Promise<string>;
