/**
 * Central model configuration
 * Single source of truth for all LLM model definitions across the app
 *
 * IMPORTANT: CLI models (subscription-based) and API models are DIFFERENT.
 * CLI tools like Claude Code and Codex have access to different/newer models
 * than what's available via direct API access.
 */

export type ModelProvider =
  | 'anthropic-api'    // Direct Anthropic API (requires API key)
  | 'anthropic-cli'    // Claude Code CLI (subscription-based)
  | 'openai-api'       // Direct OpenAI API (requires API key)
  | 'openai-cli'       // Codex CLI (subscription-based)
  | 'deepseek'
  | 'google'
  | 'xai'
  | 'zai'              // Z.AI (GLM family, OpenAI-compatible Coding Plan endpoint)
  | 'moonshot'         // Moonshot AI (Kimi family, OpenAI-compatible api.moonshot.ai)
  | 'nvidia-router'    // NVIDIA NIM hosted API or local router (OpenAI-compatible)
  | 'ollama';

/** Legacy provider names for backwards compatibility */
export type LegacyProvider = 'anthropic' | 'openai';

export interface ModelDefinition {
  id: string;
  name: string;
  provider: ModelProvider;
  contextWindow: number;
  capabilities: ('text' | 'vision' | 'code' | 'reasoning')[];
  /** Cost per 1K input tokens in USD */
  inputCostPer1K: number;
  /** Cost per 1K output tokens in USD */
  outputCostPer1K: number;
  /** Approximate cost per message for display */
  costDisplay: string;
  /** Whether this model is recommended/featured */
  featured?: boolean;
  /** Model tier for sorting: 1=frontier, 2=standard, 3=mini/fast */
  tier: 1 | 2 | 3;
  /**
   * Open-ended capability tags consumed by the Smart Router (src/router/).
   * Richer than `capabilities` (which drives the existing UI): e.g.
   * 'planning', 'coding', 'fast-coding', 'code-review', 'summarization',
   * 'reasoning', 'analysis', 'general', 'architecture'. When omitted, the
   * registry builder derives a reasonable set from `capabilities` + `tier`.
   */
  routingCapabilities?: string[];
}

// ============================================================================
// Anthropic API Models (Direct API key access)
// ============================================================================
export const ANTHROPIC_API_MODELS: ModelDefinition[] = [
  {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic-api',
    contextWindow: 200000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.003,
    outputCostPer1K: 0.015,
    costDisplay: '~$0.005/msg',
    featured: true,
    tier: 1,
    routingCapabilities: ['code-review', 'analysis', 'reasoning', 'coding'],
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic-api',
    contextWindow: 200000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.001,
    outputCostPer1K: 0.005,
    costDisplay: '~$0.002/msg',
    tier: 3,
    routingCapabilities: ['summarization', 'fast-coding', 'general'],
  },
  {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    provider: 'anthropic-api',
    contextWindow: 200000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.003,
    outputCostPer1K: 0.015,
    costDisplay: '~$0.005/msg',
    tier: 2,
  },
];

// ============================================================================
// Anthropic CLI Models (Claude Code subscription - newer models)
// ============================================================================
export const ANTHROPIC_CLI_MODELS: ModelDefinition[] = [
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6 (Latest)',
    provider: 'anthropic-cli',
    contextWindow: 200000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.005,
    outputCostPer1K: 0.025,
    costDisplay: '~$0.01/msg',
    featured: true,
    tier: 1,
    routingCapabilities: ['planning', 'reasoning', 'architecture', 'analysis'],
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic-cli',
    contextWindow: 200000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.003,
    outputCostPer1K: 0.015,
    costDisplay: '~$0.005/msg',
    featured: true,
    tier: 2,
    routingCapabilities: ['code-review', 'analysis', 'reasoning', 'coding'],
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic-cli',
    contextWindow: 200000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.001,
    outputCostPer1K: 0.005,
    costDisplay: '~$0.002/msg',
    tier: 3,
    routingCapabilities: ['summarization', 'fast-coding', 'general'],
  },
  {
    id: 'claude-opus-4-5-20251101',
    name: 'Claude Opus 4.5',
    provider: 'anthropic-cli',
    contextWindow: 200000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.005,
    outputCostPer1K: 0.025,
    costDisplay: '~$0.01/msg',
    tier: 1,
  },
  {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    provider: 'anthropic-cli',
    contextWindow: 200000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.003,
    outputCostPer1K: 0.015,
    costDisplay: '~$0.005/msg',
    tier: 2,
  },
];

