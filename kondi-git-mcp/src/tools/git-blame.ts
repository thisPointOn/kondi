import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GitClient } from '../client.js';
import type { Config } from '../types.js';

const gitBlameSchema = {
  path: z
    .string()
    .describe('File path to annotate.'),
  start_line: z
    .number()
    .optional()
    .describe('Start line number for limiting the blame range.'),
  end_line: z
    .number()
    .optional()
    .describe('End line number for limiting the blame range.'),
};

export function registerGitBlameTool(server: McpServer, config: Config): void {
  const client = new GitClient(config);

  server.tool(
    'git_blame',
    'Show what revision and author last modified each line of a file. Optionally limit to a line range.',
    gitBlameSchema,
    async ({ path, start_line, end_line }) => {
      try {
        const args: string[] = ['blame'];

        if (start_line !== undefined && end_line !== undefined) {
          args.push(`-L`, `${start_line},${end_line}`);
        } else if (start_line !== undefined) {
          args.push(`-L`, `${start_line},`);
        }

        args.push(path);

        const result = await client.exec(args);

        const output = result.exitCode === 0
          ? result.stdout || 'No output'
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
        const message = error instanceof Error ? error.message : 'Unknown error running git blame';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: message, path }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
