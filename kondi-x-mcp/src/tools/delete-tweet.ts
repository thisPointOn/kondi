import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { XClient } from '../client.js';
import type { Config } from '../types.js';

const deleteTweetSchema = {
  tweet_id: z
    .string()
    .describe('The ID of the tweet to delete. Must be a tweet owned by the authenticated user.'),
};

export function registerDeleteTweetTool(server: McpServer, config: Config): void {
  const client = new XClient(config);

  server.tool(
    'x_delete_tweet',
    'Delete a tweet by its ID. The tweet must be owned by the authenticated user.',
    deleteTweetSchema,
    async ({ tweet_id }) => {
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
        const response = await client.deleteTweet(tweet_id);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error deleting tweet';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
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