// ============================================================================
// OpenAI API Models (Direct API key access)
// ============================================================================
export const OPENAI_API_MODELS: ModelDefinition[] = [
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    provider: 'openai-api',
    contextWindow: 1000000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.0025,
    outputCostPer1K: 0.015,
    costDisplay: '~$0.01/msg',
    featured: true,
    tier: 1,
    routingCapabilities: ['planning', 'general', 'reasoning', 'coding', 'analysis', 'writing'],
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    provider: 'openai-api',
    contextWindow: 400000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0.00075,
    outputCostPer1K: 0.0045,
    costDisplay: '~$0.002/msg',
    tier: 2,
    routingCapabilities: ['general', 'fast-coding', 'writing'],
  },
  {
    id: 'gpt-5.4-nano',
    name: 'GPT-5.4 Nano',
    provider: 'openai-api',
    contextWindow: 400000,
    capabilities: ['text', 'code'],
    inputCostPer1K: 0.0002,
    outputCostPer1K: 0.00125,
    costDisplay: '~$0.0005/msg',
    tier: 3,
    routingCapabilities: ['summarization', 'fast-coding', 'general'],
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai-api',
    contextWindow: 128000,
    capabilities: ['text', 'vision', 'code'],
    inputCostPer1K: 0.005,
    outputCostPer1K: 0.015,
    costDisplay: '~$0.01/msg',
    featured: true,
    tier: 1,
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai-api',
    contextWindow: 128000,
    capabilities: ['text', 'code'],
    inputCostPer1K: 0.00015,
    outputCostPer1K: 0.0006,
    costDisplay: '~$0.001/msg',
    featured: true,
    tier: 3,
  },
  {
    id: 'gpt-4-turbo',
    name: 'GPT-4 Turbo',
    provider: 'openai-api',
    contextWindow: 128000,
    capabilities: ['text', 'vision', 'code'],
    inputCostPer1K: 0.01,
    outputCostPer1K: 0.03,
    costDisplay: '~$0.02/msg',
    tier: 2,
  },
  {
    id: 'o1-preview',
    name: 'o1 Preview (Reasoning)',
    provider: 'openai-api',
    contextWindow: 128000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0.015,
    outputCostPer1K: 0.06,
    costDisplay: '~$0.03/msg',
    tier: 1,
  },
  {
    id: 'o1-mini',
    name: 'o1 Mini (Reasoning)',
    provider: 'openai-api',
    contextWindow: 128000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0.003,
    outputCostPer1K: 0.012,
    costDisplay: '~$0.005/msg',
    tier: 2,
  },
  {
    id: 'gpt-3.5-turbo',
    name: 'GPT-3.5 Turbo',
    provider: 'openai-api',
    contextWindow: 16385,
    capabilities: ['text', 'code'],
    inputCostPer1K: 0.0005,
    outputCostPer1K: 0.0015,
    costDisplay: '~$0.001/msg',
    tier: 3,
  },
];

