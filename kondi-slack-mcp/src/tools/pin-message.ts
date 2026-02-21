import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SlackClient } from '../client.js';
import type { PinsAddResponse } from '../types.js';

const pinMessageSchema = {
  channel: z
    .string()
    .describe('Channel ID where the message exists (e.g., C01234ABCDE).'),
  message_ts: z
    .string()
    .describe("Timestamp of the message to pin (e.g. '1234567890.123456')."),
};

export function registerPinMessageTool(server: McpServer, client: SlackClient): void {
  server.tool(
    'slack_pin_message',
    "Pin a message in a channel so it's easily accessible from the channel details. Pinned items appear in the channel's pinned items list.",
    pinMessageSchema,
    async ({ channel, message_ts }) => {
      try {
        await client.call<PinsAddResponse>('pins.add', {
          channel,
          timestamp: message_ts,
        });

        const result = {
          ok: true,
          channel,
          message_ts,
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
                hint: message.includes('already_pinned')
                  ? 'This message is already pinned in the channel.'
                  : message.includes('message_not_found')
                    ? 'The message was not found. Check the channel ID and timestamp.'
                    : message.includes('channel_not_found')
                      ? 'Make sure the channel ID is correct and the bot has access.'
                      : message.includes('no_permission')
                        ? 'The bot does not have permission to pin messages in this channel.'
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
