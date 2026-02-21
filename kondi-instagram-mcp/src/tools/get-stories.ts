import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InstagramClient } from '../client.js';
import type { Config, StoriesResponse } from '../types.js';

const getStoriesSchema = {
  ig_user_id: z
    .string()
    .optional()
    .describe('Override configured IG user ID'),
};

export function registerGetStoriesTool(server: McpServer, config: Config): void {
  const client = new InstagramClient(config);

  server.tool(
    'ig_get_stories',
    'Get your currently active Instagram stories. Stories expire after 24 hours. Returns media URLs, timestamps, and captions.',
    getStoriesSchema,
    async ({ ig_user_id }) => {
      let userId: string;
      try {
        userId = client.resolveUserId(ig_user_id);
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: error instanceof Error ? error.message : 'Missing Instagram User ID',
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await client.get<StoriesResponse>(
          `${userId}/stories`,
          {
            fields: 'id,media_type,media_url,timestamp,caption',
          }
        );

        const result = {
          ig_user_id: userId,
          stories: response.data,
          count: response.data.length,
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
                ig_user_id: userId,
                hint: message.includes('OAuthException')
                  ? 'Check that your access token has instagram_basic permission.'
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
