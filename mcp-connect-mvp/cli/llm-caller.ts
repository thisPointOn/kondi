/**
 * CLI LLM Router
 *
 * Unified caller for all providers in CLI mode.
 * CLI providers spawn their binary; API providers make direct HTTP calls.
 * Mirrors the GUI's llm-router.ts but without Tauri dependencies.
 */

import { callClaude, type CallerResult } from './claude-caller';
import { callCodex } from './codex-caller';
import { Router, buildRegistryModels } from '../src/router/index';
import { getProfile } from '../src/router/profiles';
import { isRoutedModel, routeProfileName } from '../src/router/profile-options';
import type { LedgerPhase } from '../src/router/types';
import type { ModelProvider } from '../src/config/models';
import { callApiProvider, isApiToolProvider } from './api-tool-caller';
import type { AgentStreamEvent } from '../src/agent-runtime/types';

interface CallLLMOpts {
  provider: string;
  model?: string;
  systemPrompt: string;
  userMessage: string;
  workingDir?: string;
  allowedTools?: string[];
  skipTools?: boolean;
  /** Chat only (session resumption for the CLI binaries). Council calls never set it. */
  conversationId?: string;
  timeoutMs?: number;
  /** Router phase hint for routed (`route:<profile>`) models. */
  routePhase?: LedgerPhase;
  /** Real cancellation (API tool loop + binaries). */
  signal?: AbortSignal;
  /** Live events (text deltas, tool calls) for the CLI status line. */
  onEvent?: (e: AgentStreamEvent) => void;
  /** Deny local-tool reads/writes outside workingDir for API providers (default true). */
  confineToDir?: boolean;
}

/**
 * Resolve API key from environment variables.
 */
function getApiKey(provider: string): string | undefined {
  switch (provider) {
    case 'anthropic-api': return process.env.ANTHROPIC_API_KEY;
    case 'openai-api': return process.env.OPENAI_API_KEY;
    case 'deepseek': return process.env.DEEPSEEK_API_KEY;
    case 'xai': return process.env.XAI_API_KEY;
    case 'zai': return process.env.ZAI_API_KEY;
    case 'moonshot': return process.env.MOONSHOT_API_KEY;
    case 'nvidia-router': return process.env.NVIDIA_API_KEY;
    case 'google': return process.env.GOOGLE_API_KEY;
    default: return undefined;
  }
}

const DEFAULT_MODELS: Record<string, string> = {
  'anthropic-cli': 'claude-sonnet-4-5-20250929',
  'anthropic-api': 'claude-sonnet-4-5-20250929',
  'openai-cli': '',  // empty = let codex use its default model for the account tier
  'openai-api': 'gpt-4o',
  'deepseek': 'deepseek-v4-pro',
  'google': 'models/gemini-2.5-flash',
  'xai': 'grok-3',
  'zai': 'glm-4.6',
  'moonshot': 'kimi-k2.6',
  'nvidia-router': 'nvidia/nemotron-3-super-120b-a12b',
  'ollama': 'llama3.1',
};

/** Providers usable headlessly: CLI binaries + ollama always, API keys via env. */
function cliConfiguredProviders(): Set<ModelProvider> {
  const s = new Set<ModelProvider>(['anthropic-cli', 'openai-cli', 'ollama']);
  if (process.env.ANTHROPIC_API_KEY) s.add('anthropic-api');
  if (process.env.OPENAI_API_KEY) s.add('openai-api');
  if (process.env.DEEPSEEK_API_KEY) s.add('deepseek');
  if (process.env.XAI_API_KEY) s.add('xai');
  if (process.env.ZAI_API_KEY) s.add('zai');
  if (process.env.MOONSHOT_API_KEY) s.add('moonshot');
  if (process.env.GOOGLE_API_KEY) s.add('google');
  if (process.env.NVIDIA_API_KEY) s.add('nvidia-router');
  return s;
}

/**
 * Resolve a routed profile (`route:<name>`) to a concrete provider+model for
 * the given phase. The intent classifier (when reached) recurses through
 * callLLM with a concrete model, so OAuth CLI binaries and env keys both work.
 */
async function resolveCliRoute(
  profileName: string,
  phase: LedgerPhase,
  prompt: string,
): Promise<{ provider: string; model: string }> {
  const profile = getProfile(profileName);
  const models = buildRegistryModels({ configuredProviders: cliConfiguredProviders() });
  const router = new Router(models, async (req) =>
    (await callLLM({
      provider: req.provider,
      model: req.model,
      systemPrompt: req.systemPrompt,
      userMessage: req.userMessage,
      skipTools: true,
    })).content,
  );
  let candidates = models.filter(m => m.enabled);
  if (profile.allowedProviders?.length) {
    const allow = new Set(profile.allowedProviders);
    candidates = candidates.filter(m => allow.has(m.provider));
  }
  const classifier = candidates.sort((a, b) => a.inputCostPer1M - b.inputCostPer1M)[0];
  router.setProfileScope({
    classifier: classifier ? { provider: classifier.provider, model: classifier.id } : undefined,
    rolePinning: profile.rolePinning,
    allowedProviders: profile.allowedProviders,
  });
  const decision = await router.select(phase, prompt || '');
  return { provider: decision.model.provider, model: decision.model.id };
}



