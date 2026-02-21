import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InstagramClient } from '../client.js';
import type { Config, InsightsResponse } from '../types.js';

const getAccountInsightsSchema = {
  ig_user_id: z
    .string()
    .optional()
    .describe('Override configured IG user ID'),
  period: z
    .enum(['day', 'week', 'days_28'])
    .optional()
    .default('day')
    .describe('Aggregation period for metrics. Default: day.'),
  days_back: z
    .number()
    .min(1)
    .max(30)
    .optional()
    .default(7)
    .describe('Number of days of data to retrieve. Default: 7. Max: 30.'),
};

export function registerGetAccountInsightsTool(server: McpServer, config: Config): void {
  const client = new InstagramClient(config);

  server.tool(
    'ig_get_account_insights',
    'Get Instagram account-level analytics including impressions, reach, follower count changes, and profile views over a time period.',
    getAccountInsightsSchema,
    async ({ ig_user_id, period = 'day', days_back = 7 }) => {
      let userId: string;
      try {
        userId = client.resolveUserId(ig_user_id);
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: error instanceof Error ? error.message : 'Missing Instagram User ID',
              }),
            },
          ],
          isError: true,
        };
      }

      const sanitizedDaysBack = Math.min(Math.max(1, days_back), 30);
      const now = Math.floor(Date.now() / 1000);
      const since = now - sanitizedDaysBack * 86400;

      try {
        const response = await client.get<InsightsResponse>(
          `${userId}/insights`,
          {
            metric: 'impressions,reach,follower_count,profile_views',
            period,
            since: String(since),
            until: String(now),
          }
        );

        // Flatten insights into a summary
        const metrics: Record<string, unknown> = {};
        for (const insight of response.data) {
          metrics[insight.name] = {
            title: insight.title,
            description: insight.description,
            period: insight.period,
            values: insight.values,
          };
        }

        const result = {
          ig_user_id: userId,
          period,
          days_back: sanitizedDaysBack,
          since: new Date(since * 1000).toISOString(),
          until: new Date(now * 1000).toISOString(),
          metrics,
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
                ig_user_id: userId,
                hint: message.includes('OAuthException')
                  ? 'Check that your access token has instagram_manage_insights permission.'
                  : message.includes('not supported')
                    ? 'Account insights are only available for Business and Creator accounts.'
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
