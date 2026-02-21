import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { XClient } from '../client.js';
import type { Config } from '../types.js';

const getFollowersSchema = {
  user_id: z
    .string()
    .describe('The numeric ID of the user whose followers to retrieve.'),
  max_results: z
    .number()
    .min(1)
    .max(1000)
    .optional()
    .default(100)
    .describe('Maximum number of followers to return. Default: 100. Min: 1, Max: 1000.'),
  user_fields: z
    .string()
    .optional()
    .describe(
      'Comma-separated list of user fields to return. Default: "id,name,username,description,public_metrics". Available fields include: created_at, description, entities, id, location, name, pinned_tweet_id, profile_image_url, protected, public_metrics, url, username, verified, withheld.'
    ),
};

export function registerGetFollowersTool(server: McpServer, config: Config): void {
  const client = new XClient(config);

  server.tool(
    'x_get_followers',
    'Get a list of users who follow the specified user. Returns follower profiles with bios and their own follower counts.',
    getFollowersSchema,
    async ({ user_id, max_results = 100, user_fields }) => {
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

      const sanitizedMaxResults = Math.min(Math.max(1, max_results), 1000);

      try {
        const response = await client.getFollowers(user_id, sanitizedMaxResults, user_fields);

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
        const message = error instanceof Error ? error.message : 'Unknown error getting followers';

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
