import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TelegramClient } from '../client.js';
import type { Config, TelegramMessage } from '../types.js';

const sendMessageSchema = {
  chat_id: z
    .union([z.string(), z.number()])
    .describe('Unique identifier for the target chat, or username of the target channel (e.g. @channelusername).'),
  text: z.string().describe('Text of the message to be sent, 1-4096 characters.'),
  parse_mode: z
    .enum(['HTML', 'Markdown', 'MarkdownV2'])
    .optional()
    .describe('Mode for parsing entities in the message text. Options: HTML, Markdown, MarkdownV2.'),
  reply_to_message_id: z
    .number()
    .optional()
    .describe('If the message is a reply, ID of the original message.'),
};

export function registerSendMessageTool(server: McpServer, config: Config): void {
  const client = new TelegramClient(config.api, config.auth);

  server.tool(
    'telegram_send_message',
    'Send a text message to a Telegram chat. Supports HTML, Markdown, and MarkdownV2 formatting.',
    sendMessageSchema,
    async ({ chat_id, text, parse_mode, reply_to_message_id }) => {
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
        const response = await client.call<TelegramMessage>('sendMessage', {
          chat_id,
          text,
          parse_mode,
          reply_to_message_id,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(response.result, null, 2),
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
                hint: message.includes('token')
                  ? 'Set KONDI_TELEGRAM_BOT_TOKEN or add auth.bot_token to config.'
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
