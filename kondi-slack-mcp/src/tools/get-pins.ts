import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SlackClient } from '../client.js';
import type { PinsListResponse } from '../types.js';

const getPinsSchema = {
  channel: z
    .string()
    .describe('Channel ID to get pinned items from (e.g., C01234ABCDE).'),
};

export function registerGetPinsTool(server: McpServer, client: SlackClient): void {
  server.tool(
    'slack_get_pins',
    'Get all pinned items in a channel. Returns the list of pinned messages with their content and who pinned them.',
    getPinsSchema,
    async ({ channel }) => {
      try {
        const response = await client.call<PinsListResponse>('pins.list', {
          channel,
        });

        const items = (response.items || []).map((item) => ({
          type: item.type,
          channel: item.channel || channel,
          created: item.created,
          created_by: item.created_by || 'unknown',
          message: item.message
            ? {
                user: item.message.user || item.message.bot_id || 'unknown',
                text: item.message.text,
                ts: item.message.ts,
              }
            : null,
        }));

        const result = {
          channel,
          items,
          pin_count: items.length,
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
                    ? 'The bot token needs the pins:read scope. Check your Slack app permissions.'
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
