import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FacebookClient } from '../client.js';
import type { Config } from '../types.js';

const getPageInsightsSchema = {
  page_id: z
    .string()
    .optional()
    .describe('Facebook Page ID. Uses configured page ID if omitted.'),
  period: z
    .enum(['day', 'week', 'days_28'])
    .optional()
    .default('day')
    .describe('Time period for data breakdown. Default: day.'),
  date_preset: z
    .enum(['today', 'yesterday', 'last_7d', 'last_28d', 'last_30d'])
    .optional()
    .default('last_7d')
    .describe('Date range preset. Default: last_7d.'),
};

export function registerGetPageInsightsTool(server: McpServer, config: Config): void {
  const client = new FacebookClient(config.api, config.auth);

  server.tool(
    'fb_get_page_insights',
    'Get Facebook page analytics including unique impressions, engaged users, page follows, and page views. Data is broken down by the selected time period.',
    getPageInsightsSchema,
    async ({ page_id, period = 'day', date_preset = 'last_7d' }) => {
      const pageId = page_id || client.getDefaultPageId();

      if (!pageId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'No page_id provided and no default page_id configured. Set KONDI_FACEBOOK_PAGE_ID or pass page_id parameter.',
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        const insights = await client.getPageInsights(pageId, period, date_preset);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  page_id: pageId,
                  period,
                  date_preset,
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
              text: JSON.stringify({ error: errorMessage, page_id: pageId }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
