import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DiscordClient } from '../client.js';
import type { Config } from '../types.js';

const getMessagesSchema = {
  channel_id: z.string().describe('The ID of the channel to retrieve messages from.'),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(50)
    .describe('Number of messages to retrieve. Default: 50. Max: 100.'),
};

export function registerGetMessagesTool(server: McpServer, config: Config): void {
  const client = new DiscordClient(config);

  server.tool(
    'discord_get_messages',
    'Retrieve recent messages from a Discord channel. Returns up to 100 messages with author, content, timestamps, and embeds.',
    getMessagesSchema,
    async ({ channel_id, limit = 50 }) => {
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
        const messages = await client.getMessages(channel_id, limit);

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
