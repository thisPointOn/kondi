import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GitClient } from '../client.js';
import type { Config } from '../types.js';

const gitPushSchema = {
  remote: z
    .string()
    .default('origin')
    .describe('Remote name to push to (default: origin).'),
  branch: z
    .string()
    .optional()
    .describe('Branch to push. Defaults to the current branch.'),
  force: z
    .boolean()
    .default(false)
    .describe('Force push (dangerous -- overwrites remote history).'),
};

export function registerGitPushTool(server: McpServer, config: Config): void {
  const client = new GitClient(config);

  server.tool(
    'git_push',
    'Push local commits to a remote repository. Optionally specify the remote name and branch.',
    gitPushSchema,
    async ({ remote, branch, force }) => {
      try {
        const args: string[] = ['push'];

        if (force) {
          args.push('--force');
        }

        args.push(remote);

        if (branch) {
          args.push(branch);
        }

        const result = await client.exec(args);

        // git push outputs to stderr on success
        const output = result.exitCode === 0
          ? result.stderr || result.stdout || 'Push successful'
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
        const message = error instanceof Error ? error.message : 'Unknown error running git push';

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