// ============================================================================
// OpenAI CLI Models (ChatGPT subscription - newer models)
// ============================================================================
// Model IDs verified against the installed Codex CLI binary (v0.139.0). The
// interactive picker surfaces a curated subset (gpt-5.5 / gpt-5.4 / gpt-5.4-mini);
// the rest remain selectable via config. Refresh when `codex update` bumps the set.
export const OPENAI_CLI_MODELS: ModelDefinition[] = [
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5 (Latest)',
    provider: 'openai-cli',
    contextWindow: 256000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.01,
    outputCostPer1K: 0.03,
    costDisplay: 'Subscription',
    featured: true,
    tier: 1,
    routingCapabilities: ['planning', 'reasoning', 'architecture', 'coding', 'analysis'],
  },
  {
    id: 'gpt-5.5-pro',
    name: 'GPT-5.5 Pro',
    provider: 'openai-cli',
    contextWindow: 256000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.012,
    outputCostPer1K: 0.036,
    costDisplay: 'Subscription',
    tier: 1,
    routingCapabilities: ['planning', 'reasoning', 'architecture', 'analysis'],
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    provider: 'openai-cli',
    contextWindow: 256000,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.0025,
    outputCostPer1K: 0.015,
    costDisplay: 'Subscription',
    featured: true,
    tier: 2,
    routingCapabilities: ['coding', 'general', 'reasoning', 'analysis'],
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    provider: 'openai-cli',
    contextWindow: 256000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0.00075,
    outputCostPer1K: 0.0045,
    costDisplay: 'Subscription',
    featured: true,
    tier: 3,
    routingCapabilities: ['fast-coding', 'general', 'summarization'],
  },
  {
    id: 'gpt-5.4-nano',
    name: 'GPT-5.4 Nano',
    provider: 'openai-cli',
    contextWindow: 256000,
    capabilities: ['text', 'code'],
    inputCostPer1K: 0.0002,
    outputCostPer1K: 0.00125,
    costDisplay: 'Subscription',
    tier: 3,
    routingCapabilities: ['summarization', 'fast-coding'],
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    provider: 'openai-cli',
    contextWindow: 192000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0.01,
    outputCostPer1K: 0.03,
    costDisplay: 'Subscription',
    tier: 1,
    routingCapabilities: ['coding', 'code-review', 'reasoning'],
  },
  {
    id: 'gpt-5.2-codex',
    name: 'GPT-5.2 Codex',
    provider: 'openai-cli',
    contextWindow: 192000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0.01,
    outputCostPer1K: 0.03,
    costDisplay: 'Subscription',
    tier: 2,
    routingCapabilities: ['coding', 'code-review'],
  },
];

// ============================================================================
// DeepSeek Models
// ============================================================================
export const DEEPSEEK_MODELS: ModelDefinition[] = [
  // Flash is listed first + featured so the CASUAL/chat default is the cheap one.
  // Councils that want the stronger model pick deepseek-v4-pro EXPLICITLY in code
  // (DEFAULT_MODELS + chat-council-gen), so this doesn't weaken them.
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    provider: 'deepseek',
    contextWindow: 128000,
    capabilities: ['text', 'code'],
    inputCostPer1K: 0.00014,
    outputCostPer1K: 0.00028,
    costDisplay: '~$0.0003/msg',
    featured: true,
    tier: 2,
    routingCapabilities: ['coding', 'fast-coding', 'refactoring', 'summarization'],
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    contextWindow: 128000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0.00055,
    outputCostPer1K: 0.00219,
    costDisplay: '~$0.002/msg',
    tier: 1,
    routingCapabilities: ['planning', 'coding', 'code-review', 'reasoning'],
  },
];

// ============================================================================
// Z.AI (GLM family) — OpenAI-compatible Coding Plan endpoint
// ============================================================================
export const ZAI_MODELS: ModelDefinition[] = [
  {
    id: 'glm-5.1',
    name: 'GLM 5.1',
    provider: 'zai',
    contextWindow: 200000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0.0014,
    outputCostPer1K: 0.0044,
    costDisplay: '~$0.003/msg',
    featured: true,
    tier: 1,
    routingCapabilities: ['planning', 'reasoning', 'analysis', 'code-review'],
  },
  {
    id: 'glm-4.6',
    name: 'GLM 4.6',
    provider: 'zai',
    contextWindow: 200000,
    capabilities: ['text', 'code'],
    inputCostPer1K: 0.0006,
    outputCostPer1K: 0.0022,
    costDisplay: '~$0.001/msg',
    featured: true,
    tier: 2,
    routingCapabilities: ['coding', 'fast-coding', 'general'],
  },
  {
    id: 'glm-4.5-flash',
    name: 'GLM 4.5 Flash',
    provider: 'zai',
    contextWindow: 128000,
    capabilities: ['text', 'code'],
    inputCostPer1K: 0,
    outputCostPer1K: 0,
    costDisplay: 'Free',
    tier: 3,
    routingCapabilities: ['summarization', 'general'],
  },
  {
    id: 'glm-4.5-air',
    name: 'GLM 4.5 Air',
    provider: 'zai',
    contextWindow: 128000,
    capabilities: ['text', 'code'],
    inputCostPer1K: 0.0002,
    outputCostPer1K: 0.0011,
    costDisplay: '~$0.0005/msg',
    tier: 3,
    routingCapabilities: ['fast-coding', 'general', 'summarization'],
  },
];

