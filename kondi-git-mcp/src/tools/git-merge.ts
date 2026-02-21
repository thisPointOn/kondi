import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GitClient } from '../client.js';
import type { Config } from '../types.js';

const gitMergeSchema = {
  branch: z
    .string()
    .describe('Branch to merge into the current branch.'),
  no_ff: z
    .boolean()
    .default(false)
    .describe('Create a merge commit even for fast-forward merges.'),
  squash: z
    .boolean()
    .default(false)
    .describe('Squash all commits into one before merging.'),
};

export function registerGitMergeTool(server: McpServer, config: Config): void {
  const client = new GitClient(config);

  server.tool(
    'git_merge',
    'Merge another branch into the current branch. Use no_ff to always create a merge commit, or squash to combine all changes into a single commit.',
    gitMergeSchema,
    async ({ branch, no_ff, squash }) => {
      try {
        const args: string[] = ['merge'];

        if (no_ff) {
          args.push('--no-ff');
        }

        if (squash) {
          args.push('--squash');
        }

        args.push(branch);

        const result = await client.exec(args);

        const output = result.exitCode === 0
          ? result.stdout || result.stderr || `Merged ${branch} successfully`
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
        const message = error instanceof Error ? error.message : 'Unknown error running git merge';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: message, branch }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
