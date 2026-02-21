import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RedditClient } from '../client.js';
import type { Config } from '../types.js';

const getUserSchema = {
  username: z
    .string()
    .describe('Reddit username (without u/ prefix). Example: "spez"'),
};

export function registerGetUserTool(server: McpServer, config: Config): void {
  const client = new RedditClient(config.api, config.auth);

  server.tool(
    'reddit_get_user',
    'Get public profile information for a Reddit user including karma, account age, and description.',
    getUserSchema,
    async ({ username }) => {
      // Validate auth
      if (!client.hasAuth()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'Authentication required. Set KONDI_REDDIT_ACCESS_TOKEN environment variable.',
              }),
            },
          ],
          isError: true,
        };
      }

      if (!username || username.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Username cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const data = await client.get(
          `/user/${encodeURIComponent(username.trim())}/about`,
          { raw_json: '1' }
        ) as {
          data?: Record<string, unknown>;
        };

        const d = data.data || {};

        const result = {
          username: d.name as string || '',
          id: d.id as string || '',
          created_utc: d.created_utc as number || 0,
          link_karma: d.link_karma as number || 0,
          comment_karma: d.comment_karma as number || 0,
          total_karma: d.total_karma as number || 0,
          is_gold: d.is_gold as boolean || false,
          is_mod: d.is_mod as boolean || false,
          has_verified_email: d.has_verified_email as boolean || false,
          icon_img: d.icon_img as string || '',
          subreddit: d.subreddit ? {
            display_name: (d.subreddit as Record<string, unknown>).display_name as string || '',
            title: (d.subreddit as Record<string, unknown>).title as string || '',
            public_description: (d.subreddit as Record<string, unknown>).public_description as string || '',
          } : null,
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
        const message = error instanceof Error ? error.message : 'Unknown error fetching user profile';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                username,
                hint: message.includes('404')
                  ? 'User not found. Check the username and try again.'
                  : message.includes('403') || message.includes('401')
                    ? 'Check that your access token is valid.'
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
