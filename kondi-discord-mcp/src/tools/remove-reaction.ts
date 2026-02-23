import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DiscordClient } from '../client.js';
import type { Config } from '../types.js';

const removeReactionSchema = {
  channel_id: z.string().describe('The ID of the channel containing the message.'),
  message_id: z.string().describe('The ID of the message to remove the reaction from.'),
  emoji: z
    .string()
    .describe(
      'The emoji to remove. Use Unicode emoji (e.g., "\u{1F44D}") or custom emoji format "name:id".'
    ),
};

export function registerRemoveReactionTool(server: McpServer, config: Config): void {
  const client = new DiscordClient(config);

  server.tool(
    'discord_remove_reaction',
    "Remove your bot's reaction from a message. Use Unicode emoji (e.g. thumbs up) or custom emoji format 'name:id'.",
    removeReactionSchema,
    async ({ channel_id, message_id, emoji }) => {
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

      if (!emoji || emoji.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Emoji cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      try {
        await client.removeReaction(channel_id, message_id, emoji);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  channel_id,
                  message_id,
                  emoji,
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
                emoji,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
