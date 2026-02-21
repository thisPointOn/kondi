import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SlackClient } from '../client.js';
import type { ConversationsRepliesResponse } from '../types.js';

const getThreadSchema = {
  channel: z
    .string()
    .describe('Channel ID where the thread exists (e.g., C01234ABCDE).'),
  ts: z
    .string()
    .describe('Thread parent timestamp (e.g., 1234567890.123456). This is the ts of the original message that started the thread.'),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe('Number of replies to return. Default: 20. Max: 100.'),
};

export function registerGetThreadTool(server: McpServer, client: SlackClient): void {
  server.tool(
    'slack_get_thread',
    'Retrieve all replies in a Slack thread. Requires the channel ID and the parent message timestamp (ts). The first message in the response is the thread parent.',
    getThreadSchema,
    async ({ channel, ts, limit = 20 }) => {
      const sanitizedLimit = Math.min(Math.max(1, limit), 100);

      try {
        const response = await client.call<ConversationsRepliesResponse>(
          'conversations.replies',
          { channel, ts, limit: sanitizedLimit }
        );

        const messages = response.messages.map((msg) => ({
          user: msg.user || msg.bot_id || 'unknown',
          text: msg.text,
          ts: msg.ts,
          thread_ts: msg.thread_ts || null,
          reactions: msg.reactions || [],
        }));

        const result = {
          channel,
          thread_ts: ts,
          messages,
          reply_count: messages.length > 0 ? messages.length - 1 : 0, // exclude parent
          has_more: response.has_more || false,
        };

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                channel,
                thread_ts: ts,
                hint: message.includes('thread_not_found')
                  ? 'Make sure the thread timestamp (ts) is correct.'
                  : message.includes('channel_not_found')
                    ? 'Make sure the channel ID is correct and the bot has access.'
                    : undefined,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
