import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DiscordClient } from '../client.js';
import type { Config } from '../types.js';

const embedSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    url: z.string().optional(),
    color: z.number().optional(),
    timestamp: z.string().optional(),
    footer: z
      .object({
        text: z.string(),
        icon_url: z.string().optional(),
      })
      .optional(),
    image: z.object({ url: z.string() }).optional(),
    thumbnail: z.object({ url: z.string() }).optional(),
    author: z
      .object({
        name: z.string(),
        url: z.string().optional(),
        icon_url: z.string().optional(),
      })
      .optional(),
    fields: z
      .array(
        z.object({
          name: z.string(),
          value: z.string(),
          inline: z.boolean().optional(),
        })
      )
      .optional(),
  })
  .describe('Optional rich embed object to include with the message.');

const sendMessageSchema = {
  channel_id: z.string().describe('The ID of the channel to send the message to.'),
  content: z.string().describe('The text content of the message.'),
  embed: embedSchema.optional(),
};

export function registerSendMessageTool(server: McpServer, config: Config): void {
  const client = new DiscordClient(config);

  server.tool(
    'discord_send_message',
    'Send a message to a Discord channel. Supports plain text content and an optional rich embed.',
    sendMessageSchema,
    async ({ channel_id, content, embed }) => {
      if (!client.hasToken()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'Bot token not configured. Set KONDI_DISCORD_BOT_TOKEN or add auth.bot_token to config.',
              }),
            },
          ],
          isError: true,
        };
      }

      if (!content || content.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Message content cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const message = await client.sendMessage(channel_id, content, embed);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(message, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: errorMessage,
                channel_id,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
