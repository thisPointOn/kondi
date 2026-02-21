import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GitClient } from '../client.js';
import type { Config } from '../types.js';

export function registerGitRemoteTool(server: McpServer, config: Config): void {
  const client = new GitClient(config);

  server.tool(
    'git_remote',
    'List all configured remote repositories with their fetch and push URLs.',
    {},
    async () => {
      try {
        const result = await client.exec(['remote', '-v']);

        const output = result.exitCode === 0
          ? result.stdout || 'No remotes configured'
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
        const message = error instanceof Error ? error.message : 'Unknown error running git remote';

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
