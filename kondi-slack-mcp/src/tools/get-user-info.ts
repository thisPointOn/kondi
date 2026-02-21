import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SlackClient } from '../client.js';
import type { UsersInfoResponse } from '../types.js';

const getUserInfoSchema = {
  user_id: z
    .string()
    .describe('Slack user ID (e.g., U01234ABCDE). Use slack_list_users to find user IDs.'),
};

export function registerGetUserInfoTool(server: McpServer, client: SlackClient): void {
  server.tool(
    'slack_get_user_info',
    "Get detailed profile information for a Slack user including display name, real name, email, title, status, timezone, and whether they're a bot or admin.",
    getUserInfoSchema,
    async ({ user_id }) => {
      try {
        const response = await client.call<UsersInfoResponse>('users.info', {
          user: user_id,
        });

        const user = response.user;
        const result = {
          id: user.id,
          name: user.name,
          real_name: user.real_name || '',
          display_name: user.profile?.display_name || '',
          email: user.profile?.email || '',
          title: user.profile?.title || '',
          status_text: user.profile?.status_text || '',
          status_emoji: user.profile?.status_emoji || '',
          timezone: user.tz || '',
          timezone_label: user.tz_label || '',
          is_admin: user.is_admin || false,
          is_bot: user.is_bot || false,
          is_app_user: user.is_app_user || false,
          deleted: user.deleted || false,
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
                user_id,
                hint: message.includes('user_not_found')
                  ? 'The user ID was not found. Make sure you are using the user ID (e.g., U01234ABCDE), not the username.'
                  : message.includes('missing_scope')
                    ? 'The bot token needs the users:read scope. Check your Slack app permissions.'
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
