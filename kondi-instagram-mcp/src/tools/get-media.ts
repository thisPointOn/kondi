import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InstagramClient } from '../client.js';
import type { Config } from '../types.js';

const getMediaSchema = {
  ig_user_id: z
    .string()
    .optional()
    .describe(
      'Instagram Business account user ID. Defaults to the configured KONDI_INSTAGRAM_USER_ID.'
    ),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(10)
    .describe('Number of recent media posts to return. Default: 10. Max: 100.'),
};

export function registerGetMediaTool(server: McpServer, config: Config): void {
  const client = new InstagramClient(config);

  server.tool(
    'ig_get_media',
    'Get recent media posts from an Instagram Business account. Returns id, caption, media_type, media_url, timestamp, and permalink for each post.',
    getMediaSchema,
    async ({ ig_user_id, limit = 10 }) => {
      // Resolve IG user ID
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

      const sanitizedLimit = Math.min(Math.max(1, limit), 100);

      try {
        const response = await client.getMedia(userId, sanitizedLimit);

        const result = {
          media: response.data,
          count: response.data.length,
          ig_user_id: userId,
          has_more: !!response.paging?.next,
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
