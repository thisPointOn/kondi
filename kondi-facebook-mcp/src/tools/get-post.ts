import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FacebookClient } from '../client.js';
import type { Config } from '../types.js';

const getPostSchema = {
  post_id: z.string().describe('The Facebook post ID to retrieve (e.g. "page_id_post_id").'),
};

export function registerGetPostTool(server: McpServer, config: Config): void {
  const client = new FacebookClient(config.api, config.auth);

  server.tool(
    'fb_get_post',
    'Get details of a specific Facebook post including message, created time, and like count.',
    getPostSchema,
    async ({ post_id }) => {
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

      try {
        const post = await client.getPost(post_id.trim());

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  id: post.id,
                  message: post.message || null,
                  created_time: post.created_time || null,
                  likes: post.likes?.summary
                    ? {
                        total_count: post.likes.summary.total_count,
                        has_liked: post.likes.summary.has_liked,
                      }
                    : null,
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
