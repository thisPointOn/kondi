import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { XClient } from '../client.js';
import type { Config } from '../types.js';

const getMeSchema = {
  user_fields: z
    .string()
    .optional()
    .describe(
      'Comma-separated list of user fields to return. Default: "id,name,username,description,public_metrics,profile_image_url,created_at". Available fields include: created_at, description, entities, id, location, name, pinned_tweet_id, profile_image_url, protected, public_metrics, url, username, verified, withheld.'
    ),
};

export function registerGetMeTool(server: McpServer, config: Config): void {
  const client = new XClient(config);

  server.tool(
    'x_get_me',
    'Get the profile of the currently authenticated user. Returns your account info including username, bio, follower counts, and account creation date.',
    getMeSchema,
    async ({ user_fields }) => {
      try {
        const response = await client.getMe(user_fields);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error getting authenticated user';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
