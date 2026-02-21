import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TelegramClient } from '../client.js';
import type { Config, TelegramUser } from '../types.js';

export function registerGetMeTool(server: McpServer, config: Config): void {
  const client = new TelegramClient(config.api, config.auth);

  server.tool(
    'telegram_get_me',
    'Get basic information about the bot. Returns the bot user object including id, name, username, and capabilities.',
    {},
    async () => {
      try {
        const response = await client.call<TelegramUser>('getMe');

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
