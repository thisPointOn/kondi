import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FacebookClient } from '../client.js';
import type { Config } from '../types.js';

const replyToCommentSchema = {
  comment_id: z.string().describe('The Facebook comment ID to reply to.'),
  message: z.string().describe('The text content of the reply.'),
};

export function registerReplyToCommentTool(server: McpServer, config: Config): void {
  const client = new FacebookClient(config.api, config.auth);

  server.tool(
    'fb_reply_to_comment',
    'Reply to a comment on a Facebook page post. The reply will appear as a nested comment under the original.',
    replyToCommentSchema,
    async ({ comment_id, message }) => {
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

      if (!message || message.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Message cannot be empty.' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await client.replyToComment(comment_id.trim(), message.trim());

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  reply_id: response.id,
                  comment_id: comment_id.trim(),
                  message: message.trim(),
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
