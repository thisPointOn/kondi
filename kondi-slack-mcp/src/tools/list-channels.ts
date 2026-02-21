import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SlackClient } from '../client.js';
import type { ConversationsListResponse } from '../types.js';

const listChannelsSchema = {
  limit: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .default(20)
    .describe('Number of channels to return. Default: 20. Max: 200.'),
  types: z
    .string()
    .optional()
    .default('public_channel')
    .describe(
      'Comma-separated channel types to include. Options: public_channel, private_channel, mpim, im. Default: public_channel.'
    ),
};

export function registerListChannelsTool(server: McpServer, client: SlackClient): void {
  server.tool(
    'slack_list_channels',
    'List Slack channels the bot has access to. Returns channel ID, name, topic, purpose, and member count. Use this to discover channel IDs for other tools.',
    listChannelsSchema,
    async ({ limit = 20, types = 'public_channel' }) => {
      const sanitizedLimit = Math.min(Math.max(1, limit), 200);

      try {
        const response = await client.call<ConversationsListResponse>(
          'conversations.list',
          {
            limit: sanitizedLimit,
            types,
            exclude_archived: true,
          }
        );

        const channels = response.channels.map((ch) => ({
          id: ch.id,
          name: ch.name,
          is_private: ch.is_private || false,
          is_archived: ch.is_archived || false,
          topic: ch.topic?.value || '',
          purpose: ch.purpose?.value || '',
          num_members: ch.num_members || 0,
        }));

        const result = {
          channels,
          channel_count: channels.length,
          types,
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
                hint: message.includes('missing_scope')
                  ? 'The bot token needs the channels:read scope. Check your Slack app permissions.'
                  : message.includes('token')
                    ? 'Check your KONDI_SLACK_BOT_TOKEN configuration.'
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
