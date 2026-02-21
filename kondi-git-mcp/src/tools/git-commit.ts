import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GitClient } from '../client.js';
import type { Config } from '../types.js';

const gitCommitSchema = {
  message: z
    .string()
    .min(1)
    .max(5000)
    .describe('Commit message. First line should be a concise summary under 72 chars.'),
};

export function registerGitCommitTool(server: McpServer, config: Config): void {
  const client = new GitClient(config);

  server.tool(
    'git_commit',
    'Create a new commit with all staged changes. Only staged files (use git_add first) will be included.',
    gitCommitSchema,
    async ({ message }) => {
      try {
        const args: string[] = ['commit', '-m', message];

        const result = await client.exec(args);

        const output = result.exitCode === 0
          ? result.stdout || 'Commit created'
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
        const message_ = error instanceof Error ? error.message : 'Unknown error running git commit';

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
