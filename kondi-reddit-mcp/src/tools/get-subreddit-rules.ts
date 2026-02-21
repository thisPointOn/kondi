import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RedditClient } from '../client.js';
import type { Config } from '../types.js';

const getSubredditRulesSchema = {
  subreddit: z
    .string()
    .describe('Subreddit name (without r/ prefix). Example: "programming"'),
};

export function registerGetSubredditRulesTool(server: McpServer, config: Config): void {
  const client = new RedditClient(config.api, config.auth);

  server.tool(
    'reddit_get_subreddit_rules',
    'Get the rules for a subreddit. Important to check before posting to ensure your content follows community guidelines.',
    getSubredditRulesSchema,
    async ({ subreddit }) => {
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

      try {
        const data = await client.get(
          `/r/${encodeURIComponent(subreddit.trim())}/about/rules`,
          { raw_json: '1' }
        ) as {
          rules?: Array<{
            kind?: string;
            short_name?: string;
            description?: string;
            description_html?: string;
            violation_reason?: string;
            created_utc?: number;
            priority?: number;
          }>;
          site_rules?: string[];
          site_rules_flow?: Array<Record<string, unknown>>;
        };

        const rules = (data.rules || []).map((rule, index) => ({
          number: index + 1,
          short_name: rule.short_name || '',
          description: rule.description || '',
          kind: rule.kind || '',
          violation_reason: rule.violation_reason || '',
        }));

        const result = {
          subreddit: subreddit.trim(),
          rules,
          rule_count: rules.length,
          site_rules: data.site_rules || [],
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
        const message = error instanceof Error ? error.message : 'Unknown error fetching subreddit rules';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                subreddit,
                hint: message.includes('404')
                  ? 'Subreddit not found. Check the name and try again.'
                  : message.includes('403') || message.includes('401')
                    ? 'Check that your access token is valid.'
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
