import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InstagramClient } from '../client.js';
import type { Config, CommentPostResponse } from '../types.js';

const replyToCommentSchema = {
  comment_id: z
    .string()
    .describe(
      'The ID of the comment to reply to. Obtain this from ig_get_comments.'
    ),
  message: z
    .string()
    .describe(
      'Reply text. Must @mention the commenter to thread properly.'
    ),
};

export function registerReplyToCommentTool(server: McpServer, config: Config): void {
  const client = new InstagramClient(config);

  server.tool(
    'ig_reply_to_comment',
    'Reply to a specific comment on one of your Instagram posts. The reply is posted as a threaded reply under the target comment.',
    replyToCommentSchema,
    async ({ comment_id, message }) => {
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

      if (!message || message.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'message is required and cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await client.post<CommentPostResponse>(
          `${comment_id.trim()}/replies`,
          { message: message.trim() }
        );

        const result = {
          success: true,
          reply_id: response.id,
          comment_id: comment_id.trim(),
          message: message.trim(),
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
        const message_ = error instanceof Error ? error.message : 'Unknown error';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message_,
                comment_id: comment_id.trim(),
                hint: message_.includes('OAuthException')
                  ? 'Check that your access token has instagram_manage_comments permission.'
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
