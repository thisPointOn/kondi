/**
 * Agent runtime — shared types.
 *
 * ONE provider-neutral tool loop (`tool-loop.ts`) drives any model that can
 * call tools, through a small `ToolLoopAdapter` per wire format and a
 * `ToolExecutor` that actually runs the tools. This module is safe in BOTH the
 * webview and Node (no Tauri / node imports); backends live in `./node/` and
 * `src/services/guiToolExecutor.ts`.
 */

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallContext {
  workingDir?: string;
  signal?: AbortSignal;
}

export interface ToolExecutor {
  list(): ToolDef[];
  /** Resolve to a string (JSON-stringify objects). Throw to report a tool error. */
  call(name: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<string>;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface UsageTotals extends TurnUsage {
  apiTurns: number;
  toolCalls: number;
  /** False when at least one turn reported no usage (totals are then partial/estimated). */
  reported: boolean;
}

/** Live events for the UI/CLI — tool calls are far more informative than tokens for a worker. */
export type AgentStreamEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { kind: 'tool_result'; id: string; name: string; ok: boolean; chars: number; durationMs: number }
  | { kind: 'turn'; index: number; usage?: TurnUsage };

export interface LoopToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Raw argument string when it could not be parsed (reported back to the model as an error). */
  rawArgs?: string;
}

/** Provider-neutral conversation state kept by the loop. */
export type LoopMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LoopToolCall[]; native?: unknown }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ModelTurn {
  text: string;
  toolCalls: LoopToolCall[];
  usage?: TurnUsage;
  stopReason?: string;
  /** Provider-native assistant message to replay verbatim next turn (keeps tool ids/formats intact). */
  native?: unknown;
}

export interface TurnRequest {
  system: string;
  messages: LoopMessage[];
  tools: ToolDef[];
  signal: AbortSignal;
  onText?: (delta: string) => void;
}

/** One provider wire format: build the request, stream/parse the response, extract tool calls. */
export interface ToolLoopAdapter {
  readonly provider: string;
  readonly model: string;
  turn(req: TurnRequest): Promise<ModelTurn>;
}

export interface RunToolLoopOptions {
  adapter: ToolLoopAdapter;
  /** No executor (or no tools listed) → a plain single completion. */
  executor?: ToolExecutor;
  system: string;
  userMessage: string;
  maxTurns?: number;            // default 25
  perToolTimeoutMs?: number;    // default 300_000
  resultCapChars?: number;      // default 30_000 — cap for THIS turn's tool results
  oldResultCapChars?: number;   // default 2_000  — compress tool results from earlier turns
  workingDir?: string;
  signal?: AbortSignal;
  onEvent?: (e: AgentStreamEvent) => void;
}

export interface RunToolLoopResult {
  content: string;
  usage: UsageTotals;
  turns: number;
  hitMaxTurns: boolean;
}
