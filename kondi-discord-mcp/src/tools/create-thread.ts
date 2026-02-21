import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DiscordClient } from '../client.js';
import type { Config } from '../types.js';

const createThreadSchema = {
  channel_id: z.string().describe('The ID of the channel containing the message to create a thread from.'),
  message_id: z.string().describe('The ID of the message to create a thread from.'),
  name: z.string().max(100).describe('The name of the thread (max 100 characters).'),
  auto_archive_duration: z
    .enum(['60', '1440', '4320', '10080'])
    .transform(Number)
    .optional()
    .describe(
      'Auto-archive duration in minutes. 60=1hr, 1440=24hr, 4320=3days, 10080=1week.'
    ),
};

export function registerCreateThreadTool(server: McpServer, config: Config): void {
  const client = new DiscordClient(config);

  server.tool(
    'discord_create_thread',
    'Create a new thread from an existing message. Threads are sub-conversations that keep channels organized. Auto-archive duration is in minutes (60=1hr, 1440=24hr, 4320=3days, 10080=1week).',
    createThreadSchema,
    async ({ channel_id, message_id, name, auto_archive_duration }) => {
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

      if (!name || name.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Thread name cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const thread = await client.createThread(
          channel_id,
          message_id,
          name,
          auto_archive_duration
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(thread, null, 2),
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
                name,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