// ============================================================================
// Moonshot AI (Kimi) — OpenAI-compatible, https://api.moonshot.ai/v1
// IDs per platform.kimi.ai docs 2026-07: kimi-k3 (1M ctx flagship),
// kimi-k2.7-code (+highspeed), kimi-k2.6 (vision). moonshot-v1 sunsets 2026-08-31.
// ============================================================================
export const MOONSHOT_MODELS: ModelDefinition[] = [
  {
    id: 'kimi-k2.6',
    name: 'Kimi K2.6',
    provider: 'moonshot',
    contextWindow: 262144,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.00095,
    outputCostPer1K: 0.004,
    costDisplay: '~$0.002/msg',
    featured: true,
    tier: 2,
    routingCapabilities: ['coding', 'general', 'analysis'],
  },
  {
    id: 'kimi-k2.7-code',
    name: 'Kimi K2.7 Code',
    provider: 'moonshot',
    contextWindow: 262144,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0.00095,
    outputCostPer1K: 0.004,
    costDisplay: '~$0.002/msg',
    tier: 2,
    routingCapabilities: ['coding', 'fast-coding', 'code-review'],
  },
  {
    id: 'kimi-k3',
    name: 'Kimi K3',
    provider: 'moonshot',
    contextWindow: 1048576,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0.003,
    outputCostPer1K: 0.015,
    costDisplay: '~$0.008/msg',
    tier: 1,
    routingCapabilities: ['planning', 'reasoning', 'architecture', 'analysis'],
  },
];