/**
 * Make a direct HTTP API call to Google Gemini.
 */
async function callGeminiAPI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<CallerResult> {
  const start = Date.now();
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    generationConfig: { maxOutputTokens: 16384 },
  };

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.substring(0, 500)}`);
  }

  const data = await resp.json();
  const content = data.candidates?.[0]?.content?.parts
    ?.map((p: any) => p.text)
    .join('\n') || '';
  const usage = data.usageMetadata || {};

  return {
    content,
    tokensUsed: (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0),
    latencyMs: Date.now() - start,
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
  };
}

/**
 * Unified LLM caller for CLI. Routes by provider ID. Stamps the CONCRETE
 * provider/model that answered onto the result (routed `route:*` models
 * resolve per call) so the ledger can attribute cost/quality correctly.
 */
export async function callLLM(opts: CallLLMOpts): Promise<CallerResult> {
  const resolved = await dispatchLLM(opts);
  return {
    ...resolved.result,
    provider: resolved.result.provider || resolved.provider,
    model: resolved.result.model || resolved.model,
  };
}

async function dispatchLLM(opts: CallLLMOpts): Promise<{ provider: string; model: string; result: CallerResult }> {
  const wrap = (provider: string, model: string) => async (p: Promise<CallerResult>) => ({ provider, model, result: await p });
  let provider = opts.provider || 'anthropic-cli';
  // Provider-aware fallback: openai-cli's default is '' (let codex pick its
  // account model) — it must NOT fall through to a Claude model, which codex
  // rejects ("model is not supported when using Codex with a ChatGPT account").
  const modelFallback = (p: string) => (p.startsWith('anthropic') ? 'claude-sonnet-4-5-20250929' : '');
  let model = opts.model || DEFAULT_MODELS[provider] || modelFallback(provider);

  // Smart Router: resolve `route:<profile>` to a concrete provider+model.
  if (isRoutedModel(provider, opts.model)) {
    const profileName = routeProfileName(provider, opts.model);
    const resolved = await resolveCliRoute(profileName, opts.routePhase || 'discuss', opts.userMessage);
    console.log(`[CLI] route:${profileName} (${opts.routePhase || 'discuss'}) → ${resolved.provider}/${resolved.model}`);
    provider = resolved.provider;
    model = resolved.model || DEFAULT_MODELS[provider] || modelFallback(provider);
  }

  // CLI binary providers
  if (provider === 'anthropic-cli') {
    return wrap(provider, model)(callClaude({ ...opts, model }));
  }
  if (provider === 'openai-cli') {
    return wrap(provider, model)(callCodex({ ...opts, model }));
  }

  // API key providers — a REAL tool loop (src/agent-runtime) with the four
  // local tools confined to the working dir, scoped by the orchestrator's
  // allowedTools. Ollama needs no key. (Was a single raw completion with no
  // tools — TEST-runs REPORT #5.)
  if (isApiToolProvider(provider)) {
    const apiKey = provider === 'ollama' ? 'ollama' : getApiKey(provider);
    if (!apiKey) {
      throw new Error(
        `No API key for provider "${provider}". Set the environment variable: ` +
        `${provider === 'anthropic-api' ? 'ANTHROPIC_API_KEY' : provider === 'openai-api' ? 'OPENAI_API_KEY' : provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : provider === 'xai' ? 'XAI_API_KEY' : provider === 'zai' ? 'ZAI_API_KEY' : provider === 'moonshot' ? 'MOONSHOT_API_KEY' : provider === 'nvidia-router' ? 'NVIDIA_API_KEY' : 'API_KEY'}`
      );
    }
    return wrap(provider, model)(callApiProvider({
      provider, model, apiKey,
      systemPrompt: opts.systemPrompt, userMessage: opts.userMessage,
      workingDir: opts.workingDir, constrained: opts.confineToDir ?? true,
      allowedTools: opts.allowedTools, skipTools: opts.skipTools,
      timeoutMs: opts.timeoutMs, signal: opts.signal, onEvent: opts.onEvent,
    }));
  }

  // Gemini (public generativelanguage API) — single completion, no tools yet.
  if (provider === 'google') {
    const apiKey = getApiKey(provider);
    if (!apiKey) throw new Error('No API key for provider "google". Set GOOGLE_API_KEY');
    return wrap(provider, model)(callGeminiAPI(apiKey, model, opts.systemPrompt, opts.userMessage));
  }

  // Fallback: try Claude CLI
  console.warn(`[CLI] Unknown provider "${provider}", falling back to Claude CLI`);
  return wrap(provider, model)(callClaude({ ...opts, model }));
}
