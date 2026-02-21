import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DiscordClient } from '../client.js';
import type { Config } from '../types.js';

const getChannelSchema = {
  channel_id: z.string().describe('The ID of the channel to get information about.'),
};

export function registerGetChannelTool(server: McpServer, config: Config): void {
  const client = new DiscordClient(config);

  server.tool(
    'discord_get_channel',
    'Get detailed information about a Discord channel including name, topic, type, and position.',
    getChannelSchema,
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
        const channel = await client.getChannel(channel_id);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(channel, null, 2),
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
