import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TelegramClient } from '../client.js';
import type { Config, TelegramMessage } from '../types.js';

const sendLocationSchema = {
  chat_id: z
    .union([z.string(), z.number()])
    .describe('Unique identifier for the target chat, or username of the target channel (e.g. @channelusername).'),
  latitude: z
    .number()
    .min(-90)
    .max(90)
    .describe('Latitude of the location, -90 to 90.'),
  longitude: z
    .number()
    .min(-180)
    .max(180)
    .describe('Longitude of the location, -180 to 180.'),
};

export function registerSendLocationTool(server: McpServer, config: Config): void {
  const client = new TelegramClient(config.api, config.auth);

  server.tool(
    'telegram_send_location',
    'Send a location point on the map to a chat.',
    sendLocationSchema,
    async ({ chat_id, latitude, longitude }) => {
      try {
        const response = await client.call<TelegramMessage>('sendLocation', {
          chat_id,
          latitude,
          longitude,
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
