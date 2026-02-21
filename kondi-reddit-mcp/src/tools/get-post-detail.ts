import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RedditClient } from '../client.js';
import type { Config, RedditComment } from '../types.js';

const getPostDetailSchema = {
  subreddit: z
    .string()
    .describe('Subreddit name (without r/ prefix). Example: "programming"'),
  post_id: z
    .string()
    .describe('The post ID without the t3_ prefix. Example: "abc123"'),
  comment_limit: z
    .number()
    .min(1)
    .max(500)
    .optional()
    .default(50)
    .describe('Number of comments to return. Default: 50. Max: 500.'),
  sort: z
    .enum(['confidence', 'top', 'new', 'controversial', 'old', 'qa'])
    .optional()
    .default('confidence')
    .describe("Sort order for comments. Default: 'confidence' (best)."),
};

function flattenComments(
  children: Array<{ kind: string; data: Record<string, unknown> }>,
  depth: number = 0
): RedditComment[] {
  const comments: RedditComment[] = [];

  for (const child of children) {
    if (child.kind !== 't1') continue;

    const d = child.data;

    comments.push({
      id: d.id as string,
      fullname: d.name as string,
      author: d.author as string,
      body: d.body as string || '',
      score: d.score as number || 0,
      created_utc: d.created_utc as number || 0,
      parent_id: d.parent_id as string || '',
      depth,
      permalink: `https://www.reddit.com${d.permalink as string || ''}`,
    });

    // Recurse into replies
    const replies = d.replies as {
      data?: {
        children?: Array<{ kind: string; data: Record<string, unknown> }>;
      };
    } | string | undefined;

    if (replies && typeof replies === 'object' && replies.data?.children) {
      const nested = flattenComments(replies.data.children, depth + 1);
      comments.push(...nested);
    }
  }

  return comments;
}

export function registerGetPostDetailTool(server: McpServer, config: Config): void {
  const client = new RedditClient(config.api, config.auth);

  server.tool(
    'reddit_get_post_detail',
    "Get a post's full details along with its comment tree. Returns the post content, score, awards, and a sorted list of comments with replies.",
    getPostDetailSchema,
    async ({ subreddit, post_id, comment_limit = 50, sort = 'confidence' }) => {
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

      if (!post_id || post_id.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Post ID cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const data = await client.get(
          `/r/${encodeURIComponent(subreddit.trim())}/comments/${encodeURIComponent(post_id.trim())}`,
          {
            limit: comment_limit.toString(),
            sort,
            raw_json: '1',
          }
        ) as Array<{
          data?: {
            children?: Array<{ kind: string; data: Record<string, unknown> }>;
          };
        }>;

        // Reddit returns an array: [post_listing, comments_listing]
        let post: Record<string, unknown> | null = null;
        if (Array.isArray(data) && data.length >= 1) {
          const postChildren = data[0]?.data?.children;
          if (postChildren && postChildren.length > 0) {
            post = postChildren[0].data;
          }
        }

        const commentListing = Array.isArray(data) && data.length >= 2 ? data[1] : null;
        const children = commentListing?.data?.children || [];
        const comments = flattenComments(children);

        const result = {
          post: post ? {
            id: post.id as string || '',
            fullname: post.name as string || '',
            title: post.title as string || '',
            author: post.author as string || '',
            subreddit: post.subreddit as string || '',
            score: post.score as number || 0,
            upvote_ratio: post.upvote_ratio as number || 0,
            num_comments: post.num_comments as number || 0,
            created_utc: post.created_utc as number || 0,
            url: post.url as string || '',
            permalink: `https://www.reddit.com${post.permalink as string || ''}`,
            selftext: post.selftext as string || '',
            is_self: post.is_self as boolean || false,
            link_flair_text: post.link_flair_text as string || null,
            gilded: post.gilded as number || 0,
          } : null,
          comments,
          comment_count: comments.length,
          sort,
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
        const message = error instanceof Error ? error.message : 'Unknown error fetching post detail';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                subreddit,
                post_id,
                hint: message.includes('404')
                  ? 'Post not found. Check the subreddit and post_id.'
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
