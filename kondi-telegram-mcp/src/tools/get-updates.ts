import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TelegramClient } from '../client.js';
import type { Config, TelegramUpdate } from '../types.js';

const getUpdatesSchema = {
  offset: z
    .number()
    .optional()
    .describe(
      'Identifier of the first update to be returned. Must be greater by one than the highest update_id previously received. Use this to acknowledge updates and avoid receiving them again.'
    ),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(10)
    .describe('Limits the number of updates to be retrieved. Values between 1-100 are accepted. Default: 10.'),
  timeout: z
    .number()
    .optional()
    .default(0)
    .describe(
      'Timeout in seconds for long polling. Set to 0 for short polling (immediate response). Default: 0.'
    ),
};

export function registerGetUpdatesTool(server: McpServer, config: Config): void {
  const client = new TelegramClient(config.api, config.auth);

  server.tool(
    'telegram_get_updates',
    'Receive incoming updates (messages, edits, channel posts) via the Telegram bot. Use offset to acknowledge previous updates and only receive new ones.',
    getUpdatesSchema,
    async ({ offset, limit = 10, timeout = 0 }) => {
      const sanitizedLimit = Math.min(Math.max(1, limit), 100);

      try {
        const response = await client.call<TelegramUpdate[]>('getUpdates', {
          offset,
          limit: sanitizedLimit,
          timeout,
        });

        const updates = response.result || [];

        const result = {
          updates,
          count: updates.length,
          next_offset: updates.length > 0 ? updates[updates.length - 1].update_id + 1 : undefined,
        };

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
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
