import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FacebookClient } from '../client.js';
import type { Config } from '../types.js';

const deletePostSchema = {
  post_id: z.string().describe('The Facebook post ID to delete (e.g. "page_id_post_id").'),
};

export function registerDeletePostTool(server: McpServer, config: Config): void {
  const client = new FacebookClient(config.api, config.auth);

  server.tool(
    'fb_delete_post',
    'Delete a specific Facebook post by its post ID. This action is irreversible.',
    deletePostSchema,
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
        const result = await client.deletePost(post_id.trim());

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: result.success,
                  post_id: post_id.trim(),
                  message: result.success
                    ? 'Post deleted successfully.'
                    : 'Delete request returned false — post may not exist or you lack permission.',
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
