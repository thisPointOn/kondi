/**
 * GUI Pipeline Caller
 *
 * Pipeline-specific wrapper around the unified LLM router.
 * Adds tool discovery, tool capping, allowed-tool filtering, and timeouts.
 * Provider routing is handled entirely by llm-router.ts.
 */

import { anySignal, timeoutSignal, raceSignal } from '../agent-runtime/signals';
import type { AgentStreamEvent } from '../agent-runtime/types';
import { simpleCompletion } from '../services/llm-router';
import { LOCAL_SERVER_ID } from '../services/localTools';
import { BUILTIN_SERVER_IDS, countTools } from '../utils/filterTools';
import type { MCPTool } from '../types/mcp';
import type { LedgerPhase } from '../router/types';

/**
 * Maps abstract orchestrator tool names to local tool names.
 * The orchestrator uses names like 'Read', 'Write', 'Bash' but
 * the actual local tools are 'read_file', 'write_file', 'run_command'.
 */
// Shared with the Node runtime (src/agent-runtime/local-tool-defs.ts).
import { ABSTRACT_TO_LOCAL } from '../agent-runtime/local-tool-defs';

/**
 * Filter available tools based on the orchestrator's allowedTools list.
 * Removes local tools that aren't in the allowed set.
 * MCP server tools are passed through (server-level filtering is separate).
 */
function applyAllowedToolsFilter(
  tools: Map<string, { serverId: string; tools: MCPTool[] }>,
  allowedTools?: string[],
): Map<string, { serverId: string; tools: MCPTool[] }> {
  if (!allowedTools) return tools;

  // Build set of allowed local tool names from abstract names
  const allowedLocalNames = new Set<string>();
  for (const name of allowedTools) {
    const mapped = ABSTRACT_TO_LOCAL[name];
    if (mapped) {
      mapped.forEach(n => allowedLocalNames.add(n));
    }
  }

  const filtered = new Map<string, { serverId: string; tools: MCPTool[] }>();
  for (const [key, value] of tools) {
    if (key === LOCAL_SERVER_ID) {
      // Filter local tools to only allowed ones
      const filteredLocalTools = value.tools.filter(t => allowedLocalNames.has(t.name));
      if (filteredLocalTools.length > 0) {
        filtered.set(key, { serverId: value.serverId, tools: filteredLocalTools });
      }
    } else {
      // MCP server tools pass through (server-level filtering already done)
      filtered.set(key, value);
    }
  }
  return filtered;
}

export interface CallerResult {
  content: string;
  tokensUsed: number;
  latencyMs: number;
  /** Concrete provider/model that answered (passed through from simpleCompletion). */
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  usageReported?: boolean;
}

/** Options accepted by all callLLM variants */
export interface CallLLMOptions {
  systemPrompt: string;
  userMessage: string;
  /** Required: every caller passes the persona's provider/model (routed `route:*` resolve in llm-router). */
  model: string;
  provider: string;
  skipTools?: boolean;
  temperature?: number;
  /** MCP tools from GUI-connected servers (passed through to API providers) */
  availableTools?: Map<string, { serverId: string; tools: MCPTool[] }>;
  /** Abstract tool names from orchestrator (e.g. 'Read', 'Write', 'Bash') to filter local tools */
  allowedTools?: string[];
  /** Timeout in ms (default: 600_000 / 10 min) */
  timeoutMs?: number;
  /** Working directory override for local tool calls (bypasses singleton) */
  workingDirectory?: string;
  /** Router phase hint for routed (`route:<profile>`) models. */
  routePhase?: LedgerPhase;
  /** Cancellation from the caller (run abort). Composed with `timeoutMs` into
   *  one signal that is passed to the provider client AND raced here, so the
   *  call returns promptly even when a buffered transport ignores the signal. */
  signal?: AbortSignal;
  /** Live stream events for display (text deltas, tool calls). */
  onEvent?: (e: AgentStreamEvent) => void;
}

