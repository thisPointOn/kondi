import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RedditClient } from '../client.js';
import type { Config } from '../types.js';

const getSavedSchema = {
  username: z
    .string()
    .describe('Your Reddit username (without u/ prefix).'),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(25)
    .describe('Number of saved items to return. Default: 25. Max: 100.'),
};

export function registerGetSavedTool(server: McpServer, config: Config): void {
  const client = new RedditClient(config.api, config.auth);

  server.tool(
    'reddit_get_saved',
    'Get your saved posts and comments. Useful for retrieving bookmarked content.',
    getSavedSchema,
    async ({ username, limit = 25 }) => {
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

      const sanitizedLimit = Math.min(Math.max(1, limit), 100);

      try {
        const data = await client.get(
          `/user/${encodeURIComponent(username.trim())}/saved`,
          {
            limit: sanitizedLimit.toString(),
            raw_json: '1',
          }
        ) as {
          data?: {
            children?: Array<{
              kind: string;
              data: Record<string, unknown>;
            }>;
            after?: string | null;
          };
        };

        const children = data.data?.children || [];

        const items = children.map((child) => {
          const d = child.data;
          if (child.kind === 't3') {
            // Post
            return {
              kind: 'post',
              id: d.id as string || '',
              fullname: d.name as string || '',
              title: d.title as string || '',
              author: d.author as string || '',
              subreddit: d.subreddit as string || '',
              score: d.score as number || 0,
              num_comments: d.num_comments as number || 0,
              created_utc: d.created_utc as number || 0,
              url: d.url as string || '',
              permalink: `https://www.reddit.com${d.permalink as string || ''}`,
              selftext: d.selftext as string || '',
              is_self: d.is_self as boolean || false,
            };
          } else if (child.kind === 't1') {
            // Comment
            return {
              kind: 'comment',
              id: d.id as string || '',
              fullname: d.name as string || '',
              author: d.author as string || '',
              body: d.body as string || '',
              score: d.score as number || 0,
              created_utc: d.created_utc as number || 0,
              subreddit: d.subreddit as string || '',
              permalink: `https://www.reddit.com${d.permalink as string || ''}`,
              link_title: d.link_title as string || '',
            };
          } else {
            return {
              kind: child.kind,
              id: d.id as string || '',
              fullname: d.name as string || '',
            };
          }
        });

        const result = {
          username: username.trim(),
          items,
          count: items.length,
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
        const message = error instanceof Error ? error.message : 'Unknown error fetching saved items';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                username,
                hint: message.includes('403') || message.includes('401')
                  ? 'Check that your access token is valid and has history scope.'
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
