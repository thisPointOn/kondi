import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TelegramClient } from '../client.js';
import type { Config, TelegramChat } from '../types.js';

const getChatSchema = {
  chat_id: z
    .union([z.string(), z.number()])
    .describe('Unique identifier for the target chat, or username of the target supergroup or channel (e.g. @channelusername).'),
};

export function registerGetChatTool(server: McpServer, config: Config): void {
  const client = new TelegramClient(config.api, config.auth);

  server.tool(
    'telegram_get_chat',
    'Get up-to-date information about a Telegram chat (private, group, supergroup, or channel). Returns chat title, type, description, and more.',
    getChatSchema,
    async ({ chat_id }) => {
      try {
        const response = await client.call<TelegramChat>('getChat', {
          chat_id,
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
                hint: message.includes('chat not found')
                  ? 'Make sure the bot has been added to the chat or the chat_id is correct.'
                  : message.includes('token')
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
