import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RedditClient } from '../client.js';
import type { Config, RedditComment } from '../types.js';

const getCommentsSchema = {
  subreddit: z
    .string()
    .describe('Subreddit name (without r/ prefix). Example: "programming"'),
  article_id: z
    .string()
    .describe('Post ID (the base36 ID from the URL, without t3_ prefix). Example: "abc123"'),
  limit: z
    .number()
    .min(1)
    .max(500)
    .optional()
    .default(25)
    .describe('Number of top-level comments to return. Default: 25.'),
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

export function registerGetCommentsTool(server: McpServer, config: Config): void {
  const client = new RedditClient(config.api, config.auth);

  server.tool(
    'reddit_get_comments',
    'Get comments on a specific Reddit post. Returns a flattened comment tree with authors, scores, and depth. Requires authentication.',
    getCommentsSchema,
    async ({ subreddit, article_id, limit = 25 }) => {
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

      if (!article_id || article_id.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Article ID cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const data = await client.get(
          `/r/${encodeURIComponent(subreddit.trim())}/comments/${encodeURIComponent(article_id.trim())}`,
          {
            limit: limit.toString(),
            raw_json: '1',
          }
        ) as Array<{
          data?: {
            children?: Array<{ kind: string; data: Record<string, unknown> }>;
          };
        }>;

        // Reddit returns an array: [post_listing, comments_listing]
        // Index 0 = the post itself, Index 1 = comments
        const commentListing = Array.isArray(data) && data.length >= 2 ? data[1] : null;
        const children = commentListing?.data?.children || [];

        const comments = flattenComments(children);

        // Also extract post info from index 0
        let postTitle = '';
        let postAuthor = '';
        if (Array.isArray(data) && data.length >= 1) {
          const postChildren = data[0]?.data?.children;
          if (postChildren && postChildren.length > 0) {
            const postData = postChildren[0].data;
            postTitle = postData.title as string || '';
            postAuthor = postData.author as string || '';
          }
        }

        const result = {
          subreddit: subreddit.trim(),
          article_id: article_id.trim(),
          post_title: postTitle,
          post_author: postAuthor,
          comments,
          count: comments.length,
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
        const message = error instanceof Error ? error.message : 'Unknown error fetching comments';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                subreddit,
                article_id,
                hint: message.includes('404')
                  ? 'Post not found. Check the subreddit and article_id.'
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
