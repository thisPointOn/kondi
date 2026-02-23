import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InstagramClient } from '../client.js';
import type { Config } from '../types.js';

const getPostInsightsSchema = {
  media_id: z
    .string()
    .describe(
      'The Instagram media ID to get insights for. Obtain this from ig_get_media or ig_publish_photo.'
    ),
};

export function registerGetPostInsightsTool(server: McpServer, config: Config): void {
  const client = new InstagramClient(config);

  server.tool(
    'ig_get_post_insights',
    'Get insights for a specific Instagram media post. Returns impressions, reach, saved, likes, comments, and shares metrics. Only available for posts on Business or Creator accounts.',
    getPostInsightsSchema,
    async ({ media_id }) => {
      if (!media_id || media_id.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'media_id is required and cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await client.getPostInsights(media_id.trim());

        // Flatten insights into a more readable format
        const metrics: Record<string, number> = {};
        for (const insight of response.data) {
          if (insight.values && insight.values.length > 0) {
            metrics[insight.name] = insight.values[0].value;
          }
        }

        const result = {
          media_id: media_id.trim(),
          metrics,
          details: response.data.map((item) => ({
            name: item.name,
            title: item.title,
            description: item.description,
            period: item.period,
            value: item.values?.[0]?.value ?? null,
          })),
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
        const message = error instanceof Error ? error.message : 'Unknown error';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                media_id: media_id.trim(),
                hint: message.includes('not supported')
                  ? 'Insights are only available for Business and Creator account posts. Stories, reels, and album children may have different available metrics.'
                  : message.includes('OAuthException')
                    ? 'Check that your access token has instagram_manage_insights permission.'
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
