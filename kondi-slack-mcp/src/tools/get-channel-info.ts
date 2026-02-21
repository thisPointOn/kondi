import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SlackClient } from '../client.js';
import type { ConversationsInfoResponse } from '../types.js';

const getChannelInfoSchema = {
  channel: z
    .string()
    .describe('Channel ID to get info for (e.g., C01234ABCDE). Use slack_list_channels to find IDs.'),
};

export function registerGetChannelInfoTool(server: McpServer, client: SlackClient): void {
  server.tool(
    'slack_get_channel_info',
    "Get detailed information about a channel including topic, purpose, member count, creation date, and whether it's archived or private.",
    getChannelInfoSchema,
    async ({ channel }) => {
      try {
        const response = await client.call<ConversationsInfoResponse>('conversations.info', {
          channel,
        });

        const ch = response.channel;
        const result = {
          id: ch.id,
          name: ch.name,
          is_private: ch.is_private || false,
          is_archived: ch.is_archived || false,
          is_channel: ch.is_channel || false,
          is_group: ch.is_group || false,
          is_im: ch.is_im || false,
          is_mpim: ch.is_mpim || false,
          topic: ch.topic?.value || '',
          purpose: ch.purpose?.value || '',
          num_members: ch.num_members || 0,
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
                channel,
                hint: message.includes('channel_not_found')
                  ? 'Make sure the channel ID is correct and the bot has access.'
                  : message.includes('missing_scope')
                    ? 'The bot token needs the channels:read scope. Check your Slack app permissions.'
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
