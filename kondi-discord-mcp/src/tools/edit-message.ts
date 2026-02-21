import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DiscordClient } from '../client.js';
import type { Config } from '../types.js';

const editMessageSchema = {
  channel_id: z.string().describe('The ID of the channel containing the message.'),
  message_id: z.string().describe('The ID of the message to edit.'),
  content: z.string().describe('The new text content for the message.'),
};

export function registerEditMessageTool(server: McpServer, config: Config): void {
  const client = new DiscordClient(config);

  server.tool(
    'discord_edit_message',
    'Edit a previously sent message. Only messages sent by the bot can be edited. Updates the message content in place.',
    editMessageSchema,
    async ({ channel_id, message_id, content }) => {
      if (!client.hasToken()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'Bot token not configured. Set KONDI_DISCORD_BOT_TOKEN or add auth.bot_token to config.',
              }),
            },
          ],
          isError: true,
        };
      }

      if (!content || content.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Message content cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const message = await client.editMessage(channel_id, message_id, content);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(message, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: errorMessage,
                channel_id,
                message_id,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
