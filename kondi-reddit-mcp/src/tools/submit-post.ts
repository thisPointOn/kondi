import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RedditClient } from '../client.js';
import type { Config, SubmitResult } from '../types.js';

const submitPostSchema = {
  subreddit: z
    .string()
    .describe('Target subreddit name (without r/ prefix). Example: "programming"'),
  title: z
    .string()
    .describe('Post title. Max 300 characters.'),
  text: z
    .string()
    .optional()
    .describe('Post body text (for self/text posts). Supports markdown.'),
  url: z
    .string()
    .optional()
    .describe('URL to submit (for link posts). Must include scheme (https://).'),
  kind: z
    .enum(['self', 'link'])
    .optional()
    .default('self')
    .describe('Post type: "self" for text posts (default), "link" for URL submissions.'),
};

export function registerSubmitPostTool(server: McpServer, config: Config): void {
  const client = new RedditClient(config.api, config.auth);

  server.tool(
    'reddit_submit_post',
    'Submit a new post to a subreddit. Supports self (text) posts and link posts. Requires authentication.',
    submitPostSchema,
    async ({ subreddit, title, text, url, kind = 'self' }) => {
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

      // Validate inputs
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

      if (!title || title.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Post title cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      if (kind === 'link' && (!url || url.trim().length === 0)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'URL is required for link posts' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const formBody: Record<string, string> = {
          sr: subreddit.trim(),
          title: title.trim(),
          kind,
          api_type: 'json',
        };

        if (kind === 'self' && text) {
          formBody.text = text;
        } else if (kind === 'link' && url) {
          formBody.url = url;
        }

        const data = await client.postForm('/api/submit', formBody) as {
          json?: {
            errors?: string[][];
            data?: {
              id?: string;
              name?: string;
              url?: string;
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

        const postData = data.json?.data;
        const result: SubmitResult = {
          success: true,
          id: postData?.id,
          fullname: postData?.name,
          url: postData?.url,
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
        const message = error instanceof Error ? error.message : 'Unknown error submitting post';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                subreddit,
                title,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
