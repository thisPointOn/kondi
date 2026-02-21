import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InstagramClient } from '../client.js';
import type { Config, ProfileResponse } from '../types.js';

const getProfileSchema = {
  ig_user_id: z
    .string()
    .optional()
    .describe('Override configured IG user ID'),
};

export function registerGetProfileTool(server: McpServer, config: Config): void {
  const client = new InstagramClient(config);

  server.tool(
    'ig_get_profile',
    'Get your Instagram business/creator profile information including bio, follower/following counts, total posts, and profile picture URL.',
    getProfileSchema,
    async ({ ig_user_id }) => {
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
        const profile = await client.get<ProfileResponse>(userId, {
          fields:
            'id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,website',
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(profile, null, 2),
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
                ig_user_id: userId,
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
