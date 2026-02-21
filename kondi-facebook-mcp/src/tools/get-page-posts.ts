import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FacebookClient } from '../client.js';
import type { Config } from '../types.js';

const getPagePostsSchema = {
  page_id: z
    .string()
    .optional()
    .describe('Facebook Page ID to fetch posts from. Defaults to the configured page_id.'),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(10)
    .describe('Number of posts to return. Default: 10. Max: 100.'),
};

export function registerGetPagePostsTool(server: McpServer, config: Config): void {
  const client = new FacebookClient(config.api, config.auth);

  server.tool(
    'fb_get_page_posts',
    'Retrieve recent posts from a Facebook Page\'s feed with configurable limit.',
    getPagePostsSchema,
    async ({ page_id, limit = 10 }) => {
      const pageId = page_id || client.getDefaultPageId();

      if (!pageId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'No page_id provided and no default page_id configured. Set KONDI_FACEBOOK_PAGE_ID or pass page_id parameter.',
              }),
            },
          ],
          isError: true,
        };
      }

      const sanitizedLimit = Math.min(Math.max(1, limit), 100);

      try {
        const feed = await client.getPagePosts(pageId, sanitizedLimit);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  page_id: pageId,
                  count: feed.data.length,
                  posts: feed.data,
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
              text: JSON.stringify({ error: errorMessage, page_id: pageId }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
