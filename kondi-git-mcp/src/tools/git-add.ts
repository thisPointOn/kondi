import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GitClient } from '../client.js';
import type { Config } from '../types.js';

const gitAddSchema = {
  paths: z
    .array(z.string())
    .min(1)
    .describe("Files or directories to stage. Use ['.'] to stage everything."),
};

export function registerGitAddTool(server: McpServer, config: Config): void {
  const client = new GitClient(config);

  server.tool(
    'git_add',
    'Stage files for the next commit. Moves changes from the working tree to the staging area (index).',
    gitAddSchema,
    async ({ paths }) => {
      try {
        const args: string[] = ['add', ...paths];

        const result = await client.exec(args);

        const output = result.exitCode === 0
          ? result.stdout || `Staged: ${paths.join(', ')}`
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
        const message = error instanceof Error ? error.message : 'Unknown error running git add';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: message, paths }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
