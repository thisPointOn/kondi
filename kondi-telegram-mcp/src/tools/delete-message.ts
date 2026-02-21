import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TelegramClient } from '../client.js';
import type { Config } from '../types.js';

const deleteMessageSchema = {
  chat_id: z
    .union([z.string(), z.number()])
    .describe('Unique identifier for the target chat, or username of the target channel (e.g. @channelusername).'),
  message_id: z.number().describe('Identifier of the message to delete.'),
};

export function registerDeleteMessageTool(server: McpServer, config: Config): void {
  const client = new TelegramClient(config.api, config.auth);

  server.tool(
    'telegram_delete_message',
    "Delete a message. Bot can delete its own messages anytime, and other users' messages in groups/supergroups if it has the delete_messages admin right. Messages older than 48 hours in private chats cannot be deleted.",
    deleteMessageSchema,
    async ({ chat_id, message_id }) => {
      try {
        const response = await client.call<boolean>('deleteMessage', {
          chat_id,
          message_id,
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
                  : message.includes('message to delete not found')
                    ? 'Make sure the message_id is correct and the bot has permission to delete it.'
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
