import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TelegramClient } from '../client.js';
import type { Config, TelegramMessage } from '../types.js';

const sendPollSchema = {
  chat_id: z
    .union([z.string(), z.number()])
    .describe('Unique identifier for the target chat, or username of the target channel (e.g. @channelusername).'),
  question: z
    .string()
    .max(300)
    .describe('Poll question, 1-300 characters.'),
  options: z
    .array(z.string())
    .min(2)
    .max(10)
    .describe('Poll answer options, 2-10 strings.'),
  is_anonymous: z
    .boolean()
    .optional()
    .default(true)
    .describe('True if the poll needs to be anonymous. Defaults to true.'),
  type: z
    .enum(['regular', 'quiz'])
    .optional()
    .default('regular')
    .describe("Poll type: 'regular' for voting or 'quiz' for one correct answer. Defaults to 'regular'."),
};

export function registerSendPollTool(server: McpServer, config: Config): void {
  const client = new TelegramClient(config.api, config.auth);

  server.tool(
    'telegram_send_poll',
    'Create a poll in a chat. Regular polls let users vote, quiz polls have one correct answer. Polls can be anonymous or public.',
    sendPollSchema,
    async ({ chat_id, question, options, is_anonymous = true, type = 'regular' }) => {
      if (!question || question.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Poll question cannot be empty' }),
            },
          ],
          isError: true,
        };
      }

      if (!options || options.length < 2) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Poll requires at least 2 options' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await client.call<TelegramMessage>('sendPoll', {
          chat_id,
          question,
          options: JSON.stringify(options.map((o: string) => ({ text: o }))),
          is_anonymous,
          type,
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
