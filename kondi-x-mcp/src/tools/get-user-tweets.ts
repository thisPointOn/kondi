import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { XClient } from '../client.js';
import type { Config } from '../types.js';

const getUserTweetsSchema = {
  user_id: z
    .string()
    .describe('The ID of the user whose tweets to retrieve.'),
  max_results: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(10)
    .describe('Maximum number of tweets to return. Default: 10. Max: 100.'),
  tweet_fields: z
    .string()
    .optional()
    .describe(
      'Comma-separated list of tweet fields to return. Default: "text,created_at,author_id,public_metrics".'
    ),
};

export function registerGetUserTweetsTool(server: McpServer, config: Config): void {
  const client = new XClient(config);

  server.tool(
    'x_get_user_tweets',
    'Get recent tweets from a user by their user ID. Returns a list of tweets with optional field expansions.',
    getUserTweetsSchema,
    async ({ user_id, max_results = 10, tweet_fields }) => {
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

      const sanitizedMaxResults = Math.min(Math.max(1, max_results), 100);

      try {
        const response = await client.getUserTweets(user_id, sanitizedMaxResults, tweet_fields);

        const result = {
          ...response,
          user_id,
          number_of_results: response.data?.length ?? 0,
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
        const message = error instanceof Error ? error.message : 'Unknown error getting user tweets';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                user_id,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
