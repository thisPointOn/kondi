/**
 * Chat → tool-loop history. Everything before the last user message becomes
 * `history` (earlier tool calls folded into assistant text — their ids belong
 * to previous API calls and cannot be replayed); the last user message is the
 * loop's `userMessage`.
 */
import type { Message } from '../types/mcp';
import type { LoopMessage } from '../agent-runtime/types';
import { formatToolCallSummary } from './formatToolCallSummary';

export function toLoopHistory(messages: Message[]): { history: LoopMessage[]; userMessage: string } {
  const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  let lastUserIdx = -1;
  for (let k = turns.length - 1; k >= 0; k--) if (turns[k].role === 'user') { lastUserIdx = k; break; }
  const lastUser = lastUserIdx >= 0 ? turns[lastUserIdx] : undefined;
  const historySrc = lastUserIdx >= 0 ? turns.slice(0, lastUserIdx) : turns;
  const history: LoopMessage[] = historySrc.map((m) => m.role === 'assistant'
    ? { role: 'assistant' as const, content: m.toolCalls?.length ? `${m.content}\n\n${formatToolCallSummary(m.toolCalls)}` : m.content }
    : { role: 'user' as const, content: m.content });
  return { history, userMessage: lastUser?.content || '' };
}
