import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LinkedInClient } from '../client.js';
import type { Config, LinkedInOrganization } from '../types.js';

const getOrganizationSchema = {
  organization_id: z
    .string()
    .min(1)
    .describe('The LinkedIn organization/company ID (numeric string).'),
};

export function registerGetOrganizationTool(server: McpServer, config: Config): void {
  const client = new LinkedInClient(config.api, config.auth);

  server.tool(
    'linkedin_get_organization',
    'Get information about a LinkedIn company/organization page including name, description, industry, employee count, and website.',
    getOrganizationSchema,
    async ({ organization_id }) => {
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

      if (!organization_id || organization_id.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'organization_id is required' }),
            },
          ],
          isError: true,
        };
      }

      try {
        const org = await client.get<LinkedInOrganization>(
          `/organizations/${organization_id.trim()}`
        );

        const result = {
          id: org.id || null,
          name: org.localizedName || null,
          description: org.localizedDescription || null,
          vanity_name: org.vanityName || null,
          website_url: org.websiteUrl || null,
          industries: org.industries || null,
          staff_count_range: org.staffCountRange || null,
          founded_year: org.foundedOn?.year || null,
          specialities: org.specialities || null,
          locations: org.locations || null,
          logo: org.logoV2 || null,
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
        const message =
          error instanceof Error ? error.message : 'Unknown error fetching organization';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: message,
                hint: message.includes('401')
                  ? 'Access token may be expired or invalid. Generate a new token.'
                  : message.includes('403')
                    ? 'Insufficient permissions. Ensure the token has r_organization_social or r_basicprofile scope.'
                    : message.includes('404')
                      ? 'Organization not found. Check the organization ID.'
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
