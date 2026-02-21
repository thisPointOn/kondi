import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InstagramClient } from '../client.js';
import type { Config } from '../types.js';

const publishPhotoSchema = {
  image_url: z
    .string()
    .url()
    .describe(
      'Public URL of the image to publish. Must be accessible by Facebook servers (no localhost). Supported formats: JPEG, PNG.'
    ),
  caption: z
    .string()
    .optional()
    .describe('Caption for the post. Supports hashtags and mentions.'),
  ig_user_id: z
    .string()
    .optional()
    .describe(
      'Instagram Business account user ID. Defaults to the configured KONDI_INSTAGRAM_USER_ID.'
    ),
};

export function registerPublishPhotoTool(server: McpServer, config: Config): void {
  const client = new InstagramClient(config);

  server.tool(
    'ig_publish_photo',
    'Publish a photo to an Instagram Business account. Requires a publicly accessible image URL. Two-step process: creates a media container, then publishes it.',
    publishPhotoSchema,
    async ({ image_url, caption, ig_user_id }) => {
      // Resolve IG user ID
      let userId: string;
      try {
        userId = client.resolveUserId(ig_user_id);
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: error instanceof Error ? error.message : 'Missing Instagram User ID',
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        // Step 1: Create media container
        const container = await client.createMediaContainer(userId, image_url, caption);

        if (!container.id) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: 'Failed to create media container — no creation_id returned',
                  image_url,
                }),
              },
            ],
            isError: true,
          };
        }

        // Step 2: Publish the container
        const published = await client.publishMedia(userId, container.id);

        const result = {
          success: true,
          media_id: published.id,
          creation_id: container.id,
          image_url,
          caption: caption || null,
          ig_user_id: userId,
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
        const message = error instanceof Error ? error.message : 'Unknown publish error';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                image_url,
                hint: message.includes('OAuthException')
                  ? 'Check that your access token has instagram_basic and instagram_content_publish permissions.'
                  : message.includes('URL is not')
                    ? 'The image_url must be publicly accessible. Facebook servers need to download it.'
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
