import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TelegramClient } from '../client.js';
import type { Config, TelegramMessage } from '../types.js';

const sendDocumentSchema = {
  chat_id: z
    .union([z.string(), z.number()])
    .describe('Unique identifier for the target chat, or username of the target channel (e.g. @channelusername).'),
  document_url: z
    .string()
    .url()
    .describe('URL of the document to send. Telegram will download it.'),
  caption: z
    .string()
    .max(1024)
    .optional()
    .describe('Document caption, 0-1024 characters.'),
};

export function registerSendDocumentTool(server: McpServer, config: Config): void {
  const client = new TelegramClient(config.api, config.auth);

  server.tool(
    'telegram_send_document',
    'Send a document/file to a chat by URL. Telegram will download and serve the file. Supports up to 50MB files.',
    sendDocumentSchema,
    async ({ chat_id, document_url, caption }) => {
      if (!document_url || document_url.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Document URL cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await client.call<TelegramMessage>('sendDocument', {
          chat_id,
          document: document_url,
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
                    ? 'Make sure the document URL is publicly accessible.'
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
