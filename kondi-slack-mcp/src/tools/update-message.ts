import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SlackClient } from '../client.js';
import type { ChatUpdateResponse } from '../types.js';

const updateMessageSchema = {
  channel: z
    .string()
    .describe('Channel ID where the message exists (e.g., C01234ABCDE).'),
  message_ts: z
    .string()
    .describe("The timestamp ID of the message to update (e.g. '1234567890.123456')."),
  text: z
    .string()
    .describe('The new message text. Supports Slack mrkdwn formatting.'),
};

export function registerUpdateMessageTool(server: McpServer, client: SlackClient): void {
  server.tool(
    'slack_update_message',
    "Update an existing message. Only messages posted by the bot can be updated. The message_ts acts as the message's unique ID.",
    updateMessageSchema,
    async ({ channel, message_ts, text }) => {
      if (!text || text.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Message text cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await client.call<ChatUpdateResponse>('chat.update', {
          channel,
          ts: message_ts,
          text,
        });

        const result = {
          ok: true,
          channel: response.channel,
          ts: response.ts,
          text: response.text,
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
                  : message.includes('cant_update_message')
                    ? 'Only messages posted by the bot can be updated.'
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
