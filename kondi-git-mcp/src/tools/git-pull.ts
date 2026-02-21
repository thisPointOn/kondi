import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GitClient } from '../client.js';
import type { Config } from '../types.js';

const gitPullSchema = {
  remote: z
    .string()
    .default('origin')
    .describe('Remote name to pull from (default: origin).'),
  branch: z
    .string()
    .optional()
    .describe('Branch to pull. Defaults to the current branch.'),
  rebase: z
    .boolean()
    .default(false)
    .describe('Rebase local commits on top of upstream instead of merging.'),
};

export function registerGitPullTool(server: McpServer, config: Config): void {
  const client = new GitClient(config);

  server.tool(
    'git_pull',
    'Fetch and integrate changes from a remote repository. Use rebase to keep a linear history.',
    gitPullSchema,
    async ({ remote, branch, rebase }) => {
      try {
        const args: string[] = ['pull'];

        if (rebase) {
          args.push('--rebase');
        }

        args.push(remote);

        if (branch) {
          args.push(branch);
        }

        const result = await client.exec(args);

        const output = result.exitCode === 0
          ? result.stdout || result.stderr || 'Pull successful'
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
        const message = error instanceof Error ? error.message : 'Unknown error running git pull';

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
