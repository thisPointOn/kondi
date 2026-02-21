import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RedditClient } from '../client.js';
import type { Config } from '../types.js';

const deleteSchema = {
  fullname: z
    .string()
    .describe("Reddit fullname of the post/comment to delete (e.g. 't3_abc123')"),
};

export function registerDeleteTool(server: McpServer, config: Config): void {
  const client = new RedditClient(config.api, config.auth);

  server.tool(
    'reddit_delete',
    'Delete one of your own posts or comments. This action cannot be undone.',
    deleteSchema,
    async ({ fullname }) => {
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

      try {
        await client.postForm('/api/del', {
          id: fullname.trim(),
        });

        const result = {
          success: true,
          fullname: fullname.trim(),
          action: 'deleted',
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
        const message = error instanceof Error ? error.message : 'Unknown error deleting';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                fullname,
                hint: message.includes('403') || message.includes('401')
                  ? 'Check that your access token is valid. You can only delete your own content.'
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
