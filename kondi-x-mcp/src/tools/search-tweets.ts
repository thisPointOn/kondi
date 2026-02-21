import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { XClient } from '../client.js';
import type { Config } from '../types.js';

const searchTweetsSchema = {
  query: z
    .string()
    .min(1)
    .max(512)
    .describe(
      'Search query. Supports X API query operators (e.g., "from:user", "#hashtag", "keyword lang:en"). Max 512 characters.'
    ),
  max_results: z
    .number()
    .min(10)
    .max(100)
    .optional()
    .default(10)
    .describe('Maximum number of tweets to return. Default: 10. Min: 10, Max: 100.'),
  tweet_fields: z
    .string()
    .optional()
    .describe(
      'Comma-separated list of tweet fields to return. Default: "text,created_at,author_id,public_metrics".'
    ),
};

export function registerSearchTweetsTool(server: McpServer, config: Config): void {
  const client = new XClient(config);

  server.tool(
    'x_search_tweets',
    'Search recent tweets matching a query. Supports X API query operators like "from:user", "#hashtag", and boolean operators.',
    searchTweetsSchema,
    async ({ query, max_results = 10, tweet_fields }) => {
      if (!query || query.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Query cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      const sanitizedMaxResults = Math.min(Math.max(10, max_results), 100);

      try {
        const response = await client.searchTweets(query.trim(), sanitizedMaxResults, tweet_fields);

        const result = {
          ...response,
          query: query.trim(),
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
        const message = error instanceof Error ? error.message : 'Unknown error searching tweets';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                query: query.trim(),
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
