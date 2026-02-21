import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FacebookClient } from '../client.js';
import type { Config } from '../types.js';

const getPostCommentsSchema = {
  post_id: z.string().describe('The Facebook post ID to get comments for.'),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(25)
    .describe('Number of comments to return. Default: 25. Max: 100.'),
};

export function registerGetPostCommentsTool(server: McpServer, config: Config): void {
  const client = new FacebookClient(config.api, config.auth);

  server.tool(
    'fb_get_post_comments',
    'Get comments on a Facebook page post. Returns comment text, author info, timestamps, and like counts. Useful for monitoring audience feedback.',
    getPostCommentsSchema,
    async ({ post_id, limit = 25 }) => {
      if (!post_id || post_id.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'post_id is required and cannot be empty.' }),
            },
          ],
          isError: true,
        };
      }

      const sanitizedLimit = Math.min(Math.max(1, limit), 100);

      try {
        const comments = await client.getPostComments(post_id.trim(), sanitizedLimit);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  post_id: post_id.trim(),
                  count: comments.data.length,
                  comments: comments.data,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: errorMessage, post_id }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
