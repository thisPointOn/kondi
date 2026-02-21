import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DiscordClient } from '../client.js';
import type { Config } from '../types.js';

const getGuildMembersSchema = {
  guild_id: z.string().describe('The ID of the guild (server) to list members for.'),
  limit: z
    .number()
    .min(1)
    .max(1000)
    .optional()
    .default(100)
    .describe('Number of members to retrieve. Default: 100. Max: 1000.'),
};

export function registerGetGuildMembersTool(server: McpServer, config: Config): void {
  const client = new DiscordClient(config);

  server.tool(
    'discord_get_guild_members',
    'List members of a Discord server. Returns user info, nicknames, roles, and join dates. Requires Server Members Intent for large servers.',
    getGuildMembersSchema,
    async ({ guild_id, limit = 100 }) => {
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
        const members = await client.getGuildMembers(guild_id, limit);

        const result = {
          guild_id,
          count: members.length,
          members,
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
