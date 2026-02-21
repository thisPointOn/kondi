import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SlackClient } from '../client.js';
import type { ReactionsGetResponse } from '../types.js';

const getReactionsSchema = {
  channel: z
    .string()
    .describe('Channel ID where the message exists (e.g., C01234ABCDE).'),
  message_ts: z
    .string()
    .describe('Timestamp of the message to get reactions for (e.g., 1234567890.123456).'),
};

export function registerGetReactionsTool(server: McpServer, client: SlackClient): void {
  server.tool(
    'slack_get_reactions',
    'Get all reactions on a specific message. Returns the list of emoji reactions with the count and users who reacted.',
    getReactionsSchema,
    async ({ channel, message_ts }) => {
      try {
        const response = await client.call<ReactionsGetResponse>('reactions.get', {
          channel,
          timestamp: message_ts,
          full: true,
        });

        const reactions = (response.message?.reactions || []).map((reaction) => ({
          name: reaction.name,
          count: reaction.count,
          users: reaction.users,
        }));

        const result = {
          channel,
          message_ts,
          reactions,
          reaction_count: reactions.length,
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
                message_ts,
                hint: message.includes('message_not_found')
                  ? 'The message was not found. Check the channel ID and timestamp.'
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
