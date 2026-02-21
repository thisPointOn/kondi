import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LinkedInClient } from '../client.js';
import type { Config } from '../types.js';

const likePostSchema = {
  post_urn: z
    .string()
    .min(1)
    .describe("The post URN, e.g. 'urn:li:share:1234567890'."),
  person_id: z
    .string()
    .optional()
    .describe('Override the configured person ID.'),
};

export function registerLikePostTool(server: McpServer, config: Config): void {
  const client = new LinkedInClient(config.api, config.auth);

  server.tool(
    'linkedin_like_post',
    'Like a LinkedIn post on behalf of the authenticated user.',
    likePostSchema,
    async ({ post_urn, person_id }) => {
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

      const encodedUrn = encodeURIComponent(post_urn.trim());

      const body = {
        actor: `urn:li:person:${personId}`,
        object: post_urn.trim(),
      };

      try {
        await client.post<{ id?: string; status?: number }>(
          `/socialActions/${encodedUrn}/likes`,
          body
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  post_urn: post_urn.trim(),
                  liked_by: `urn:li:person:${personId}`,
                  liked_at: new Date().toISOString(),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown error liking post';

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
                      : message.includes('409')
                        ? 'You may have already liked this post.'
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
