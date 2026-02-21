import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DiscordClient } from '../client.js';
import type { Config } from '../types.js';

const getPinnedMessagesSchema = {
  channel_id: z.string().describe('The ID of the channel to get pinned messages from.'),
};

export function registerGetPinnedMessagesTool(server: McpServer, config: Config): void {
  const client = new DiscordClient(config);

  server.tool(
    'discord_get_pinned_messages',
    'Get all pinned messages in a channel. Returns the full message objects for every pinned message.',
    getPinnedMessagesSchema,
    async ({ channel_id }) => {
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
        const messages = await client.getPinnedMessages(channel_id);

        const result = {
          channel_id,
          count: messages.length,
          messages,
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
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: errorMessage,
                channel_id,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
