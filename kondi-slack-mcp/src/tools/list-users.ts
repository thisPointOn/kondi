import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SlackClient } from '../client.js';
import type { UsersListResponse } from '../types.js';

const listUsersSchema = {
  limit: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .default(100)
    .describe('Number of users to return. Default: 100. Max: 200.'),
};

export function registerListUsersTool(server: McpServer, client: SlackClient): void {
  server.tool(
    'slack_list_users',
    'List all users in the Slack workspace. Returns profiles with names, titles, status, and admin/bot flags. Useful for finding user IDs.',
    listUsersSchema,
    async ({ limit = 100 }) => {
      const sanitizedLimit = Math.min(Math.max(1, limit), 200);

      try {
        const response = await client.call<UsersListResponse>('users.list', {
          limit: sanitizedLimit,
        });

        const users = (response.members || []).map((user) => ({
          id: user.id,
          name: user.name,
          real_name: user.real_name || '',
          display_name: user.profile?.display_name || '',
          title: user.profile?.title || '',
          status_text: user.profile?.status_text || '',
          is_admin: user.is_admin || false,
          is_bot: user.is_bot || false,
          deleted: user.deleted || false,
        }));

        const result = {
          users,
          user_count: users.length,
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
                hint: message.includes('missing_scope')
                  ? 'The bot token needs the users:read scope. Check your Slack app permissions.'
                  : message.includes('token')
                    ? 'Check your KONDI_SLACK_BOT_TOKEN configuration.'
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
