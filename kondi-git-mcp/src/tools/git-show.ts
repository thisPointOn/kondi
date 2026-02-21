import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GitClient } from '../client.js';
import type { Config } from '../types.js';

const gitShowSchema = {
  ref: z
    .string()
    .default('HEAD')
    .describe('Commit hash, branch name, tag, or ref like HEAD~3.'),
  stat: z
    .boolean()
    .optional()
    .describe('Show only diffstat summary.'),
  path: z
    .string()
    .optional()
    .describe('Limit output to a specific file path.'),
};

export function registerGitShowTool(server: McpServer, config: Config): void {
  const client = new GitClient(config);

  server.tool(
    'git_show',
    'Show the contents of a commit -- its message, author, date, and the diff of changes it introduced.',
    gitShowSchema,
    async ({ ref, stat, path }) => {
      try {
        const args: string[] = ['show', ref];

        if (stat) {
          args.push('--stat');
        }

        if (path) {
          args.push('--', path);
        }

        const result = await client.exec(args);

        const output = result.exitCode === 0
          ? result.stdout || 'No output'
          : `Exit code ${result.exitCode}\n${result.stdout}\n${result.stderr}`.trim();

        return {
          content: [
            {
              type: 'text' as const,
              text: output,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error running git show';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: message }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