// ============================================================================
// Tool Discovery
// ============================================================================

/**
 * Threshold above which we run an LLM discovery call to select tools.
 * ~40 tools × ~2K tokens/tool = ~80K tokens — safe margin under 200K limit.
 */
const TOOL_DISCOVERY_THRESHOLD = 40;

/**
 * Hard cap on tool definition tokens. Tool schemas average ~1.5K tokens each.
 * Leave ~100K for prompt + response within the 200K context window.
 */
const MAX_TOOL_TOKENS = 90_000;
const AVG_TOKENS_PER_TOOL = 1500;

/**
 * LLM-powered tool discovery: sends a compact tool index (names + short descriptions)
 * to the model and asks it to select which tools it needs for the task.
 * Returns a filtered tools map containing only the selected tools.
 */
async function discoverTools(
  tools: Map<string, { serverId: string; tools: MCPTool[] }>,
  opts: CallLLMOptions,
): Promise<Map<string, { serverId: string; tools: MCPTool[] }>> {
  // Build compact index of non-builtin tools
  const toolIndex: string[] = [];
  const toolLookup = new Map<string, { serverId: string; tool: MCPTool }>();

  for (const [key, { serverId, tools: serverTools }] of tools) {
    if (BUILTIN_SERVER_IDS.includes(key)) continue;
    for (const tool of serverTools) {
      toolIndex.push(`- ${tool.name}: ${(tool.description || '').slice(0, 120)}`);
      toolLookup.set(tool.name, { serverId, tool });
    }
  }

  const taskPreview = opts.userMessage.slice(0, 3000);

  const discoveryPrompt =
    `You are about to perform a task. Select ALL MCP tools you will need.\n\n` +
    `Available tools:\n${toolIndex.join('\n')}\n\n` +
    `Task context:\n${taskPreview}\n\n` +
    `System context:\n${(opts.systemPrompt || '').slice(0, 1000)}\n\n` +
    `Respond with ONLY a JSON array of tool name strings. Be inclusive — select every tool you might reasonably need.\n` +
    `Example: ["tool_a", "tool_b", "tool_c"]`;

  try {
    const start = Date.now();
    const result = await routeToProvider({
      ...opts,
      userMessage: discoveryPrompt,
      systemPrompt: 'You are a tool selector. Analyze the task and select all MCP tools that may be needed. Respond with ONLY a JSON array of tool name strings. Be generous — include any tool that could be useful.',
      skipTools: true,
      availableTools: undefined,
    });

    // Parse tool names from response
    const match = result.content.match(/\[[\s\S]*?\]/);
    let selectedNames: string[] = [];
    if (match) {
      try {
        selectedNames = JSON.parse(match[0]).filter((n: any) => typeof n === 'string');
      } catch { /* parse failure — fall through to fallback */ }
    }

    if (selectedNames.length === 0) {
      console.warn('[ToolDiscovery] No tools selected — sending all tools (will be capped)');
      return tools;
    }

    // Build filtered map — always keep built-in tools
    const filtered = new Map<string, { serverId: string; tools: MCPTool[] }>();
    for (const [key, value] of tools) {
      if (BUILTIN_SERVER_IDS.includes(key)) {
        filtered.set(key, value);
      }
    }
    for (const name of selectedNames) {
      const info = toolLookup.get(name);
      if (info) {
        if (!filtered.has(info.serverId)) {
          filtered.set(info.serverId, { serverId: info.serverId, tools: [] });
        }
        filtered.get(info.serverId)!.tools.push(info.tool);
      }
    }

    const selectedCount = countTools(filtered);
    console.log(`[ToolDiscovery] ${countTools(tools)} → ${selectedCount} tools in ${Date.now() - start}ms`);
    console.log(`[ToolDiscovery] Selected: ${selectedNames.join(', ')}`);
    return capToolTokens(filtered);
  } catch (err) {
    console.error('[ToolDiscovery] Discovery failed, sending all tools (will be capped):', err);
    return tools;
  }
}

