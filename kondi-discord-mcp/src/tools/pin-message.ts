import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DiscordClient } from '../client.js';
import type { Config } from '../types.js';

const pinMessageSchema = {
  channel_id: z.string().describe('The ID of the channel containing the message.'),
  message_id: z.string().describe('The ID of the message to pin.'),
};

export function registerPinMessageTool(server: McpServer, config: Config): void {
  const client = new DiscordClient(config);

  server.tool(
    'discord_pin_message',
    'Pin a message in a channel. Pinned messages are highlighted and easily accessible. Channels can have up to 50 pinned messages.',
    pinMessageSchema,
    async ({ channel_id, message_id }) => {
      if (!client.hasToken()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'Bot token not configured. Set KONDI_DISCORD_BOT_TOKEN or add auth.bot_token to config.',
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        await client.pinMessage(channel_id, message_id);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  channel_id,
                  message_id,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: errorMessage,
                channel_id,
                message_id,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
