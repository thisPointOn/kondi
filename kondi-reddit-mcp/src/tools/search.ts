import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RedditClient } from '../client.js';
import type { Config } from '../types.js';

const searchSchema = {
  query: z
    .string()
    .describe(
      "Search query. Supports Reddit search syntax including 'author:username', 'selftext:keyword', 'site:domain.com', 'flair:text'."
    ),
  type: z
    .enum(['link', 'sr', 'user'])
    .optional()
    .default('link')
    .describe("Type of search: 'link' searches posts, 'sr' searches subreddits, 'user' searches users. Default: 'link'."),
  sort: z
    .enum(['relevance', 'hot', 'top', 'new', 'comments'])
    .optional()
    .default('relevance')
    .describe("Sort order for results. Default: 'relevance'."),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(25)
    .describe('Number of results to return. Default: 25. Max: 100.'),
  subreddit: z
    .string()
    .optional()
    .describe('Restrict search to a specific subreddit (without r/ prefix). If omitted, searches all of Reddit.'),
};

export function registerSearchTool(server: McpServer, config: Config): void {
  const client = new RedditClient(config.api, config.auth);

  server.tool(
    'reddit_search',
    "Search Reddit for posts, subreddits, or users. Supports Reddit search syntax including 'author:username', 'selftext:keyword', 'site:domain.com', 'flair:text'. Can search all of Reddit or within a specific subreddit.",
    searchSchema,
    async ({ query, type = 'link', sort = 'relevance', limit = 25, subreddit }) => {
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

      if (!query || query.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Search query cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      const sanitizedLimit = Math.min(Math.max(1, limit), 100);

      try {
        const params: Record<string, string> = {
          q: query.trim(),
          type,
          sort,
          limit: sanitizedLimit.toString(),
          raw_json: '1',
        };

        let path: string;
        if (subreddit && subreddit.trim().length > 0) {
          path = `/r/${encodeURIComponent(subreddit.trim())}/search`;
          params.restrict_sr = 'true';
        } else {
          path = '/search';
          params.restrict_sr = 'false';
        }

        const data = await client.get(path, params) as {
          data?: {
            children?: Array<{
              kind: string;
              data: Record<string, unknown>;
            }>;
            after?: string | null;
          };
        };

        const children = data.data?.children || [];

        const results = children.map((child) => {
          const d = child.data;
          if (type === 'sr') {
            return {
              kind: 'subreddit',
              name: d.display_name as string || '',
              title: d.title as string || '',
              description: d.public_description as string || '',
              subscribers: d.subscribers as number || 0,
              created_utc: d.created_utc as number || 0,
              url: `https://www.reddit.com/r/${d.display_name as string || ''}`,
              nsfw: d.over18 as boolean || false,
            };
          } else if (type === 'user') {
            return {
              kind: 'user',
              name: d.name as string || '',
              link_karma: d.link_karma as number || 0,
              comment_karma: d.comment_karma as number || 0,
              created_utc: d.created_utc as number || 0,
            };
          } else {
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
          }
        });

        const result = {
          query: query.trim(),
          type,
          sort,
          subreddit: subreddit?.trim() || null,
          results,
          count: results.length,
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
        const message = error instanceof Error ? error.message : 'Unknown error performing search';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                query,
                hint: message.includes('403') || message.includes('401')
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
