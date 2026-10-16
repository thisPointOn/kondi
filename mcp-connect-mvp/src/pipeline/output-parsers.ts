/**
 * Shared Output Parsers
 *
 * Parsing functions for Claude CLI stream-json and Codex CLI JSONL output.
 * Used by both the GUI caller (Tauri invoke) and CLI caller (Node.js spawn).
 */

export interface ParsedOutput {
  text: string;
  tokensUsed: number;
  sessionId?: string;
  /** Real usage split from the CLI's stream events (0 when not reported). */
  inputTokens?: number;
  outputTokens?: number;
  /** Tool calls the CLI binary actually made (tool_use blocks / function_call items). */
  toolCalls?: number;
}

/**
 * Check if a model ID corresponds to an OpenAI model (routes to Codex CLI).
 */
export function isOpenAIModel(model: string): boolean {
  return /^(gpt-|o[1-9]|codex|davinci|chatgpt)/.test(model);
}

/**
 * Parse raw stream-json output from Claude CLI.
 * Handles the `--output-format stream-json` JSONL stream.
 */
export function parseStreamJsonOutput(rawOutput: string): ParsedOutput {
  if (!rawOutput.includes('{"type":')) {
    return { text: rawOutput, tokensUsed: 0 };
  }

  const lines = rawOutput.split('\n').filter(l => l.trim());
  let resultText = '';
  let isErrorResult = false;
  const textChunks: string[] = [];
  const errorChunks: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let sessionId: string | undefined;

  for (const line of lines) {
    try {
      const json = JSON.parse(line);

      // Extract session_id from init event or result
      if (json.session_id && !sessionId) {
        sessionId = json.session_id;
      }

      if (json.type === 'result' && json.result) {
        resultText = typeof json.result === 'string' ? json.result : JSON.stringify(json.result);
        if (json.is_error) isErrorResult = true;
        if (json.session_id) sessionId = json.session_id;
      }

      if (json.type === 'error') {
        const errText = json.error || json.body || JSON.stringify(json);
        errorChunks.push(typeof errText === 'string' ? errText : JSON.stringify(errText));
      }

      if (json.type === 'assistant' && json.message?.content) {
        for (const block of json.message.content) {
          if (block.type === 'text' && block.text) {
            textChunks.push(block.text);
          }
          if (block.type === 'tool_use') toolCalls++;
        }
        if (json.message?.usage) {
          inputTokens += json.message.usage.input_tokens || 0;
          outputTokens += json.message.usage.output_tokens || 0;
        }
      }

      // NOTE: with `--include-partial-messages` text deltas arrive wrapped as
      // {"type":"stream_event","event":{"type":"content_block_delta",...}} while
      // the `assistant` events still carry the FULL text — so deltas are for
      // live display only (createStreamJsonAccumulator) and are never appended
      // here, or the text would double.
    } catch {
      // Not valid JSON, skip
    }
  }

  const parts: string[] = [];
  if (textChunks.length > 0) parts.push(textChunks.join(''));
  if (resultText) {
    const combined = parts.join('');
    if (!combined.endsWith(resultText)) {
      parts.push(isErrorResult ? '\n\nError: ' + resultText : '\n\n' + resultText);
    }
  }
  if (errorChunks.length > 0) {
    const errText = errorChunks.join('; ');
    if (!parts.some(p => p.includes(errText))) {
      parts.push('\n\nError: ' + errText);
    }
  }

  const text = parts.length > 0 ? parts.join('').trim() : rawOutput;
  return { text, tokensUsed: inputTokens + outputTokens, sessionId, inputTokens, outputTokens, toolCalls };
}

// ============================================================================
// Live accumulator (display-only) for `--include-partial-messages` streams
// ============================================================================

export type StreamJsonEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { kind: 'tool_result'; id: string; name: string; ok: boolean; chars: number; durationMs: number }
  | { kind: 'turn'; index: number; usage?: { inputTokens: number; outputTokens: number } };

export interface StreamJsonAccumulator {
  /** Feed one complete JSONL line. */
  feed(line: string): void;
  /** Feed a raw chunk (may contain partial lines); complete lines are processed, the rest buffered. */
  feedChunk(chunk: string): void;
  /** Process any buffered partial line. */
  flush(): void;
  /** Running usage totals across turns. */
  readonly usage: { inputTokens: number; outputTokens: number; turns: number };
}

