import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GitClient } from '../client.js';
import type { Config } from '../types.js';

const gitTagSchema = {
  action: z
    .enum(['list', 'create'])
    .default('list')
    .describe("Tag action: 'list' shows existing tags, 'create' creates a new tag."),
  name: z
    .string()
    .optional()
    .describe('Tag name (required for create).'),
  message: z
    .string()
    .optional()
    .describe('Annotation message (creates annotated tag).'),
};

export function registerGitTagTool(server: McpServer, config: Config): void {
  const client = new GitClient(config);

  server.tool(
    'git_tag',
    'List existing tags sorted by date, or create a new tag at the current commit. Annotated tags include a message.',
    gitTagSchema,
    async ({ action, name, message }) => {
      try {
        const args: string[] = ['tag'];

        if (action === 'list') {
          args.push('-l', '--sort=-creatordate');
        } else if (action === 'create') {
          if (!name) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'Tag name is required for create action' }),
                },
              ],
              isError: true,
            };
          }

          if (message) {
            args.push('-a', name, '-m', message);
          } else {
            args.push(name);
          }
        }

        const result = await client.exec(args);

        let output: string;
        if (action === 'list') {
          output = result.exitCode === 0
            ? result.stdout || 'No tags found'
            : `Exit code ${result.exitCode}\n${result.stdout}\n${result.stderr}`.trim();
        } else {
          output = result.exitCode === 0
            ? result.stdout || result.stderr || `Tag '${name}' created`
            : `Exit code ${result.exitCode}\n${result.stdout}\n${result.stderr}`.trim();
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: output,
            },
          ],
        };
      } catch (error) {
        const message_ = error instanceof Error ? error.message : 'Unknown error running git tag';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: message_ }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
