import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SlackClient } from '../client.js';
import type { ChatDeleteResponse } from '../types.js';

const deleteMessageSchema = {
  channel: z
    .string()
    .describe('Channel ID where the message exists (e.g., C01234ABCDE).'),
  message_ts: z
    .string()
    .describe("The timestamp ID of the message to delete (e.g. '1234567890.123456')."),
};

export function registerDeleteMessageTool(server: McpServer, client: SlackClient): void {
  server.tool(
    'slack_delete_message',
    'Delete a message from a channel. The bot can delete its own messages, or any message in channels where it has appropriate permissions.',
    deleteMessageSchema,
    async ({ channel, message_ts }) => {
      try {
        const response = await client.call<ChatDeleteResponse>('chat.delete', {
          channel,
          ts: message_ts,
        });

        const result = {
          ok: true,
          channel: response.channel,
          ts: response.ts,
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
                  ? 'The message was not found. Check the channel ID and message timestamp.'
                  : message.includes('cant_delete_message')
                    ? 'The bot does not have permission to delete this message.'
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