/**
 * Turns a Claude CLI stream-json stream (with `--include-partial-messages`) into
 * live events: text deltas (from `stream_event` content_block_delta), tool
 * calls (from `assistant` tool_use blocks), tool results (from `user`
 * tool_result blocks) and per-turn usage. DISPLAY ONLY — the final text still
 * comes from `parseStreamJsonOutput` over the full output, so nothing doubles.
 */
export function createStreamJsonAccumulator(onEvent: (e: StreamJsonEvent) => void): StreamJsonAccumulator {
  const usage = { inputTokens: 0, outputTokens: 0, turns: 0 };
  const pendingTools = new Map<string, { name: string; startedAt: number }>();
  let buffer = '';
  const emit = (e: StreamJsonEvent) => { try { onEvent(e); } catch { /* listeners never break the stream */ } };

  const feed = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    let json: any;
    try { json = JSON.parse(trimmed); } catch { return; }

    if (json.type === 'stream_event' && json.event) {
      const ev = json.event;
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        emit({ kind: 'text', delta: ev.delta.text });
      }
      return;
    }
    if (json.type === 'assistant' && json.message) {
      for (const block of json.message.content || []) {
        if (block.type === 'tool_use' && block.id) {
          pendingTools.set(block.id, { name: block.name || 'tool', startedAt: Date.now() });
          emit({ kind: 'tool_call', id: block.id, name: block.name || 'tool', args: (block.input && typeof block.input === 'object') ? block.input : {} });
        }
      }
      const u = json.message.usage;
      if (u) {
        usage.inputTokens += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        usage.outputTokens += u.output_tokens || 0;
      }
      usage.turns++;
      emit({ kind: 'turn', index: usage.turns, usage: u ? { inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 } : undefined });
      return;
    }
    if (json.type === 'user' && json.message) {
      for (const block of json.message.content || []) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const pending = pendingTools.get(block.tool_use_id);
          pendingTools.delete(block.tool_use_id);
          const content = block.content;
          const chars = typeof content === 'string' ? content.length
            : Array.isArray(content) ? content.reduce((n: number, c: any) => n + (typeof c?.text === 'string' ? c.text.length : 0), 0)
            : 0;
          emit({
            kind: 'tool_result', id: block.tool_use_id, name: pending?.name || 'tool',
            ok: !block.is_error, chars, durationMs: pending ? Date.now() - pending.startedAt : 0,
          });
        }
      }
    }
  };

  return {
    usage,
    feed,
    feedChunk(chunk: string) {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        feed(line);
      }
    },
    flush() {
      if (buffer.trim()) feed(buffer);
      buffer = '';
    },
  };
}

/**
 * Parse JSONL output from `codex exec --json`.
 *
 * Event types:
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"...","type":"agent_message","text":"..."}}
 *   {"type":"item.completed","item":{"id":"...","type":"reasoning","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N}}
 */
export function parseCodexJsonOutput(rawOutput: string): ParsedOutput {
  const lines = rawOutput.split('\n').filter(l => l.trim());
  const textChunks: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let sessionId: string | undefined;

  for (const line of lines) {
    try {
      const json = JSON.parse(line);

      if (json.type === 'item.completed' && json.item && /function_call|command_execution|mcp_tool_call|file_change|tool/i.test(String(json.item.type || ''))) {
        toolCalls++;
      }

      if (json.type === 'thread.started' && json.thread_id) {
        sessionId = json.thread_id;
      }

      if (json.type === 'item.completed' && json.item) {
        if (json.item.type === 'agent_message' && json.item.text) {
          textChunks.push(json.item.text);
        }
        // Skip reasoning items — they're internal thought, not output
      }

      if (json.type === 'turn.completed' && json.usage) {
        inputTokens += json.usage.input_tokens || 0;
        outputTokens += json.usage.output_tokens || 0;
      }

      if (json.type === 'error') {
        const errText = json.message || json.error || JSON.stringify(json);
        textChunks.push(`\n\nError: ${errText}`);
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  const text = textChunks.join('\n').trim() || rawOutput;
  return { text, tokensUsed: inputTokens + outputTokens, sessionId, inputTokens, outputTokens, toolCalls };
}
