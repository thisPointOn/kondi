import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GitClient } from '../client.js';
import type { Config } from '../types.js';

const gitStashSchema = {
  action: z
    .enum(['push', 'pop', 'list', 'drop', 'show'])
    .default('push')
    .describe("Stash action: 'push' saves changes, 'pop' restores, 'list' shows all, 'drop' removes one, 'show' shows contents."),
  message: z
    .string()
    .optional()
    .describe('Message for stash push.'),
  stash_ref: z
    .string()
    .default('stash@{0}')
    .describe('Which stash to pop/drop/show (default: stash@{0}).'),
};

export function registerGitStashTool(server: McpServer, config: Config): void {
  const client = new GitClient(config);

  server.tool(
    'git_stash',
    "Temporarily save uncommitted changes. 'push' saves changes, 'pop' restores the most recent, 'list' shows all stashes, 'drop' removes one, 'show' shows stash contents.",
    gitStashSchema,
    async ({ action, message, stash_ref }) => {
      try {
        const args: string[] = ['stash'];

        switch (action) {
          case 'push':
            args.push('push');
            if (message) {
              args.push('-m', message);
            }
            break;
          case 'pop':
            args.push('pop', stash_ref);
            break;
          case 'list':
            args.push('list');
            break;
          case 'drop':
            args.push('drop', stash_ref);
            break;
          case 'show':
            args.push('show', '-p', stash_ref);
            break;
        }

        const result = await client.exec(args);

        const output = result.exitCode === 0
          ? result.stdout || result.stderr || `Stash ${action} completed`
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
        const message_ = error instanceof Error ? error.message : 'Unknown error running git stash';

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
