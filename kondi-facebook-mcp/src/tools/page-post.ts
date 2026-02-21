import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FacebookClient } from '../client.js';
import type { Config } from '../types.js';

const pagePostSchema = {
  message: z.string().describe('The text content of the post to publish.'),
  page_id: z
    .string()
    .optional()
    .describe('Facebook Page ID to post to. Defaults to the configured page_id.'),
  link: z
    .string()
    .url()
    .optional()
    .describe('Optional URL to attach to the post as a link share.'),
};

export function registerPagePostTool(server: McpServer, config: Config): void {
  const client = new FacebookClient(config.api, config.auth);

  server.tool(
    'fb_page_post',
    'Publish a post to a Facebook Page\'s feed. Supports text messages and optional link attachments.',
    pagePostSchema,
    async ({ message, page_id, link }) => {
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

      if (!message || message.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Message cannot be empty.' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await client.createPost(pageId, message.trim(), link);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  post_id: response.id,
                  page_id: pageId,
                  message: message.trim(),
                  link: link || null,
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
