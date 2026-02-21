import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LinkedInClient } from '../client.js';
import type { Config, LinkedInProfile } from '../types.js';

export function registerGetProfileTool(server: McpServer, config: Config): void {
  const client = new LinkedInClient(config.api, config.auth);

  server.tool(
    'linkedin_get_profile',
    'Get the current authenticated user\'s LinkedIn profile information including name, ID, and profile picture URL.',
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
        const profile = await client.get<LinkedInProfile>('/me');

        // Extract localized name fields if available
        let firstName = profile.localizedFirstName || '';
        let lastName = profile.localizedLastName || '';

        if (!firstName && profile.firstName?.localized) {
          const locale = profile.firstName.preferredLocale;
          const key = `${locale.language}_${locale.country}`;
          firstName = profile.firstName.localized[key] || Object.values(profile.firstName.localized)[0] || '';
        }

        if (!lastName && profile.lastName?.localized) {
          const locale = profile.lastName.preferredLocale;
          const key = `${locale.language}_${locale.country}`;
          lastName = profile.lastName.localized[key] || Object.values(profile.lastName.localized)[0] || '';
        }

        const result = {
          id: profile.id,
          first_name: firstName,
          last_name: lastName,
          full_name: [firstName, lastName].filter(Boolean).join(' '),
          vanity_name: profile.vanityName || null,
          profile_picture: profile.profilePicture?.displayImage || null,
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
                    ? 'Insufficient permissions. Ensure the token has r_liteprofile or r_basicprofile scope.'
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
