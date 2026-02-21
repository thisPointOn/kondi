import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RedditClient } from '../client.js';
import type { Config, RedditPost } from '../types.js';

const getPostsSchema = {
  subreddit: z
    .string()
    .describe('Subreddit name (without r/ prefix). Example: "programming"'),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(10)
    .describe('Number of posts to return. Default: 10. Max: 100.'),
};

export function registerGetPostsTool(server: McpServer, config: Config): void {
  const client = new RedditClient(config.api, config.auth);

  server.tool(
    'reddit_get_posts',
    'Get hot posts from a subreddit. Returns titles, scores, authors, URLs, and comment counts. Requires authentication.',
    getPostsSchema,
    async ({ subreddit, limit = 10 }) => {
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

      const sanitizedLimit = Math.min(Math.max(1, limit), 100);

      try {
        const data = await client.get(`/r/${encodeURIComponent(subreddit.trim())}/hot`, {
          limit: sanitizedLimit.toString(),
          raw_json: '1',
        }) as {
          data?: {
            children?: Array<{
              data: {
                id: string;
                name: string;
                title: string;
                author: string;
                subreddit: string;
                score: number;
                upvote_ratio: number;
                num_comments: number;
                created_utc: number;
                url: string;
                permalink: string;
                selftext: string;
                is_self: boolean;
              };
            }>;
          };
        };

        const children = data.data?.children || [];

        const posts: RedditPost[] = children.map((child) => ({
          id: child.data.id,
          fullname: child.data.name,
          title: child.data.title,
          author: child.data.author,
          subreddit: child.data.subreddit,
          score: child.data.score,
          upvote_ratio: child.data.upvote_ratio,
          num_comments: child.data.num_comments,
          created_utc: child.data.created_utc,
          url: child.data.url,
          permalink: `https://www.reddit.com${child.data.permalink}`,
          selftext: child.data.selftext || '',
          is_self: child.data.is_self,
        }));

        const result = {
          subreddit: subreddit.trim(),
          posts,
          count: posts.length,
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
        const message = error instanceof Error ? error.message : 'Unknown error fetching posts';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                subreddit,
                hint: message.includes('403') || message.includes('401')
                  ? 'Check that your access token is valid and has read permissions.'
                  : message.includes('404')
                    ? 'Subreddit not found. Check the name and try again.'
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
