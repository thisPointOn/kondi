import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LinkedInClient } from '../client.js';
import type { Config, LinkedInPostsResponse } from '../types.js';

const getPostsSchema = {
  count: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(10)
    .describe('Number of posts to return. Default: 10. Max: 100.'),
  person_id: z
    .string()
    .optional()
    .describe('Override the configured person ID.'),
};

export function registerGetPostsTool(server: McpServer, config: Config): void {
  const client = new LinkedInClient(config.api, config.auth);

  server.tool(
    'linkedin_get_posts',
    'Get your recent LinkedIn posts. Returns post content, engagement stats, and creation dates. Uses the configured person ID unless overridden.',
    getPostsSchema,
    async ({ count = 10, person_id }) => {
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

      const sanitizedCount = Math.min(Math.max(1, count), 100);

      try {
        const response = await client.get<LinkedInPostsResponse>('/rest/posts', {
          q: 'author',
          author: `urn:li:person:${personId}`,
          count: String(sanitizedCount),
        });

        const result = {
          posts: response.elements.map((post) => ({
            id: post.id || null,
            author: post.author || null,
            text: post.commentary || null,
            lifecycle_state: post.lifecycleState || null,
            visibility: post.visibility || null,
            created_at: post.createdAt
              ? new Date(post.createdAt).toISOString()
              : post.publishedAt
                ? new Date(post.publishedAt).toISOString()
                : null,
            last_modified_at: post.lastModifiedAt
              ? new Date(post.lastModifiedAt).toISOString()
              : null,
            engagement: {
              likes: post.likeCount ?? null,
              comments: post.commentCount ?? null,
              shares: post.shareCount ?? null,
            },
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
          error instanceof Error ? error.message : 'Unknown error fetching posts';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                hint: message.includes('401')
                  ? 'Access token may be expired or invalid. Generate a new token.'
                  : message.includes('403')
                    ? 'Insufficient permissions. Ensure the token has r_member_social or r_liteprofile scope.'
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
