import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TelegramClient } from '../client.js';
import type { Config, TelegramMessage } from '../types.js';

const forwardMessageSchema = {
  chat_id: z
    .union([z.string(), z.number()])
    .describe('Target chat ID to forward to.'),
  from_chat_id: z
    .union([z.string(), z.number()])
    .describe('Source chat ID to forward from.'),
  message_id: z.number().describe('Message identifier in the source chat.'),
};

export function registerForwardMessageTool(server: McpServer, config: Config): void {
  const client = new TelegramClient(config.api, config.auth);

  server.tool(
    'telegram_forward_message',
    'Forward a message from one chat to another. The forwarded message will show the original sender.',
    forwardMessageSchema,
    async ({ chat_id, from_chat_id, message_id }) => {
      try {
        const response = await client.call<TelegramMessage>('forwardMessage', {
          chat_id,
          from_chat_id,
          message_id,
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
                  : message.includes('chat not found')
                    ? 'Make sure the bot has access to both the source and target chats.'
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
