import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FacebookClient } from '../client.js';
import type { Config } from '../types.js';

const getPostInsightsSchema = {
  post_id: z.string().describe('The Facebook post ID to get insights for.'),
};

export function registerGetPostInsightsTool(server: McpServer, config: Config): void {
  const client = new FacebookClient(config.api, config.auth);

  server.tool(
    'fb_get_post_insights',
    'Get detailed analytics for a specific post including impressions, engagement, clicks, and reaction breakdown.',
    getPostInsightsSchema,
    async ({ post_id }) => {
      if (!post_id || post_id.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'post_id is required and cannot be empty.' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const insights = await client.getPostInsights(post_id.trim());

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  post_id: post_id.trim(),
                  metrics: insights.data,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: errorMessage, post_id }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
