import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InstagramClient } from '../client.js';
import type { Config, CommentPostResponse } from '../types.js';

const replyToCommentSchema = {
  media_id: z
    .string()
    .describe(
      'The ID of the media post (not the comment ID). Instagram API requires posting replies at the media level.'
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
    'Reply to a comment on one of your Instagram posts. The reply is posted as a new comment on the media. Include @username in your message to notify the original commenter.',
    replyToCommentSchema,
    async ({ media_id, message }) => {
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
          `${media_id.trim()}/comments`,
          { message: message.trim() }
        );

        const result = {
          success: true,
          comment_id: response.id,
          media_id: media_id.trim(),
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
                media_id: media_id.trim(),
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
