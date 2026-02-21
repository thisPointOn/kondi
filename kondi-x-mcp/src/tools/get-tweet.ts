import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { XClient } from '../client.js';
import type { Config } from '../types.js';

const getTweetSchema = {
  tweet_id: z
    .string()
    .describe('The ID of the tweet to retrieve.'),
  tweet_fields: z
    .string()
    .optional()
    .describe(
      'Comma-separated list of tweet fields to return. Default: "text,created_at,author_id,public_metrics". Available fields include: attachments, author_id, context_annotations, conversation_id, created_at, entities, geo, id, in_reply_to_user_id, lang, public_metrics, possibly_sensitive, referenced_tweets, reply_settings, source, text, withheld.'
    ),
};

export function registerGetTweetTool(server: McpServer, config: Config): void {
  const client = new XClient(config);

  server.tool(
    'x_get_tweet',
    'Get a single tweet by its ID. Returns tweet data with optional field expansions.',
    getTweetSchema,
    async ({ tweet_id, tweet_fields }) => {
      if (!tweet_id || tweet_id.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'tweet_id cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await client.getTweet(tweet_id, tweet_fields);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error getting tweet';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                tweet_id,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
