import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DiscordClient } from '../client.js';
import type { Config } from '../types.js';

const listGuildChannelsSchema = {
  guild_id: z.string().describe('The ID of the guild (server) to list channels for.'),
};

export function registerListGuildChannelsTool(server: McpServer, config: Config): void {
  const client = new DiscordClient(config);

  server.tool(
    'discord_list_guild_channels',
    'List all channels in a Discord guild (server). Returns channel names, types, topics, and positions.',
    listGuildChannelsSchema,
    async ({ guild_id }) => {
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
        const channels = await client.listGuildChannels(guild_id);

        const result = {
          guild_id,
          count: channels.length,
          channels,
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
                guild_id,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
