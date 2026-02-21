import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TelegramClient } from '../client.js';
import type { Config, TelegramMessage } from '../types.js';

const sendPhotoSchema = {
  chat_id: z
    .union([z.string(), z.number()])
    .describe('Unique identifier for the target chat, or username of the target channel (e.g. @channelusername).'),
  photo: z
    .string()
    .url()
    .describe('Photo to send. Pass an HTTP URL for Telegram to download the photo from the Internet.'),
  caption: z
    .string()
    .optional()
    .describe('Photo caption, 0-1024 characters.'),
};

export function registerSendPhotoTool(server: McpServer, config: Config): void {
  const client = new TelegramClient(config.api, config.auth);

  server.tool(
    'telegram_send_photo',
    'Send a photo to a Telegram chat by URL. Optionally include a caption.',
    sendPhotoSchema,
    async ({ chat_id, photo, caption }) => {
      if (!photo || photo.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Photo URL cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await client.call<TelegramMessage>('sendPhoto', {
          chat_id,
          photo,
          caption,
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
                  : message.includes('wrong file identifier')
                    ? 'Make sure the photo URL is publicly accessible.'
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
