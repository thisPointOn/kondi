import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FacebookClient } from '../client.js';
import type { Config } from '../types.js';

const publishPhotoSchema = {
  page_id: z
    .string()
    .optional()
    .describe('Facebook Page ID. Uses configured page ID if omitted.'),
  photo_url: z.string().url().describe('Public URL of the image to publish.'),
  caption: z
    .string()
    .optional()
    .describe('Optional caption text for the photo.'),
};

export function registerPublishPhotoTool(server: McpServer, config: Config): void {
  const client = new FacebookClient(config.api, config.auth);

  server.tool(
    'fb_publish_photo',
    'Publish a photo to a Facebook page. Provide a publicly accessible image URL and optional caption text.',
    publishPhotoSchema,
    async ({ page_id, photo_url, caption }) => {
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

      if (!photo_url || photo_url.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'photo_url is required and cannot be empty.' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await client.publishPhoto(pageId, photo_url.trim(), caption?.trim());

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  photo_id: response.id,
                  post_id: response.post_id || null,
                  page_id: pageId,
                  photo_url: photo_url.trim(),
                  caption: caption?.trim() || null,
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
