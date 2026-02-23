import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LinkedInClient } from '../client.js';
import type { Config } from '../types.js';

const replyToCommentSchema = {
  post_urn: z
    .string()
    .min(1)
    .describe("The post URN, e.g. 'urn:li:share:1234567890'."),
  text: z
    .string()
    .min(1)
    .max(1250)
    .describe('The comment/reply text. Max 1250 characters.'),
  parent_comment: z
    .string()
    .optional()
    .describe('The parent comment URN to reply to. If omitted, creates a top-level comment.'),
  person_id: z
    .string()
    .optional()
    .describe('Override the configured person ID.'),
};

export function registerReplyToCommentTool(server: McpServer, config: Config): void {
  const client = new LinkedInClient(config.api, config.auth);

  server.tool(
    'linkedin_reply_to_comment',
    'Reply to or comment on a LinkedIn post. Can also reply to an existing comment by providing the parent comment URN.',
    replyToCommentSchema,
    async ({ post_urn, text, parent_comment, person_id }) => {
      if (!client.hasToken()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'No access token configured',
                hint: 'Set KONDI_LINKEDIN_ACCESS_TOKEN environment variable or configure auth.access_token in ~/.config/kondi-linkedin/config.json',
              }),
            },
          ],
          isError: true,
        };
      }

      const personId = person_id || config.auth.person_id;
      if (!personId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'No person ID configured',
                hint: 'Set KONDI_LINKEDIN_PERSON_ID environment variable, configure auth.person_id in ~/.config/kondi-linkedin/config.json, or pass person_id parameter.',
              }),
            },
          ],
          isError: true,
        };
      }

      if (!post_urn || post_urn.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'post_urn is required' }),
            },
          ],
          isError: true,
        };
      }

      if (!text || text.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Comment text cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      const encodedUrn = encodeURIComponent(post_urn.trim());

      const body: Record<string, unknown> = {
        actor: `urn:li:person:${personId}`,
        message: {
          text: text.trim(),
        },
      };

      if (parent_comment) {
        body.parentComment = parent_comment;
      }

      try {
        const response = await client.post<{ id?: string; status?: number }>(
          `/rest/socialActions/${encodedUrn}/comments`,
          body
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  comment_id: response.id || null,
                  post_urn: post_urn.trim(),
                  parent_comment: parent_comment || null,
                  text_length: text.trim().length,
                  created_at: new Date().toISOString(),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown error posting comment';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                hint: message.includes('401')
                  ? 'Access token may be expired or invalid. Generate a new token.'
                  : message.includes('403')
                    ? 'Insufficient permissions. Ensure the token has w_member_social scope.'
                    : message.includes('404')
                      ? 'Post not found. The URN may be incorrect.'
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
