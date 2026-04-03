/**
 * CLI LLM Router
 *
 * Unified caller for all providers in CLI mode.
 * CLI providers spawn their binary; API providers make direct HTTP calls.
 * Mirrors the GUI's llm-router.ts but without Tauri dependencies.
 */

import { callClaude, type CallerResult } from './claude-caller';
import { callCodex } from './codex-caller';

interface CallLLMOpts {
  provider: string;
  model?: string;
  systemPrompt: string;
  userMessage: string;
  workingDir?: string;
  allowedTools?: string[];
  skipTools?: boolean;
  conversationId?: string;
  timeoutMs?: number;
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
    case 'google': return process.env.GOOGLE_API_KEY;
    default: return undefined;
  }
}

const DEFAULT_MODELS: Record<string, string> = {
  'anthropic-cli': 'claude-sonnet-4-5-20250929',
  'anthropic-api': 'claude-sonnet-4-5-20250929',
  'openai-cli': '',  // empty = let codex use its default model for the account tier
  'openai-api': 'gpt-4o',
  'deepseek': 'deepseek-chat',
  'google': 'models/gemini-2.5-flash',
  'xai': 'grok-3',
  'ollama': 'llama3.1',
};

/**
 * Make a direct HTTP API call to an OpenAI-compatible endpoint.
 */
async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<CallerResult> {
  const start = Date.now();
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    max_tokens: 16384,
  };

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.substring(0, 500)}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';
  const usage = data.usage || {};

  return {
    content,
    tokensUsed: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    latencyMs: Date.now() - start,
  };
}

/**
 * Make a direct HTTP API call to Anthropic Messages API.
 * System prompt gets cache_control so repeated council calls with the same
 * persona prompt hit the cache instead of re-processing tokens.
 */
async function callAnthropicAPI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<CallerResult> {
  const start = Date.now();
  const body = {
    model,
    max_tokens: 16384,
    // Array format with cache_control enables prompt caching
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }],
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.substring(0, 500)}`);
  }

  const data = await resp.json();
  const content = data.content
    ?.filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n') || '';
  const usage = data.usage || {};

  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  if (cacheRead || cacheCreation) {
    console.log(`[Anthropic API] Cache: ${cacheRead} read, ${cacheCreation} created, ${usage.input_tokens || 0} input`);
  }

  return {
    content,
    tokensUsed: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    latencyMs: Date.now() - start,
    cacheRead,
    cacheCreation,
  };
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
  };
}

/**
 * Unified LLM caller for CLI. Routes by provider ID.
 */
export async function callLLM(opts: CallLLMOpts): Promise<CallerResult> {
  const provider = opts.provider || 'anthropic-cli';
  const model = opts.model || DEFAULT_MODELS[provider] || 'claude-sonnet-4-5-20250929';

  // CLI binary providers
  if (provider === 'anthropic-cli') {
    return callClaude({ ...opts, model });
  }
  if (provider === 'openai-cli') {
    return callCodex({ ...opts, model });
  }

  // API key providers — require env vars
  const apiKey = getApiKey(provider);
  if (!apiKey) {
    throw new Error(
      `No API key for provider "${provider}". Set the environment variable: ` +
      `${provider === 'anthropic-api' ? 'ANTHROPIC_API_KEY' : provider === 'openai-api' ? 'OPENAI_API_KEY' : provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : provider === 'xai' ? 'XAI_API_KEY' : provider === 'google' ? 'GOOGLE_API_KEY' : 'API_KEY'}`
    );
  }

  if (provider === 'anthropic-api') {
    return callAnthropicAPI(apiKey, model, opts.systemPrompt, opts.userMessage);
  }
  if (provider === 'openai-api') {
    return callOpenAICompatible('https://api.openai.com/v1', apiKey, model, opts.systemPrompt, opts.userMessage);
  }
  if (provider === 'deepseek') {
    return callOpenAICompatible('https://api.deepseek.com/v1', apiKey, model, opts.systemPrompt, opts.userMessage);
  }
  if (provider === 'xai') {
    return callOpenAICompatible('https://api.x.ai/v1', apiKey, model, opts.systemPrompt, opts.userMessage);
  }
  if (provider === 'google') {
    return callGeminiAPI(apiKey, model, opts.systemPrompt, opts.userMessage);
  }
  if (provider === 'ollama') {
    return callOpenAICompatible('http://localhost:11434/v1', 'ollama', model, opts.systemPrompt, opts.userMessage);
  }

  // Fallback: try Claude CLI
  console.warn(`[CLI] Unknown provider "${provider}", falling back to Claude CLI`);
  return callClaude({ ...opts, model });
}
