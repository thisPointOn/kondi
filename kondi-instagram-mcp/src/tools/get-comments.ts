import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InstagramClient } from '../client.js';
import type { Config, CommentsResponse } from '../types.js';

const getCommentsSchema = {
  media_id: z
    .string()
    .describe('The Instagram media ID to get comments for.'),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(25)
    .describe('Number of comments to return. Default: 25. Max: 100.'),
};

export function registerGetCommentsTool(server: McpServer, config: Config): void {
  const client = new InstagramClient(config);

  server.tool(
    'ig_get_comments',
    'Get comments on an Instagram post. Returns comment text, author username, timestamps, like counts, and any replies. Useful for monitoring audience feedback.',
    getCommentsSchema,
    async ({ media_id, limit = 25 }) => {
      if (!media_id || media_id.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'media_id is required and cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      const sanitizedLimit = Math.min(Math.max(1, limit), 100);

      try {
        const response = await client.get<CommentsResponse>(
          `${media_id.trim()}/comments`,
          {
            fields:
              'id,text,username,timestamp,like_count,replies{id,text,username,timestamp}',
            limit: String(sanitizedLimit),
          }
        );

        const result = {
          media_id: media_id.trim(),
          comments: response.data,
          count: response.data.length,
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
                media_id: media_id.trim(),
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
