/**
 * Budget Profiles — control how the router balances cost vs quality.
 *
 * Ported from kondi-chat, de-Node-ified: the six built-in profiles are
 * compiled-in constants (no disk load/merge). A profile either routes by
 * capability preference (quality/balanced/cheap) or hard-pins each phase to a
 * specific model id (zai/best-value/orchestra).
 *
 * In kondi these profiles are surfaced as selectable "models" in every model
 * dropdown via `route:<name>` ids (see resolve.ts).
 */

import type { ProviderId } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProfileName = string;

export interface BudgetProfile {
  name: string;
  description: string;
  planningPreference: string[];
  executionPreference: string[];
  reviewPreference: string[];
  contextBudget: number;
  maxIterations: number;
  loopCostCap: number;
  loopIterationCap: number;
  promotionThreshold: number;
  includeReflection: boolean;
  includeVerification: boolean;
  preferLocal: boolean;
  maxOutputTokens: number;
  /**
   * Hard-pin specific phases to specific model IDs. When the router selects
   * for a pinned phase it returns that exact model and skips intent/rules.
   * Keys are `LedgerPhase` strings; the model id must exist in the registry.
   */
  rolePinning?: Record<string, string>;
  /**
   * Restrict routing to a subset of providers. When unset it's derived from
   * `rolePinning`. Values are kondi `ModelProvider`s.
   */
  allowedProviders?: ProviderId[];
}

// ---------------------------------------------------------------------------
// Built-in profiles
// ---------------------------------------------------------------------------