// ============================================================================
// NVIDIA NIM (hosted at integrate.api.nvidia.com; override via NVIDIA_ROUTER_URL
// for a local NIM/router). Curated "best of" subset of the live /models list —
// IDs verified against the live endpoint 2026-07. Costs are credit-based (no
// per-token USD), hence 0 rates + 'NIM' display.
// ============================================================================
export const NVIDIA_MODELS: ModelDefinition[] = [
  // First entry is the provider's default model in Settings/chat fallback.
  {
    id: 'nvidia/nemotron-3-super-120b-a12b',
    name: 'Nemotron 3 Super 120B',
    provider: 'nvidia-router',
    contextWindow: 128000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0,
    outputCostPer1K: 0,
    costDisplay: 'NIM',
    featured: true,
    tier: 2,
    routingCapabilities: ['coding', 'general', 'reasoning'],
  },
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b',
    name: 'Nemotron 3 Ultra 550B',
    provider: 'nvidia-router',
    contextWindow: 128000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0,
    outputCostPer1K: 0,
    costDisplay: 'NIM',
    featured: true,
    tier: 1,
    routingCapabilities: ['planning', 'reasoning', 'architecture', 'analysis'],
  },
  {
    id: 'deepseek-ai/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro (NIM)',
    provider: 'nvidia-router',
    contextWindow: 128000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0,
    outputCostPer1K: 0,
    costDisplay: 'NIM',
    tier: 1,
    routingCapabilities: ['reasoning', 'coding', 'code-review', 'analysis'],
  },
  // NOTE: several models in the live /models list are deliberately excluded as
  // NOT usable (verified 2026-07): moonshotai/kimi-k2.6 (404 "Function not
  // found"), meta/llama-4-maverick (request hangs), qwen/qwen3.5-397b-a17b
  // (hangs on any real completion, streaming or not), minimaxai/minimax-m3
  // (streaming = instant "Internal server error"; chat always streams).
  {
    id: 'z-ai/glm-5.2',
    name: 'GLM 5.2 (NIM)',
    provider: 'nvidia-router',
    contextWindow: 200000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0,
    outputCostPer1K: 0,
    costDisplay: 'NIM',
    tier: 1,
    routingCapabilities: ['coding', 'code-review', 'general'],
  },
  {
    id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
    name: 'Nemotron Super 49B v1.5',
    provider: 'nvidia-router',
    contextWindow: 128000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0,
    outputCostPer1K: 0,
    costDisplay: 'NIM',
    tier: 2,
    routingCapabilities: ['reasoning', 'general', 'coding'],
  },
  {
    id: 'openai/gpt-oss-120b',
    name: 'GPT-OSS 120B (NIM)',
    provider: 'nvidia-router',
    contextWindow: 128000,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0,
    outputCostPer1K: 0,
    costDisplay: 'NIM',
    tier: 3,
    routingCapabilities: ['fast-coding', 'reasoning', 'summarization', 'general'],
  },
  {
    id: 'nvidia/nemotron-3-nano-30b-a3b',
    name: 'Nemotron 3 Nano 30B',
    provider: 'nvidia-router',
    contextWindow: 128000,
    capabilities: ['text', 'code'],
    inputCostPer1K: 0,
    outputCostPer1K: 0,
    costDisplay: 'NIM',
    tier: 3,
    routingCapabilities: ['fast-coding', 'summarization', 'general'],
  },
];

// ============================================================================
// Google Models
// ============================================================================
export const GOOGLE_MODELS: ModelDefinition[] = [
  // Flash first so the CASUAL/chat default is the cheap one (councils pick a
  // specific gemini model explicitly, so this doesn't affect them).
  {
    id: 'models/gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'google',
    contextWindow: 1048576,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.00015,
    outputCostPer1K: 0.0006,
    costDisplay: '~$0.001/msg',
    featured: true,
    tier: 2,
    routingCapabilities: ['coding', 'fast-coding', 'general', 'summarization'],
  },
  {
    id: 'models/gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'google',
    contextWindow: 1048576,
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    inputCostPer1K: 0.00125,
    outputCostPer1K: 0.01,
    costDisplay: '~$0.005/msg',
    featured: true,
    tier: 1,
    routingCapabilities: ['planning', 'reasoning', 'analysis', 'coding'],
  },
  {
    id: 'models/gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    provider: 'google',
    contextWindow: 1048576,
    capabilities: ['text', 'vision', 'code'],
    inputCostPer1K: 0.00035,
    outputCostPer1K: 0.00105,
    costDisplay: '~$0.001/msg',
    tier: 2,
  },
  {
    id: 'models/gemini-1.5-pro',
    name: 'Gemini 1.5 Pro',
    provider: 'google',
    contextWindow: 2097152,
    capabilities: ['text', 'vision', 'code'],
    inputCostPer1K: 0.00125,
    outputCostPer1K: 0.005,
    costDisplay: '~$0.003/msg',
    tier: 2,
  },
];

// ============================================================================
// x.ai (Grok) Models
// ============================================================================
export const XAI_MODELS: ModelDefinition[] = [
  {
    id: 'grok-3',
    name: 'Grok 3',
    provider: 'xai',
    contextWindow: 131072,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0.003,
    outputCostPer1K: 0.015,
    costDisplay: '~$0.005/msg',
    featured: true,
    tier: 1,
  },
  {
    id: 'grok-3-fast',
    name: 'Grok 3 Fast',
    provider: 'xai',
    contextWindow: 131072,
    capabilities: ['text', 'code'],
    inputCostPer1K: 0.005,
    outputCostPer1K: 0.025,
    costDisplay: '~$0.01/msg',
    tier: 2,
  },
  {
    id: 'grok-3-mini',
    name: 'Grok 3 Mini',
    provider: 'xai',
    contextWindow: 131072,
    capabilities: ['text', 'code', 'reasoning'],
    inputCostPer1K: 0.0003,
    outputCostPer1K: 0.0005,
    costDisplay: '~$0.001/msg',
    tier: 3,
  },
];

