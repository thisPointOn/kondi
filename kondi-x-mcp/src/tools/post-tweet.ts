import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { XClient } from '../client.js';
import type { Config } from '../types.js';

const postTweetSchema = {
  text: z
    .string()
    .min(1)
    .max(280)
    .describe('The text content of the tweet. Maximum 280 characters.'),
  reply_to_tweet_id: z
    .string()
    .optional()
    .describe('Tweet ID to reply to. If provided, the new tweet will be a reply to this tweet.'),
};

export function registerPostTweetTool(server: McpServer, config: Config): void {
  const client = new XClient(config);

  server.tool(
    'x_post_tweet',
    'Post a new tweet to X (Twitter). Optionally reply to an existing tweet by providing reply_to_tweet_id.',
    postTweetSchema,
    async ({ text, reply_to_tweet_id }) => {
      try {
        const response = await client.postTweet(text, reply_to_tweet_id);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error posting tweet';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                text,
                reply_to_tweet_id,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
