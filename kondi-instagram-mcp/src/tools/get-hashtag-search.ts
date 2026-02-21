import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InstagramClient } from '../client.js';
import type { Config, HashtagSearchResponse, HashtagMediaResponse } from '../types.js';

const getHashtagSearchSchema = {
  hashtag: z
    .string()
    .describe('Hashtag to search without the # symbol'),
  ig_user_id: z
    .string()
    .optional()
    .describe('Override configured IG user ID'),
};

export function registerGetHashtagSearchTool(server: McpServer, config: Config): void {
  const client = new InstagramClient(config);

  server.tool(
    'ig_get_hashtag_search',
    'Search Instagram by hashtag. First finds the hashtag ID, then retrieves recent public posts using that hashtag. Returns posts with captions, media URLs, and engagement counts. Limited to 30 results per hashtag per 7-day window.',
    getHashtagSearchSchema,
    async ({ hashtag, ig_user_id }) => {
      if (!hashtag || hashtag.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'hashtag is required and cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

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

      // Strip leading # if provided
      const cleanHashtag = hashtag.trim().replace(/^#/, '');

      try {
        // Step 1: Look up the hashtag ID
        const searchResponse = await client.get<HashtagSearchResponse>(
          'ig_hashtag_search',
          {
            q: cleanHashtag,
            user_id: userId,
          }
        );

        if (!searchResponse.data || searchResponse.data.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: `No hashtag found for "${cleanHashtag}"`,
                  hashtag: cleanHashtag,
                }),
              },
            ],
            isError: true,
          };
        }

        const hashtagId = searchResponse.data[0].id;

        // Step 2: Get recent media for that hashtag
        const mediaResponse = await client.get<HashtagMediaResponse>(
          `${hashtagId}/recent_media`,
          {
            user_id: userId,
            fields:
              'id,caption,media_type,media_url,timestamp,permalink,like_count,comments_count',
          }
        );

        const result = {
          hashtag: cleanHashtag,
          hashtag_id: hashtagId,
          posts: mediaResponse.data,
          count: mediaResponse.data.length,
          has_more: !!mediaResponse.paging?.next,
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
        const message = error instanceof Error ? error.message : 'Unknown error';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                hashtag: cleanHashtag,
                hint: message.includes('OAuthException')
                  ? 'Check that your access token has instagram_basic permission.'
                  : message.includes('rate')
                    ? 'Hashtag search is limited to 30 unique hashtags per 7-day window.'
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
