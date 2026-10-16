/**
 * CLI — API-provider calls WITH a real tool loop.
 *
 * Replaces the single raw-fetch completion in `llm-caller.ts` for API
 * providers (anthropic-api, openai-api, deepseek, xai, zai, moonshot,
 * nvidia-router, ollama): the model gets the four local tools (containment =
 * deny outside the working dir) scoped by the orchestrator's abstract
 * `allowedTools`, runs through `runToolLoop`, and returns REAL summed usage.
 * This closes TEST-runs REPORT #5 ("API personas told they have tools").
 */
import { getModelById } from '../src/config/models';
import type { CallerResult } from './claude-caller';
import { runToolLoop } from '../src/agent-runtime/tool-loop';
import { ToolRegistry } from '../src/agent-runtime/tool-registry';
import { createNodeLocalTools } from '../src/agent-runtime/node/local-tools-node';
import { openaiCompatibleAdapter } from '../src/agent-runtime/adapters/openai-compatible';
import { anthropicAdapter } from '../src/agent-runtime/adapters/anthropic';
import type { ToolLoopAdapter, AgentStreamEvent, ToolExecutor } from '../src/agent-runtime/types';
import { withSignal } from '../src/agent-runtime/signals';

export interface ApiCallOptions {
  provider: string;
  model: string;
  apiKey: string;
  systemPrompt: string;
  userMessage: string;
  workingDir?: string;
  /** Deny reads/writes outside workingDir (default true). */
  constrained?: boolean;
  /** Abstract names (Read/Write/Edit/Bash/Glob/Grep); undefined = all four local tools. */
  allowedTools?: string[];
  skipTools?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (e: AgentStreamEvent) => void;
  temperature?: number;
  /** Test seam: inject a fetch / an executor. */
  fetchImpl?: typeof fetch;
  executor?: ToolExecutor;
  stream?: boolean;
}

export const OPENAI_COMPATIBLE_BASE_URLS: Record<string, string> = {
  'openai-api': 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  xai: 'https://api.x.ai/v1',
  zai: 'https://api.z.ai/api/coding/paas/v4',
  moonshot: 'https://api.moonshot.ai/v1',
  'nvidia-router': process.env.NVIDIA_ROUTER_URL || 'https://integrate.api.nvidia.com/v1',
  ollama: 'http://localhost:11434/v1',
};

export function isApiToolProvider(provider: string): boolean {
  return provider === 'anthropic-api' || provider in OPENAI_COMPATIBLE_BASE_URLS;
}

export function adapterFor(o: ApiCallOptions): ToolLoopAdapter {
  if (o.provider === 'anthropic-api') {
    return anthropicAdapter({ fetchImpl: o.fetchImpl, apiKey: o.apiKey, model: o.model, temperature: o.temperature, stream: o.stream });
  }
  const baseUrl = OPENAI_COMPATIBLE_BASE_URLS[o.provider];
  if (!baseUrl) throw new Error(`No API adapter for provider "${o.provider}"`);
  return openaiCompatibleAdapter({ fetchImpl: o.fetchImpl, baseUrl, apiKey: o.apiKey, model: o.model, provider: o.provider, temperature: o.temperature, stream: o.stream, requestOverrides: getModelById(o.model)?.requestOverrides });
}

/** Local tools (or none) for this call. MCP tools are not available on the CLI path yet. */
export function executorFor(o: ApiCallOptions): ToolExecutor | undefined {
  if (o.skipTools) return undefined;
  if (o.executor) return o.executor;
  if (!o.workingDir) return undefined;
  const local = createNodeLocalTools({ root: o.workingDir, constrained: o.constrained ?? true, allowedAbstract: o.allowedTools });
  if (local.list().length === 0) return undefined;
  return new ToolRegistry([local]);
}

export async function callApiProvider(o: ApiCallOptions): Promise<CallerResult> {
  const start = Date.now();
  const adapter = adapterFor(o);
  const executor = executorFor(o);
  const result = await withSignal(o.signal, o.timeoutMs, `${o.provider} call`, (signal) =>
    runToolLoop({
      adapter,
      executor,
      system: o.systemPrompt,
      userMessage: o.userMessage,
      workingDir: o.workingDir,
      signal,
      onEvent: o.onEvent,
    }));
  return {
    content: result.content,
    tokensUsed: result.usage.inputTokens + result.usage.outputTokens,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    latencyMs: Date.now() - start,
    provider: o.provider,
    model: o.model,
    cacheRead: result.usage.cacheReadTokens,
    cacheCreation: result.usage.cacheWriteTokens,
    toolCallCount: result.usage.toolCalls,
  };
}
