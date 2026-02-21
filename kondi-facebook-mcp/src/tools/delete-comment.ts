import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FacebookClient } from '../client.js';
import type { Config } from '../types.js';

const deleteCommentSchema = {
  comment_id: z.string().describe('The Facebook comment ID to delete.'),
};

export function registerDeleteCommentTool(server: McpServer, config: Config): void {
  const client = new FacebookClient(config.api, config.auth);

  server.tool(
    'fb_delete_comment',
    'Delete a comment from a page post. Only comments on your page\'s posts can be deleted.',
    deleteCommentSchema,
    async ({ comment_id }) => {
      if (!comment_id || comment_id.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'comment_id is required and cannot be empty.' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await client.deleteComment(comment_id.trim());

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: result.success,
                  comment_id: comment_id.trim(),
                  message: result.success
                    ? 'Comment deleted successfully.'
                    : 'Delete request returned false — comment may not exist or you lack permission.',
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
              text: JSON.stringify({ error: errorMessage, comment_id }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
