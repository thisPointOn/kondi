import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SlackClient } from '../client.js';
import type { ReactionsAddResponse } from '../types.js';

const addReactionSchema = {
  channel: z
    .string()
    .describe('Channel ID where the message exists (e.g., C01234ABCDE).'),
  timestamp: z
    .string()
    .describe('Timestamp of the message to react to (e.g., 1234567890.123456).'),
  name: z
    .string()
    .describe('Emoji name without colons (e.g., "thumbsup", "rocket", "white_check_mark").'),
};

export function registerAddReactionTool(server: McpServer, client: SlackClient): void {
  server.tool(
    'slack_add_reaction',
    'Add an emoji reaction to a Slack message. Requires the channel ID, message timestamp, and emoji name (without colons). Common emojis: thumbsup, eyes, white_check_mark, rocket.',
    addReactionSchema,
    async ({ channel, timestamp, name }) => {
      if (!name || name.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Emoji name cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      // Strip colons if user accidentally includes them
      const cleanName = name.replace(/^:+|:+$/g, '').trim();

      try {
        await client.call<ReactionsAddResponse>('reactions.add', {
          channel,
          timestamp,
          name: cleanName,
        });

        const result = {
          ok: true,
          channel,
          timestamp,
          reaction: cleanName,
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
                timestamp,
                reaction: cleanName,
                hint: message.includes('already_reacted')
                  ? 'This reaction has already been added to the message.'
                  : message.includes('invalid_name')
                    ? 'The emoji name is not valid. Use names without colons (e.g., "thumbsup").'
                    : message.includes('message_not_found')
                      ? 'The message was not found. Check the channel ID and timestamp.'
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
