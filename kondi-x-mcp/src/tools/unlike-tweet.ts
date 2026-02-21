import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { XClient } from '../client.js';
import type { Config } from '../types.js';

const unlikeTweetSchema = {
  user_id: z
    .string()
    .describe('Your authenticated user ID. Use x_get_me to find this.'),
  tweet_id: z
    .string()
    .describe('The ID of the tweet to unlike.'),
};

export function registerUnlikeTweetTool(server: McpServer, config: Config): void {
  const client = new XClient(config);

  server.tool(
    'x_unlike_tweet',
    'Remove a like from a tweet.',
    unlikeTweetSchema,
    async ({ user_id, tweet_id }) => {
      if (!user_id || user_id.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'user_id cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      if (!tweet_id || tweet_id.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'tweet_id cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await client.unlikeTweet(user_id, tweet_id);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error unliking tweet';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                user_id,
                tweet_id,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
