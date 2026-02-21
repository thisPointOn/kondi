import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RedditClient } from '../client.js';
import type { Config, SubmitResult } from '../types.js';

const submitCommentSchema = {
  parent_fullname: z
    .string()
    .describe(
      'Fullname of the parent to reply to. Use "t3_<id>" for a post or "t1_<id>" for a comment. Example: "t3_abc123"'
    ),
  text: z
    .string()
    .describe('Comment text. Supports Reddit markdown.'),
};

export function registerSubmitCommentTool(server: McpServer, config: Config): void {
  const client = new RedditClient(config.api, config.auth);

  server.tool(
    'reddit_submit_comment',
    'Submit a comment on a post or reply to another comment. Use parent_fullname with t3_ prefix for posts or t1_ prefix for comments. Requires authentication.',
    submitCommentSchema,
    async ({ parent_fullname, text }) => {
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

      if (!parent_fullname || parent_fullname.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'parent_fullname cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      if (!text || text.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Comment text cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      // Validate fullname format
      if (!/^t[13]_[a-z0-9]+$/i.test(parent_fullname.trim())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'Invalid parent_fullname format. Must be "t3_<id>" (post) or "t1_<id>" (comment).',
                parent_fullname,
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        const data = await client.postForm('/api/comment', {
          thing_id: parent_fullname.trim(),
          text: text,
          api_type: 'json',
        }) as {
          json?: {
            errors?: string[][];
            data?: {
              things?: Array<{
                data: {
                  id?: string;
                  name?: string;
                  permalink?: string;
                };
              }>;
            };
          };
        };

        const errors = data.json?.errors;
        if (errors && errors.length > 0) {
          const errorMessages = errors.map(
            (e: string[]) => e.length >= 2 ? `${e[0]}: ${e[1]}` : e.join(': ')
          );

          const result: SubmitResult = {
            success: false,
            errors: errorMessages,
          };

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
            isError: true,
          };
        }

        const commentData = data.json?.data?.things?.[0]?.data;
        const result: SubmitResult = {
          success: true,
          id: commentData?.id,
          fullname: commentData?.name,
          url: commentData?.permalink
            ? `https://www.reddit.com${commentData.permalink}`
            : undefined,
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
        const message = error instanceof Error ? error.message : 'Unknown error submitting comment';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                parent_fullname,
                hint: message.includes('403') || message.includes('401')
                  ? 'Check that your access token is valid and has submit permissions.'
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
