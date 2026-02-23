import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LinkedInClient } from '../client.js';
import type { Config } from '../types.js';

const createPostSchema = {
  text: z
    .string()
    .min(1)
    .max(3000)
    .describe('The text content of the LinkedIn post. Max 3000 characters.'),
  visibility: z
    .enum(['PUBLIC', 'CONNECTIONS'])
    .optional()
    .default('PUBLIC')
    .describe(
      "Post visibility. 'PUBLIC' makes it visible to everyone (default). 'CONNECTIONS' limits to your connections only."
    ),
};

export function registerCreatePostTool(server: McpServer, config: Config): void {
  const client = new LinkedInClient(config.api, config.auth);

  server.tool(
    'linkedin_create_post',
    'Create a new LinkedIn post on behalf of the authenticated user. Requires text content and optionally a visibility setting. The post will appear on the user\'s LinkedIn feed.',
    createPostSchema,
    async ({ text, visibility = 'PUBLIC' }) => {
      // Check for access token
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

      // Check for person ID
      if (!config.auth.person_id) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'No person ID configured',
                hint: 'Set KONDI_LINKEDIN_PERSON_ID environment variable or configure auth.person_id in ~/.config/kondi-linkedin/config.json',
              }),
            },
          ],
          isError: true,
        };
      }

      // Validate text
      if (!text || text.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Post text cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      const body = {
        author: `urn:li:person:${config.auth.person_id}`,
        commentary: text.trim(),
        visibility: visibility,
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [] as unknown[],
          thirdPartyDistributionChannels: [] as unknown[],
        },
        lifecycleState: 'PUBLISHED',
      };

      try {
        const response = await client.post<{ id?: string; status?: number }>('/rest/posts', body);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  post_id: response.id,
                  visibility,
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
        const message = error instanceof Error ? error.message : 'Unknown error creating post';

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