// ============================================================================
// Ollama Models (local — populated dynamically, with common defaults)
// ============================================================================
export const OLLAMA_MODELS: ModelDefinition[] = [
  {
    id: 'llama3.1',
    name: 'Llama 3.1',
    provider: 'ollama',
    contextWindow: 128000,
    capabilities: ['text', 'code'],
    inputCostPer1K: 0,
    outputCostPer1K: 0,
    costDisplay: 'Free (local)',
    featured: true,
    tier: 1,
  },
  {
    id: 'qwen2.5-coder',
    name: 'Qwen 2.5 Coder',
    provider: 'ollama',
    contextWindow: 32768,
    capabilities: ['text', 'code'],
    inputCostPer1K: 0,
    outputCostPer1K: 0,
    costDisplay: 'Free (local)',
    tier: 2,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    provider: 'ollama',
    contextWindow: 32768,
    capabilities: ['text', 'code'],
    inputCostPer1K: 0,
    outputCostPer1K: 0,
    costDisplay: 'Free (local)',
    tier: 2,
  },
];

// ============================================================================
// Combined & Helper Functions
// ============================================================================

/** All available models across all providers */
export const ALL_MODELS: ModelDefinition[] = [
  ...ANTHROPIC_API_MODELS,
  ...ANTHROPIC_CLI_MODELS,
  ...OPENAI_API_MODELS,
  ...OPENAI_CLI_MODELS,
  ...DEEPSEEK_MODELS,
  ...GOOGLE_MODELS,
  ...XAI_MODELS,
  ...ZAI_MODELS,
  ...MOONSHOT_MODELS,
  ...NVIDIA_MODELS,
  ...OLLAMA_MODELS,
];

/** Get models by provider */
export function getModelsByProvider(provider: ModelProvider): ModelDefinition[] {
  return ALL_MODELS.filter(m => m.provider === provider);
}

/** Get featured/recommended models */
export function getFeaturedModels(): ModelDefinition[] {
  return ALL_MODELS.filter(m => m.featured);
}

/** Get a model by ID (searches all providers) */
export function getModelById(id: string): ModelDefinition | undefined {
  return ALL_MODELS.find(m => m.id === id);
}

/** Get cost rates for a model (for orchestrator cost calculation) */
export function getModelCostRates(modelId: string): { input: number; output: number } {
  const model = getModelById(modelId);
  if (model) {
    return { input: model.inputCostPer1K, output: model.outputCostPer1K };
  }
  // Default fallback rates
  return { input: 0.01, output: 0.03 };
}

/**
 * Get models formatted for the AddPersonaModal dropdown
 * Includes both API and CLI models, sorted by provider then by tier
 */
export function getModelsForPersonaSelector(): Array<{
  id: string;
  name: string;
  provider: string;
  cost: string;
}> {
  const providerOrder: Record<string, number> = {
    'anthropic-cli': 0,
    'anthropic-api': 1,
    'openai-cli': 2,
    'openai-api': 3,
    'deepseek': 4,
    'google': 5,
    'xai': 6,
    'zai': 7,
    'moonshot': 8,
    'nvidia-router': 9,
    'ollama': 10,
  };

  // NOTE: copy before sort — Array.sort mutates in place, and ALL_MODELS is the
  // shared catalog. Mutating it reorders models everywhere (e.g. it was pushing
  // tier-1 Pro models ahead of the cheaper tier-2 default, overriding the
  // declaration order that makes the casual default the cheap model).
  return [...ALL_MODELS]
    .sort((a, b) => {
      // Sort by provider first, then by tier
      const aOrder = providerOrder[a.provider] ?? 99;
      const bOrder = providerOrder[b.provider] ?? 99;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.tier - b.tier;
    })
    .map(m => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      cost: m.costDisplay,
    }));
}

