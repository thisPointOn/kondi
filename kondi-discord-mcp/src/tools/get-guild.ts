import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DiscordClient } from '../client.js';
import type { Config } from '../types.js';

const getGuildSchema = {
  guild_id: z.string().describe('The ID of the guild (server) to get information about.'),
};

export function registerGetGuildTool(server: McpServer, config: Config): void {
  const client = new DiscordClient(config);

  server.tool(
    'discord_get_guild',
    'Get detailed information about a Discord server (guild) including name, description, member count, icon, owner, and features.',
    getGuildSchema,
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
        const guild = await client.getGuild(guild_id);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(guild, null, 2),
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
