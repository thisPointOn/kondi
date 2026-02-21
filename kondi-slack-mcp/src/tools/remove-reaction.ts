import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SlackClient } from '../client.js';
import type { ReactionsRemoveResponse } from '../types.js';

const removeReactionSchema = {
  channel: z
    .string()
    .describe('Channel ID where the message exists (e.g., C01234ABCDE).'),
  message_ts: z
    .string()
    .describe('Timestamp of the message to remove the reaction from (e.g., 1234567890.123456).'),
  name: z
    .string()
    .describe("Emoji name without colons, e.g. 'thumbsup' not ':thumbsup:'."),
};

export function registerRemoveReactionTool(server: McpServer, client: SlackClient): void {
  server.tool(
    'slack_remove_reaction',
    'Remove a reaction from a message. The emoji name should not include colons.',
    removeReactionSchema,
    async ({ channel, message_ts, name }) => {
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
        await client.call<ReactionsRemoveResponse>('reactions.remove', {
          channel,
          timestamp: message_ts,
          name: cleanName,
        });

        const result = {
          ok: true,
          channel,
          message_ts,
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
                message_ts,
                reaction: cleanName,
                hint: message.includes('no_reaction')
                  ? 'This reaction was not found on the message.'
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
