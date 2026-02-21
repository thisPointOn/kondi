import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TelegramClient } from '../client.js';
import type { Config } from '../types.js';

const setChatDescriptionSchema = {
  chat_id: z
    .union([z.string(), z.number()])
    .describe('Unique identifier for the target chat, or username of the target channel (e.g. @channelusername).'),
  description: z
    .string()
    .max(255)
    .describe('New chat description, 0-255 characters.'),
};

export function registerSetChatDescriptionTool(server: McpServer, config: Config): void {
  const client = new TelegramClient(config.api, config.auth);

  server.tool(
    'telegram_set_chat_description',
    'Change the description of a group, supergroup, or channel. The bot must have appropriate admin rights.',
    setChatDescriptionSchema,
    async ({ chat_id, description }) => {
      try {
        const response = await client.call<boolean>('setChatDescription', {
          chat_id,
          description,
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
                    ? 'The bot needs admin rights with the "change group info" permission.'
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
