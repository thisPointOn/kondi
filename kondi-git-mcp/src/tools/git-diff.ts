import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GitClient } from '../client.js';
import type { Config } from '../types.js';

const gitDiffSchema = {
  staged: z
    .boolean()
    .default(false)
    .describe('Show staged changes instead of unstaged.'),
  stat: z
    .boolean()
    .default(false)
    .describe('Show diffstat summary instead of full diff.'),
  path: z
    .string()
    .optional()
    .describe('Limit diff to a specific file or directory.'),
};

export function registerGitDiffTool(server: McpServer, config: Config): void {
  const client = new GitClient(config);

  server.tool(
    'git_diff',
    'Show changes between working tree and index (unstaged), or between index and HEAD (staged). Can show full diff or summary stats.',
    gitDiffSchema,
    async ({ staged, stat, path }) => {
      try {
        const args: string[] = ['diff'];

        if (staged) {
          args.push('--staged');
        }

        if (stat) {
          args.push('--stat');
        }

        if (path) {
          args.push('--', path);
        }

        const result = await client.exec(args);

        const output = result.exitCode === 0
          ? result.stdout || 'No differences found'
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
        const message = error instanceof Error ? error.message : 'Unknown error running git diff';

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
