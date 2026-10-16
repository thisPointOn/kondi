/**
 * Live "thinking" tail — the few hundred characters a watcher sees under a
 * persona while it works: streamed text plus tool calls rendered as
 * `→ name(args)` and results as `✓/✗ name (chars, s)`. Pure; capped.
 */
import type { AgentStreamEvent } from '../agent-runtime/types';

export const STREAM_TAIL_CAP = 2000;

function previewArgs(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 80 ? `${s.slice(0, 77)}…` : s;
  } catch { return '…'; }
}

export function formatStreamEvent(e: AgentStreamEvent): string {
  switch (e.kind) {
    case 'text': return e.delta;
    case 'tool_call': return `\n→ ${e.name}(${previewArgs(e.args)})\n`;
    case 'tool_result': return `${e.ok ? '✓' : '✗'} ${e.name} (${e.chars} chars${e.durationMs ? `, ${(e.durationMs / 1000).toFixed(1)}s` : ''})\n`;
    case 'turn': return '';
  }
}

/** Append one event to a tail, keeping only the last STREAM_TAIL_CAP chars. */
export function appendStreamTail(prev: string, e: AgentStreamEvent, cap = STREAM_TAIL_CAP): string {
  const next = (prev || '') + formatStreamEvent(e);
  return next.length > cap ? next.slice(next.length - cap) : next;
}
