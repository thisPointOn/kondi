import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SlackClient } from '../client.js';
import type { PostMessageResponse } from '../types.js';

const postMessageSchema = {
  channel: z
    .string()
    .describe('Channel ID to post to (e.g., C01234ABCDE). Use slack_list_channels to find IDs.'),
  text: z
    .string()
    .describe('Message text. Supports Slack mrkdwn formatting.'),
  thread_ts: z
    .string()
    .optional()
    .describe('Thread timestamp to reply to. Makes the message a threaded reply.'),
};

export function registerPostMessageTool(server: McpServer, client: SlackClient): void {
  server.tool(
    'slack_post_message',
    'Post a message to a Slack channel or reply to a thread. Requires the channel ID (not name) and message text. Optionally specify thread_ts to reply in a thread.',
    postMessageSchema,
    async ({ channel, text, thread_ts }) => {
      if (!text || text.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Message text cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const body: Record<string, unknown> = { channel, text };
        if (thread_ts) {
          body.thread_ts = thread_ts;
        }

        const response = await client.call<PostMessageResponse>('chat.postMessage', body);

        const result = {
          ok: true,
          channel: response.channel,
          ts: response.ts,
          thread_ts: thread_ts || null,
          message: {
            text: response.message?.text || text,
            ts: response.ts,
          },
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
                channel,
                hint: message.includes('channel_not_found')
                  ? 'Make sure the bot is invited to the channel and the channel ID is correct.'
                  : message.includes('not_in_channel')
                    ? 'The bot needs to be invited to this channel first.'
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
