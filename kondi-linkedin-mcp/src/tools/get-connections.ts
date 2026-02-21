import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LinkedInClient } from '../client.js';
import type { Config, LinkedInConnectionsResponse } from '../types.js';

const getConnectionsSchema = {
  count: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(10)
    .describe('Number of connections to return. Default: 10. Max: 100.'),
  start: z
    .number()
    .min(0)
    .optional()
    .default(0)
    .describe('Pagination offset. Default: 0.'),
};

export function registerGetConnectionsTool(server: McpServer, config: Config): void {
  const client = new LinkedInClient(config.api, config.auth);

  server.tool(
    'linkedin_get_connections',
    'Get the authenticated user\'s LinkedIn connections list. Returns connection URNs and creation timestamps with pagination support.',
    getConnectionsSchema,
    async ({ count = 10, start = 0 }) => {
      // Check for access token
      if (!client.hasToken()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'No access token configured',
                hint: 'Set KONDI_LINKEDIN_ACCESS_TOKEN environment variable or configure auth.access_token in ~/.config/kondi-linkedin/config.json',
              }),
            },
          ],
          isError: true,
        };
      }

      const sanitizedCount = Math.min(Math.max(1, count), 100);

      try {
        const response = await client.get<LinkedInConnectionsResponse>('/connections', {
          q: 'viewer',
          start: start.toString(),
          count: sanitizedCount.toString(),
        });

        const result = {
          connections: response.elements.map((conn) => ({
            person_urn: conn.to,
            connected_at: conn.createdAt
              ? new Date(conn.createdAt).toISOString()
              : null,
          })),
          pagination: {
            start: response.paging.start,
            count: response.paging.count,
            total: response.paging.total ?? null,
          },
          number_of_results: response.elements.length,
          fetched_at: new Date().toISOString(),
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
        const message =
          error instanceof Error ? error.message : 'Unknown error fetching connections';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                hint: message.includes('401')
                  ? 'Access token may be expired or invalid. Generate a new token.'
                  : message.includes('403')
                    ? 'Insufficient permissions. Ensure the token has r_network or r_1st_connections_size scope.'
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
