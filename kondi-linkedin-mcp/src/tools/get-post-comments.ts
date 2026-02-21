import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LinkedInClient } from '../client.js';
import type { Config, LinkedInCommentsResponse } from '../types.js';

const getPostCommentsSchema = {
  post_urn: z
    .string()
    .min(1)
    .describe("The post URN, e.g. 'urn:li:share:1234567890'."),
  count: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe('Number of comments to return. Default: 20. Max: 100.'),
};

export function registerGetPostCommentsTool(server: McpServer, config: Config): void {
  const client = new LinkedInClient(config.api, config.auth);

  server.tool(
    'linkedin_get_post_comments',
    'Get comments on a LinkedIn post. Returns comment text, author info, and creation timestamps.',
    getPostCommentsSchema,
    async ({ post_urn, count = 20 }) => {
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

      const sanitizedCount = Math.min(Math.max(1, count), 100);
      const encodedUrn = encodeURIComponent(post_urn.trim());

      try {
        const response = await client.get<LinkedInCommentsResponse>(
          `/socialActions/${encodedUrn}/comments`,
          {
            start: '0',
            count: String(sanitizedCount),
          }
        );

        const result = {
          post_urn: post_urn.trim(),
          comments: response.elements.map((comment) => ({
            id: comment.id || null,
            actor: comment.actor || comment.created?.actor || null,
            text: comment.message?.text || null,
            parent_comment: comment.parentComment || null,
            like_count: comment.likeCount ?? null,
            created_at: comment.created?.time
              ? new Date(comment.created.time).toISOString()
              : null,
          })),
          pagination: {
            start: response.paging.start,
            count: response.paging.count,
            total: response.paging.total ?? null,
          },
          number_of_results: response.elements.length,
          fetched_at: new Date().toISOString(),
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
        const message =
          error instanceof Error ? error.message : 'Unknown error fetching comments';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                hint: message.includes('401')
                  ? 'Access token may be expired or invalid. Generate a new token.'
                  : message.includes('403')
                    ? 'Insufficient permissions. Ensure the token has r_member_social scope.'
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
