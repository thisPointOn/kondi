import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LinkedInClient } from '../client.js';
import type { Config } from '../types.js';

const deletePostSchema = {
  post_urn: z
    .string()
    .min(1)
    .describe("The post URN, e.g. 'urn:li:share:1234567890'."),
};

export function registerDeletePostTool(server: McpServer, config: Config): void {
  const client = new LinkedInClient(config.api, config.auth);

  server.tool(
    'linkedin_delete_post',
    "Delete one of your LinkedIn posts. The post URN can be found from linkedin_get_posts results.",
    deletePostSchema,
    async ({ post_urn }) => {
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

      const encodedUrn = encodeURIComponent(post_urn.trim());

      try {
        await client.delete(`/rest/posts/${encodedUrn}`);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  deleted_post_urn: post_urn.trim(),
                  deleted_at: new Date().toISOString(),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown error deleting post';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                hint: message.includes('401')
                  ? 'Access token may be expired or invalid. Generate a new token.'
                  : message.includes('403')
                    ? 'Insufficient permissions. You can only delete your own posts.'
                    : message.includes('404')
                      ? 'Post not found. The URN may be incorrect or the post may already be deleted.'
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
