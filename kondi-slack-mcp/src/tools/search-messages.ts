import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SlackClient } from '../client.js';
import type { SearchMessagesResponse } from '../types.js';

const searchMessagesSchema = {
  query: z
    .string()
    .describe(
      "Search query. Supports Slack search modifiers like 'from:@user', 'in:#channel', 'has:link', 'before:2024-01-01', 'after:2024-01-01'."
    ),
  count: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe('Number of results to return. Default: 20. Max: 100.'),
  sort: z
    .enum(['score', 'timestamp'])
    .optional()
    .default('score')
    .describe('Sort order: "score" (relevance) or "timestamp" (newest first). Default: score.'),
};

export function registerSearchMessagesTool(server: McpServer, client: SlackClient): void {
  server.tool(
    'slack_search_messages',
    "Search for messages across the workspace. Supports Slack search operators like 'from:@user', 'in:#channel', 'has:reaction', 'has:link', 'before:date', 'after:date'. Returns matching messages with channel context.",
    searchMessagesSchema,
    async ({ query, count = 20, sort = 'score' }) => {
      if (!query || query.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Search query cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      const sanitizedCount = Math.min(Math.max(1, count), 100);

      try {
        const response = await client.call<SearchMessagesResponse>('search.messages', {
          query,
          count: sanitizedCount,
          sort,
        });

        const matches = (response.messages?.matches || []).map((match) => ({
          user: match.user || 'unknown',
          username: match.username || '',
          text: match.text,
          ts: match.ts,
          channel: match.channel
            ? { id: match.channel.id, name: match.channel.name }
            : null,
          permalink: match.permalink || '',
        }));

        const result = {
          query,
          total: response.messages?.total || 0,
          matches,
          match_count: matches.length,
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
                query,
                hint: message.includes('missing_scope')
                  ? 'The bot token needs the search:read scope. Check your Slack app permissions.'
                  : message.includes('token')
                    ? 'Check your KONDI_SLACK_BOT_TOKEN configuration.'
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
