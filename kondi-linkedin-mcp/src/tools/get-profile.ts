import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LinkedInClient } from '../client.js';
import type { Config, LinkedInUserInfo } from '../types.js';

export function registerGetProfileTool(server: McpServer, config: Config): void {
  const client = new LinkedInClient(config.api, config.auth);

  server.tool(
    'linkedin_get_profile',
    'Get the current authenticated user\'s LinkedIn profile information including name, email, and profile picture URL. Uses the OpenID Connect userinfo endpoint.',
    {},
    async () => {
      // Check for access token
      if (!client.hasToken()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'No access token configured',
                hint: 'Set KONDI_LINKEDIN_ACCESS_TOKEN environment variable or configure auth.access_token in ~/.config/kondi-linkedin/config.json',
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        const profile = await client.get<LinkedInUserInfo>('/v2/userinfo');

        const result = {
          sub: profile.sub,
          name: profile.name || null,
          given_name: profile.given_name || null,
          family_name: profile.family_name || null,
          email: profile.email || null,
          email_verified: profile.email_verified ?? null,
          picture: profile.picture || null,
          locale: profile.locale || null,
          fetched_at: new Date().toISOString(),
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
        const message = error instanceof Error ? error.message : 'Unknown error fetching profile';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                hint: message.includes('401')
                  ? 'Access token may be expired or invalid. Generate a new token.'
                  : message.includes('403')
                    ? 'Insufficient permissions. Ensure the token has openid and profile scopes.'
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
