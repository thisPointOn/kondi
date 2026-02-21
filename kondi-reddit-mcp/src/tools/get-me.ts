import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RedditClient } from '../client.js';
import type { Config } from '../types.js';

export function registerGetMeTool(server: McpServer, config: Config): void {
  const client = new RedditClient(config.api, config.auth);

  server.tool(
    'reddit_get_me',
    'Get the profile of the currently authenticated Reddit user. Returns username, karma breakdown, account age, and subscription info.',
    {},
    async () => {
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

      try {
        const data = await client.get('/api/v1/me', { raw_json: '1' }) as Record<string, unknown>;

        const result = {
          username: data.name as string || '',
          id: data.id as string || '',
          created_utc: data.created_utc as number || 0,
          link_karma: data.link_karma as number || 0,
          comment_karma: data.comment_karma as number || 0,
          total_karma: data.total_karma as number || 0,
          is_gold: data.is_gold as boolean || false,
          is_mod: data.is_mod as boolean || false,
          has_verified_email: data.has_verified_email as boolean || false,
          num_friends: data.num_friends as number || 0,
          icon_img: data.icon_img as string || '',
          subreddit: data.subreddit ? {
            display_name: (data.subreddit as Record<string, unknown>).display_name as string || '',
            title: (data.subreddit as Record<string, unknown>).title as string || '',
            subscribers: (data.subreddit as Record<string, unknown>).subscribers as number || 0,
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
                hint: message.includes('403') || message.includes('401')
                  ? 'Check that your access token is valid and has identity scope.'
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
