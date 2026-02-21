import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InstagramClient } from '../client.js';
import type { Config } from '../types.js';

const deleteCommentSchema = {
  comment_id: z
    .string()
    .describe('The ID of the comment to delete.'),
};

export function registerDeleteCommentTool(server: McpServer, config: Config): void {
  const client = new InstagramClient(config);

  server.tool(
    'ig_delete_comment',
    'Delete a comment from one of your Instagram posts. Only comments on your own media can be deleted.',
    deleteCommentSchema,
    async ({ comment_id }) => {
      if (!comment_id || comment_id.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'comment_id is required and cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      try {
        await client.delete(comment_id.trim());

        const result = {
          success: true,
          comment_id: comment_id.trim(),
          message: 'Comment deleted successfully.',
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
                comment_id: comment_id.trim(),
                hint: message.includes('OAuthException')
                  ? 'Check that your access token has instagram_manage_comments permission.'
                  : message.includes('does not exist')
                    ? 'The comment may have already been deleted or the ID is invalid.'
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
