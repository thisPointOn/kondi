import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FacebookClient } from '../client.js';
import type { Config } from '../types.js';

const getPageInfoSchema = {
  page_id: z
    .string()
    .optional()
    .describe('Facebook Page ID. Uses configured page ID if omitted.'),
};

export function registerGetPageInfoTool(server: McpServer, config: Config): void {
  const client = new FacebookClient(config.api, config.auth);

  server.tool(
    'fb_get_page_info',
    'Get detailed information about a Facebook page including name, category, follower count, about text, website, and contact info.',
    getPageInfoSchema,
    async ({ page_id }) => {
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

      try {
        const pageInfo = await client.getPageInfo(pageId);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(pageInfo, null, 2),
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
