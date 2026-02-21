import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TelegramClient } from '../client.js';
import type { Config } from '../types.js';

const getChatMemberCountSchema = {
  chat_id: z
    .union([z.string(), z.number()])
    .describe('Unique identifier for the target chat, or username of the target supergroup or channel (e.g. @channelusername).'),
};

export function registerGetChatMemberCountTool(server: McpServer, config: Config): void {
  const client = new TelegramClient(config.api, config.auth);

  server.tool(
    'telegram_get_chat_member_count',
    'Get the number of members in a group, supergroup, or channel.',
    getChatMemberCountSchema,
    async ({ chat_id }) => {
      try {
        const response = await client.call<number>('getChatMemberCount', {
          chat_id,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ member_count: response.result }, null, 2),
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
                    ? 'Make sure the bot has been added to the chat or the chat_id is correct.'
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