/**
 * Cap tool definitions to stay within the token budget.
 * Drops non-builtin tools from the end until under the limit.
 */
function capToolTokens(
  tools: Map<string, { serverId: string; tools: MCPTool[] }>,
): Map<string, { serverId: string; tools: MCPTool[] }> {
  const total = countTools(tools);
  const estimatedTokens = total * AVG_TOKENS_PER_TOOL;
  if (estimatedTokens <= MAX_TOOL_TOKENS) return tools;

  const maxTools = Math.floor(MAX_TOOL_TOKENS / AVG_TOKENS_PER_TOOL);
  console.warn(`[ToolCap] ${total} tools (~${estimatedTokens} tokens) exceeds budget. Capping to ${maxTools} tools.`);

  const capped = new Map<string, { serverId: string; tools: MCPTool[] }>();
  let count = 0;

  // Always include builtin tools first
  for (const [key, value] of tools) {
    if (BUILTIN_SERVER_IDS.includes(key)) {
      capped.set(key, value);
      count += value.tools.length;
    }
  }

  // Add non-builtin tools until budget is reached
  for (const [key, value] of tools) {
    if (BUILTIN_SERVER_IDS.includes(key)) continue;
    const remaining = maxTools - count;
    if (remaining <= 0) break;
    if (value.tools.length <= remaining) {
      capped.set(key, value);
      count += value.tools.length;
    } else {
      capped.set(key, { serverId: value.serverId, tools: value.tools.slice(0, remaining) });
      count += remaining;
      break;
    }
  }

  console.log(`[ToolCap] Reduced to ${countTools(capped)} tools`);
  return capped;
}

// ============================================================================
// Router (delegates to unified llm-router)
// ============================================================================

/**
 * Route a call to the appropriate provider without tool discovery.
 * Used internally by discoverTools to avoid recursion into discovery.
 */
function routeToProvider(opts: CallLLMOptions): Promise<CallerResult> {
  const tools = opts.skipTools
    ? undefined
    : applyAllowedToolsFilter(opts.availableTools || new Map(), opts.allowedTools);

  // One signal = caller's abort ∪ per-call timeout (a TimeoutError reason).
  // Clients that honour it stop for real; the race covers the ones that don't.
  const signal = anySignal([opts.signal, opts.timeoutMs ? timeoutSignal(opts.timeoutMs, 'LLM call') : undefined]);
  return raceSignal(
    simpleCompletion({
      provider: opts.provider,
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      userMessage: opts.userMessage,
      availableTools: tools,
      workingDirectory: opts.workingDirectory,
      routePhase: opts.routePhase,
      // CLI binaries (anthropic-cli) get the real per-call timeout and the
      // orchestrator's abstract tool scope instead of a hardcoded 10 min + all tools.
      timeoutMs: opts.timeoutMs,
      allowedToolNames: opts.skipTools ? undefined : opts.allowedTools,
      skipTools: opts.skipTools,
      signal,
      onEvent: opts.onEvent,
    }),
    signal,
  );
}

/**
 * Unified LLM caller for GUI pipeline execution.
 *
 * Automatically runs LLM tool discovery when the tool count exceeds the
 * threshold, asking the model to select which tools it needs before the
 * real call.
 */
export async function callLLM(opts: CallLLMOptions): Promise<CallerResult> {
  // Auto-discover tools when there are too many to send directly
  if (!opts.skipTools && opts.availableTools && countTools(opts.availableTools) > TOOL_DISCOVERY_THRESHOLD) {
    const discovered = await discoverTools(opts.availableTools, opts);
    opts = { ...opts, availableTools: discovered };
  }

  // Safety cap: ensure tool definitions don't blow the token budget even after discovery
  if (opts.availableTools) {
    opts = { ...opts, availableTools: capToolTokens(opts.availableTools) };
  }

  return routeToProvider(opts);
}