/**
 * Get models formatted for the LLM Provider settings panel
 */
export function getModelsForProviderSettings(provider: ModelProvider): Array<{
  id: string;
  name: string;
  contextWindow: number;
  capabilities: string[];
}> {
  return getModelsByProvider(provider).map(m => ({
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    capabilities: m.capabilities,
  }));
}

/**
 * Build cost lookup table for orchestrator (backwards compatible)
 */
export function getCostPer1KTokens(): Record<string, { input: number; output: number }> {
  const result: Record<string, { input: number; output: number }> = {};
  for (const model of ALL_MODELS) {
    result[model.id] = { input: model.inputCostPer1K, output: model.outputCostPer1K };
  }
  return result;
}

/**
 * Map legacy provider names to the appropriate model provider based on auth method
 */
export function resolveProvider(
  legacyProvider: 'anthropic' | 'openai',
  authMethod: 'api' | 'cli' | 'oauth'
): ModelProvider {
  if (legacyProvider === 'anthropic') {
    return authMethod === 'cli' ? 'anthropic-cli' : 'anthropic-api';
  }
  return authMethod === 'cli' ? 'openai-cli' : 'openai-api';
}

/**
 * CLI-to-API fallback mapping for OpenAI models.
 * Anthropic model IDs are the same across CLI and API.
 * OpenAI CLI has newer models not available via API.
 */
const OPENAI_CLI_TO_API_MODEL: Record<string, string> = {
  'gpt-5.5': 'gpt-5.4',
  'gpt-5.5-pro': 'gpt-5.4',
  'gpt-5.4': 'gpt-5.4',
  'gpt-5.4-mini': 'gpt-5.4-mini',
  'gpt-5.4-nano': 'gpt-5.4-nano',
  'gpt-5.3-codex': 'gpt-5.4',
  'gpt-5.2-codex': 'gpt-4o',
};

/**
 * Resolve a CLI model+provider to the best available option.
 * If the CLI provider is available, returns it as-is.
 * Otherwise falls back to the equivalent API model+provider.
 *
 * @param model - The preferred CLI model ID
 * @param provider - The preferred CLI provider (e.g. 'anthropic-cli', 'openai-cli')
 * @param available - Map of provider availability (e.g. { 'anthropic-cli': true, 'openai-api': true })
 */
export function resolveDefaultModel(
  model: string,
  provider: string,
  available: Record<string, boolean>,
): { model: string; provider: string } {
  // If the preferred provider is available, use it
  if (available[provider]) {
    return { model, provider };
  }

  // Fall back to API equivalent
  if (provider === 'anthropic-cli' && available['anthropic-api']) {
    // Anthropic model IDs are the same for CLI and API
    return { model, provider: 'anthropic-api' };
  }
  if (provider === 'openai-cli' && available['openai-api']) {
    return {
      model: OPENAI_CLI_TO_API_MODEL[model] || 'gpt-4o',
      provider: 'openai-api',
    };
  }

  // Non-CLI providers (deepseek, xai, google, ollama): return as-is if available
  if (!provider.endsWith('-cli') && !provider.endsWith('-api') && available[provider]) {
    return { model, provider };
  }

  // If neither CLI nor API is available for that vendor, try the other vendor
  if (provider.startsWith('anthropic') && (available['openai-cli'] || available['openai-api'])) {
    const oProvider = available['openai-cli'] ? 'openai-cli' : 'openai-api';
    const oModel = oProvider === 'openai-cli' ? 'gpt-5.5' : 'gpt-4o';
    return { model: oModel, provider: oProvider };
  }
  if (provider.startsWith('openai') && (available['anthropic-cli'] || available['anthropic-api'])) {
    const aProvider = available['anthropic-cli'] ? 'anthropic-cli' : 'anthropic-api';
    return { model: 'claude-sonnet-4-5-20250929', provider: aProvider };
  }

  // Last resort: return as-is
  return { model, provider };
}
