import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GitClient } from '../client.js';
import type { Config } from '../types.js';

const gitLogSchema = {
  count: z
    .number()
    .min(1)
    .max(100)
    .default(20)
    .describe('Maximum number of commits to show (1-100, default 20).'),
  branch: z
    .string()
    .optional()
    .describe('Branch name to show log for. Defaults to the current branch.'),
  author: z
    .string()
    .optional()
    .describe('Filter commits by author name or email.'),
  since: z
    .string()
    .optional()
    .describe("Show commits after this date. E.g. '2024-01-01' or '1 week ago'."),
  format: z
    .string()
    .optional()
    .describe("Custom --format string. Defaults to '--oneline --decorate' if not provided."),
};

export function registerGitLogTool(server: McpServer, config: Config): void {
  const client = new GitClient(config);

  server.tool(
    'git_log',
    'View commit history. Shows commit hashes, messages, branch/tag decorations. Filter by branch, author, or date range.',
    gitLogSchema,
    async ({ count, branch, author, since, format }) => {
      try {
        const args: string[] = ['log', `--max-count=${count}`];

        if (format) {
          args.push(`--format=${format}`);
        } else {
          args.push('--oneline', '--decorate');
        }

        if (author) {
          args.push(`--author=${author}`);
        }

        if (since) {
          args.push(`--since=${since}`);
        }

        if (branch) {
          args.push(branch);
        }

        const result = await client.exec(args);

        const output = result.exitCode === 0
          ? result.stdout || 'No commits found'
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
        const message = error instanceof Error ? error.message : 'Unknown error running git log';

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
