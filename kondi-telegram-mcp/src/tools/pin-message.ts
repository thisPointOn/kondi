import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TelegramClient } from '../client.js';
import type { Config } from '../types.js';

const pinMessageSchema = {
  chat_id: z
    .union([z.string(), z.number()])
    .describe('Unique identifier for the target chat, or username of the target channel (e.g. @channelusername).'),
  message_id: z.number().describe('Identifier of the message to pin.'),
  silent: z
    .boolean()
    .optional()
    .default(false)
    .describe('Pass true to pin silently without notifying members.'),
};

export function registerPinMessageTool(server: McpServer, config: Config): void {
  const client = new TelegramClient(config.api, config.auth);

  server.tool(
    'telegram_pin_message',
    'Pin a message in a group, supergroup, or channel. The bot must have appropriate admin rights.',
    pinMessageSchema,
    async ({ chat_id, message_id, silent = false }) => {
      try {
        const response = await client.call<boolean>('pinChatMessage', {
          chat_id,
          message_id,
          disable_notification: silent,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: response.result }, null, 2),
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
                  : message.includes('not enough rights')
                    ? 'The bot needs admin rights with the "pin messages" permission.'
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
