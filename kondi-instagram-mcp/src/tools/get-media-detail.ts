import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InstagramClient } from '../client.js';
import type { Config, MediaDetailResponse } from '../types.js';

const getMediaDetailSchema = {
  media_id: z
    .string()
    .describe('The Instagram media ID to get details for.'),
};

export function registerGetMediaDetailTool(server: McpServer, config: Config): void {
  const client = new InstagramClient(config);

  server.tool(
    'ig_get_media_detail',
    'Get detailed information about a specific Instagram post including caption, media URL, type (IMAGE/VIDEO/CAROUSEL), engagement counts, and permalink.',
    getMediaDetailSchema,
    async ({ media_id }) => {
      if (!media_id || media_id.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'media_id is required and cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const detail = await client.get<MediaDetailResponse>(media_id.trim(), {
          fields:
            'id,caption,media_type,media_url,thumbnail_url,timestamp,permalink,like_count,comments_count,is_shared_to_feed',
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(detail, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                media_id: media_id.trim(),
                hint: message.includes('OAuthException')
                  ? 'Check that your access token has instagram_basic permission.'
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
