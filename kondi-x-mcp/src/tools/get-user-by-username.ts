import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { XClient } from '../client.js';
import type { Config } from '../types.js';

const getUserByUsernameSchema = {
  username: z
    .string()
    .min(1)
    .describe('The @username of the user to look up (without the @ symbol).'),
  user_fields: z
    .string()
    .optional()
    .describe(
      'Comma-separated list of user fields to return. Default: "id,name,username,description,public_metrics,profile_image_url,verified,created_at". Available fields include: created_at, description, entities, id, location, name, pinned_tweet_id, profile_image_url, protected, public_metrics, url, username, verified, withheld.'
    ),
};

export function registerGetUserByUsernameTool(server: McpServer, config: Config): void {
  const client = new XClient(config);

  server.tool(
    'x_get_user_by_username',
    'Look up an X user by their @username. Returns profile info including bio, follower/following counts, and verification status. Use this to find a user\'s numeric ID for other operations.',
    getUserByUsernameSchema,
    async ({ username, user_fields }) => {
      if (!username || username.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'username cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      // Strip leading @ if provided
      const cleanUsername = username.trim().replace(/^@/, '');

      try {
        const response = await client.getUserByUsername(cleanUsername, user_fields);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error looking up user';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                username: cleanUsername,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
