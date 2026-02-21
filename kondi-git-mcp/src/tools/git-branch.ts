import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GitClient } from '../client.js';
import type { Config } from '../types.js';

const gitBranchSchema = {
  all: z
    .boolean()
    .default(false)
    .describe('Include remote-tracking branches.'),
  sort: z
    .string()
    .default('-committerdate')
    .describe("Sort key for branches. Default: '-committerdate' (most recent first)."),
};

export function registerGitBranchTool(server: McpServer, config: Config): void {
  const client = new GitClient(config);

  server.tool(
    'git_branch',
    "List branches sorted by most recent commit. Shows the current branch marked with an asterisk. Use 'all' to include remote branches.",
    gitBranchSchema,
    async ({ all, sort }) => {
      try {
        const args: string[] = ['branch', `--sort=${sort}`];

        if (all) {
          args.push('-a');
        }

        const result = await client.exec(args);

        const output = result.exitCode === 0
          ? result.stdout || 'No branches found'
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
        const message = error instanceof Error ? error.message : 'Unknown error running git branch';

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
