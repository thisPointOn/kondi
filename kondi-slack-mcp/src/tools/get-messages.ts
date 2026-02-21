import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SlackClient } from '../client.js';
import type { ConversationsHistoryResponse } from '../types.js';

const getMessagesSchema = {
  channel: z
    .string()
    .describe('Channel ID to fetch messages from (e.g., C01234ABCDE).'),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe('Number of messages to return. Default: 20. Max: 100.'),
};

export function registerGetMessagesTool(server: McpServer, client: SlackClient): void {
  server.tool(
    'slack_get_messages',
    'Retrieve recent messages from a Slack channel. Returns messages in reverse chronological order (newest first). Each message includes user, text, timestamp, and thread info.',
    getMessagesSchema,
    async ({ channel, limit = 20 }) => {
      const sanitizedLimit = Math.min(Math.max(1, limit), 100);

      try {
        const response = await client.call<ConversationsHistoryResponse>(
          'conversations.history',
          { channel, limit: sanitizedLimit }
        );

        const messages = response.messages.map((msg) => ({
          user: msg.user || msg.bot_id || 'unknown',
          text: msg.text,
          ts: msg.ts,
          thread_ts: msg.thread_ts || null,
          reply_count: msg.reply_count || 0,
          reactions: msg.reactions || [],
        }));

        const result = {
          channel,
          messages,
          message_count: messages.length,
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
                hint: message.includes('channel_not_found')
                  ? 'Make sure the channel ID is correct and the bot has access.'
                  : message.includes('not_in_channel')
                    ? 'The bot needs to be invited to this channel first.'
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
