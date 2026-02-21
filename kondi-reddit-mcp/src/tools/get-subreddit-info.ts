import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RedditClient } from '../client.js';
import type { Config } from '../types.js';

const getSubredditInfoSchema = {
  subreddit: z
    .string()
    .describe('Subreddit name (without r/ prefix). Example: "programming"'),
};

export function registerGetSubredditInfoTool(server: McpServer, config: Config): void {
  const client = new RedditClient(config.api, config.auth);

  server.tool(
    'reddit_get_subreddit_info',
    'Get detailed information about a subreddit including description, subscriber count, rules summary, creation date, and whether it is NSFW or quarantined.',
    getSubredditInfoSchema,
    async ({ subreddit }) => {
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

      if (!subreddit || subreddit.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Subreddit name cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const data = await client.get(
          `/r/${encodeURIComponent(subreddit.trim())}/about`,
          { raw_json: '1' }
        ) as {
          data?: Record<string, unknown>;
        };

        const d = data.data || {};

        const result = {
          name: d.display_name as string || '',
          title: d.title as string || '',
          description: d.public_description as string || '',
          description_html: d.description as string || '',
          subscribers: d.subscribers as number || 0,
          active_users: d.accounts_active as number || 0,
          created_utc: d.created_utc as number || 0,
          nsfw: d.over18 as boolean || false,
          quarantined: d.quarantine as boolean || false,
          subreddit_type: d.subreddit_type as string || '',
          url: `https://www.reddit.com/r/${(d.display_name as string || subreddit).trim()}`,
          banner_img: d.banner_img as string || '',
          icon_img: d.icon_img as string || '',
          community_icon: d.community_icon as string || '',
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
        const message = error instanceof Error ? error.message : 'Unknown error fetching subreddit info';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                subreddit,
                hint: message.includes('404')
                  ? 'Subreddit not found. Check the name and try again.'
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
