import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TelegramClient } from '../client.js';
import type { Config, TelegramMessage } from '../types.js';

const editMessageSchema = {
  chat_id: z
    .union([z.string(), z.number()])
    .describe('Unique identifier for the target chat, or username of the target channel (e.g. @channelusername).'),
  message_id: z.number().describe('Identifier of the message to edit.'),
  text: z.string().describe('New text of the message, 1-4096 characters.'),
  parse_mode: z
    .enum(['HTML', 'Markdown', 'MarkdownV2'])
    .optional()
    .describe('Mode for parsing entities in the message text. Options: HTML, Markdown, MarkdownV2.'),
};

export function registerEditMessageTool(server: McpServer, config: Config): void {
  const client = new TelegramClient(config.api, config.auth);

  server.tool(
    'telegram_edit_message',
    'Edit the text of a previously sent message. Only messages sent by the bot can be edited. Supports HTML and Markdown formatting.',
    editMessageSchema,
    async ({ chat_id, message_id, text, parse_mode }) => {
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
        const response = await client.call<TelegramMessage>('editMessageText', {
          chat_id,
          message_id,
          text,
          parse_mode,
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
                  : message.includes('message to edit not found')
                    ? 'Make sure the message_id is correct and the message was sent by the bot.'
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
