import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GitClient } from '../client.js';
import type { Config } from '../types.js';

export function registerGitStatusTool(server: McpServer, config: Config): void {
  const client = new GitClient(config);

  server.tool(
    'git_status',
    'Show the working tree status including staged, modified, and untracked files, plus the current branch and tracking info. Returns machine-parsable output.',
    {},
    async () => {
      try {
        const result = await client.exec(['status', '--porcelain=v2', '--branch']);

        const output = result.exitCode === 0
          ? result.stdout || 'Working tree clean'
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
        const message = error instanceof Error ? error.message : 'Unknown error running git status';

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
