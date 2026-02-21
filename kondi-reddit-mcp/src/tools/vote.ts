import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RedditClient } from '../client.js';
import type { Config } from '../types.js';

const voteSchema = {
  fullname: z
    .string()
    .describe(
      "Reddit fullname of the thing to vote on, e.g. 't3_abc123' for a post or 't1_def456' for a comment. t3_ prefix = post, t1_ prefix = comment."
    ),
  direction: z
    .number()
    .describe('1 = upvote, 0 = remove vote, -1 = downvote'),
};

export function registerVoteTool(server: McpServer, config: Config): void {
  const client = new RedditClient(config.api, config.auth);

  server.tool(
    'reddit_vote',
    'Vote on a post or comment. Direction: 1=upvote, 0=unvote, -1=downvote. The fullname must include the type prefix (t3_ for posts, t1_ for comments).',
    voteSchema,
    async ({ fullname, direction }) => {
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

      if (!fullname || fullname.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Fullname cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      // Validate fullname format
      if (!/^t[13]_[a-z0-9]+$/i.test(fullname.trim())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'Invalid fullname format. Must be "t3_<id>" (post) or "t1_<id>" (comment).',
                fullname,
              }),
            },
          ],
          isError: true,
        };
      }

      // Validate direction
      if (direction !== -1 && direction !== 0 && direction !== 1) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'Invalid direction. Must be -1 (downvote), 0 (unvote), or 1 (upvote).',
                direction,
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        await client.postForm('/api/vote', {
          id: fullname.trim(),
          dir: direction.toString(),
        });

        const dirLabel = direction === 1 ? 'upvoted' : direction === -1 ? 'downvoted' : 'unvoted';

        const result = {
          success: true,
          fullname: fullname.trim(),
          direction,
          action: dirLabel,
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
        const message = error instanceof Error ? error.message : 'Unknown error voting';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                fullname,
                hint: message.includes('403') || message.includes('401')
                  ? 'Check that your access token is valid and has vote scope.'
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