export const BUILTIN_PROFILES: Record<string, BudgetProfile> = {
  quality: {
    name: 'quality',
    description: 'Frontier models, thorough review, generous context',
    planningPreference: ['general', 'planning', 'reasoning', 'architecture'],
    executionPreference: ['coding', 'reasoning'],
    reviewPreference: ['code-review', 'analysis', 'reasoning'],
    contextBudget: 60_000,
    maxIterations: 30,
    loopCostCap: 10.0,
    loopIterationCap: 30,
    promotionThreshold: 2,
    includeReflection: true,
    includeVerification: true,
    preferLocal: false,
    maxOutputTokens: 16_384,
  },
  balanced: {
    name: 'balanced',
    description: 'Good cost/quality balance — default mode',
    planningPreference: ['general', 'planning', 'reasoning'],
    executionPreference: ['coding', 'fast-coding'],
    reviewPreference: ['code-review', 'analysis'],
    contextBudget: 30_000,
    maxIterations: 20,
    loopCostCap: 3.0,
    loopIterationCap: 20,
    promotionThreshold: 2,
    includeReflection: true,
    includeVerification: true,
    preferLocal: false,
    maxOutputTokens: 8_192,
  },
  cheap: {
    name: 'cheap',
    description: 'Cheapest models, tight limits, local when possible',
    planningPreference: ['fast-coding', 'general'],
    executionPreference: ['fast-coding', 'coding'],
    reviewPreference: [],
    contextBudget: 15_000,
    maxIterations: 12,
    loopCostCap: 0.75,
    loopIterationCap: 8,
    promotionThreshold: 3,
    includeReflection: false,
    includeVerification: true,
    preferLocal: true,
    maxOutputTokens: 4_096,
  },
  zai: {
    name: 'zai',
    description: 'Z.AI (GLM) — glm-5.1 plans, glm-4.6 codes, glm-4.5-flash compresses',
    planningPreference: ['planning', 'reasoning', 'analysis', 'code-review'],
    executionPreference: ['coding', 'fast-coding', 'general'],
    reviewPreference: ['code-review', 'analysis', 'reasoning'],
    contextBudget: 30_000,
    maxIterations: 20,
    loopCostCap: 3.0,
    loopIterationCap: 20,
    promotionThreshold: 2,
    includeReflection: true,
    includeVerification: true,
    preferLocal: false,
    maxOutputTokens: 8_192,
    allowedProviders: ['zai'],
    rolePinning: {
      discuss: 'glm-5.1',
      dispatch: 'glm-5.1',
      execute: 'glm-4.6',
      reflect: 'glm-5.1',
      compress: 'glm-4.5-flash',
      state_update: 'glm-4.5-flash',
    },
  },
  'best-value': {
    name: 'best-value',
    description: 'Sonnet chats/reviews, GPT-5.4 plans, Gemini codes, GLM-flash compresses',
    planningPreference: ['planning', 'reasoning', 'architecture', 'analysis'],
    executionPreference: ['coding', 'fast-coding', 'refactoring'],
    reviewPreference: ['code-review', 'analysis', 'reasoning'],
    contextBudget: 40_000,
    maxIterations: 24,
    loopCostCap: 5.0,
    loopIterationCap: 24,
    promotionThreshold: 2,
    includeReflection: true,
    includeVerification: true,
    preferLocal: false,
    maxOutputTokens: 8_192,
    rolePinning: {
      discuss: 'claude-sonnet-4-5-20250929',
      dispatch: 'gpt-5.4',
      execute: 'models/gemini-2.5-pro',
      reflect: 'claude-sonnet-4-5-20250929',
      compress: 'glm-4.5-flash',
      state_update: 'glm-4.5-flash',
    },
  },
  orchestra: {
    name: 'orchestra',
    description: 'Multi-provider pipeline — GPT-5.4 plans, Gemini codes, GLM-5.1 reviews',
    planningPreference: ['planning', 'reasoning', 'analysis'],
    executionPreference: ['coding', 'fast-coding', 'general'],
    reviewPreference: ['code-review', 'analysis', 'reasoning'],
    contextBudget: 40_000,
    maxIterations: 24,
    loopCostCap: 5.0,
    loopIterationCap: 24,
    promotionThreshold: 2,
    includeReflection: true,
    includeVerification: true,
    preferLocal: false,
    maxOutputTokens: 8_192,
    rolePinning: {
      discuss: 'gpt-5.4',
      dispatch: 'gpt-5.4',
      execute: 'models/gemini-2.5-pro',
      reflect: 'glm-5.1',
      compress: 'glm-4.5-flash',
      state_update: 'glm-4.5-flash',
    },
  },
  nvidia: {
    name: 'nvidia',
    description: 'NVIDIA NIM — Nemotron Ultra plans, GLM 5.2 codes, DeepSeek reviews, Nano compresses',
    planningPreference: ['planning', 'reasoning', 'architecture', 'analysis'],
    executionPreference: ['coding', 'fast-coding', 'general'],
    reviewPreference: ['code-review', 'analysis', 'reasoning'],
    contextBudget: 30_000,
    maxIterations: 20,
    loopCostCap: 3.0,
    loopIterationCap: 20,
    promotionThreshold: 2,
    includeReflection: true,
    includeVerification: true,
    preferLocal: false,
    maxOutputTokens: 8_192,
    allowedProviders: ['nvidia-router'],
    rolePinning: {
      discuss: 'nvidia/nemotron-3-super-120b-a12b',
      dispatch: 'nvidia/nemotron-3-ultra-550b-a55b',
      execute: 'z-ai/glm-5.2',
      reflect: 'deepseek-ai/deepseek-v4-pro',
      compress: 'nvidia/nemotron-3-nano-30b-a3b',
      state_update: 'nvidia/nemotron-3-nano-30b-a3b',
    },
  },
};

/** Stable display order for the dropdown. */
export const PROFILE_ORDER: string[] = ['balanced', 'quality', 'cheap', 'orchestra', 'best-value', 'zai', 'nvidia'];

export function getProfile(name: ProfileName): BudgetProfile {
  return BUILTIN_PROFILES[name] || BUILTIN_PROFILES.balanced;
}

export function getProfileNames(): string[] {
  return Object.keys(BUILTIN_PROFILES);
}
