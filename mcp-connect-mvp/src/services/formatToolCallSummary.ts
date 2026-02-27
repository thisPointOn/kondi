import type { ToolCall } from '../types/mcp';

const MAX_RESULT_LENGTH = 500;

function truncate(value: any): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.length <= MAX_RESULT_LENGTH) return str;
  return str.slice(0, MAX_RESULT_LENGTH) + '…';
}

/**
 * Format tool calls into a text summary that can be injected into
 * conversation history so the model remembers what tools it executed.
 */
export function formatToolCallSummary(toolCalls: ToolCall[]): string {
  const lines = toolCalls.map((tc, i) => {
    const args = JSON.stringify(tc.arguments);
    if (tc.status === 'failed') {
      return `${i + 1}. ${tc.toolName}(${args}) → ERROR: ${tc.error || 'Unknown error'}`;
    }
    const result = tc.result !== undefined ? truncate(tc.result) : 'no result';
    return `${i + 1}. ${tc.toolName}(${args}) → ${result}`;
  });

  return `[Tool Calls Executed]\n${lines.join('\n')}`;
}
