/**
 * Agent runtime — THE tool loop.
 *
 * One provider-neutral agentic loop: ask the model, run every tool it calls
 * (with a per-tool timeout and result cap), feed the results back, repeat until
 * the model stops calling tools or `maxTurns` is hit. Never throws because of
 * a bad tool call (unknown tool / malformed args become error tool results the
 * model can recover from); DOES throw on abort or on adapter (network) errors.
 *
 * Usage is summed across ALL turns (every turn re-reads the context and is
 * billed) and flagged `reported: false` when any turn lacked usage.
 */
import type {
  RunToolLoopOptions, RunToolLoopResult, LoopMessage, LoopToolCall, UsageTotals, TurnUsage,
} from './types';
import { throwIfAborted, withSignal, isAbortError, isTimeoutError } from './signals';

const DEFAULTS = {
  maxTurns: 25,
  perToolTimeoutMs: 300_000,
  resultCapChars: 30_000,
  oldResultCapChars: 2_000,
};

function cap(s: string, n: number, note = 'truncated'): string {
  if (s.length <= n) return s;
  const keep = Math.max(0, n - 60);
  return `${s.slice(0, keep)}\n…[${note}: ${s.length - keep} more chars]`;
}

function addUsage(total: UsageTotals, u?: TurnUsage): void {
  if (!u) { total.reported = false; return; }
  total.inputTokens += u.inputTokens || 0;
  total.outputTokens += u.outputTokens || 0;
  if (u.cacheReadTokens) total.cacheReadTokens = (total.cacheReadTokens || 0) + u.cacheReadTokens;
  if (u.cacheWriteTokens) total.cacheWriteTokens = (total.cacheWriteTokens || 0) + u.cacheWriteTokens;
}

export async function runToolLoop(opts: RunToolLoopOptions): Promise<RunToolLoopResult> {
  const maxTurns = opts.maxTurns ?? DEFAULTS.maxTurns;
  const perToolTimeoutMs = opts.perToolTimeoutMs ?? DEFAULTS.perToolTimeoutMs;
  const resultCap = opts.resultCapChars ?? DEFAULTS.resultCapChars;
  const oldCap = opts.oldResultCapChars ?? DEFAULTS.oldResultCapChars;
  const signal = opts.signal ?? new AbortController().signal;
  const tools = opts.executor?.list() ?? [];
  const usage: UsageTotals = { inputTokens: 0, outputTokens: 0, apiTurns: 0, toolCalls: 0, reported: true };

  const messages: LoopMessage[] = [...(opts.history ?? []), { role: 'user', content: opts.userMessage }];
  const texts: string[] = [];
  let turns = 0;
  let hitMaxTurns = false;

  while (true) {
    throwIfAborted(signal);
    if (turns >= maxTurns) { hitMaxTurns = true; break; }

    // Compress tool results from EARLIER turns so the context doesn't balloon.
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'tool' && m.content.length > oldCap) messages[i] = { ...m, content: cap(m.content, oldCap, 'older result compressed') };
    }

    const turn = await opts.adapter.turn({
      system: opts.system,
      messages,
      tools,
      signal,
      onText: opts.onEvent ? (delta) => opts.onEvent!({ kind: 'text', delta }) : undefined,
    });
    turns++;
    usage.apiTurns++;
    addUsage(usage, turn.usage);
    opts.onEvent?.({ kind: 'turn', index: turns, usage: turn.usage });
    if (turn.text.trim()) texts.push(turn.text);

    const calls: LoopToolCall[] = tools.length ? turn.toolCalls : [];
    messages.push({ role: 'assistant', content: turn.text, toolCalls: calls.length ? calls : undefined, native: turn.native });
    if (calls.length === 0) break;

    for (const call of calls) {
      throwIfAborted(signal);
      usage.toolCalls++;
      opts.onEvent?.({ kind: 'tool_call', id: call.id, name: call.name, args: call.args });
      const started = Date.now();
      let content: string;
      let ok = true;
      if (call.rawArgs !== undefined) {
        ok = false;
        content = `Error: tool arguments were not valid JSON: ${cap(call.rawArgs, 500)}`;
      } else {
        try {
          const out = await withSignal(signal, perToolTimeoutMs, `tool ${call.name}`, (sig) =>
            opts.executor!.call(call.name, call.args, { workingDir: opts.workingDir, signal: sig }));
          content = cap(out ?? '', resultCap);
        } catch (err) {
          // A parent abort must stop the loop; a per-tool timeout or tool error is reported to the model.
          if (signal.aborted) throwIfAborted(signal);
          ok = false;
          const msg = err instanceof Error ? err.message : String(err);
          content = isTimeoutError(err) || isAbortError(err)
            ? `Error: tool ${call.name} ${msg}`
            : `Error: ${msg}`;
        }
      }
      opts.onEvent?.({ kind: 'tool_result', id: call.id, name: call.name, ok, chars: content.length, durationMs: Date.now() - started });
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content, isError: !ok });
    }
  }

  return {
    content: texts.join('\n\n').trim(),
    usage,
    turns,
    hitMaxTurns,
  };
}
