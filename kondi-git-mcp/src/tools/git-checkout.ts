import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GitClient } from '../client.js';
import type { Config } from '../types.js';

const gitCheckoutSchema = {
  ref: z
    .string()
    .describe('Branch name, tag, or commit hash to switch to.'),
  create: z
    .boolean()
    .default(false)
    .describe('Create a new branch with this name.'),
};

export function registerGitCheckoutTool(server: McpServer, config: Config): void {
  const client = new GitClient(config);

  server.tool(
    'git_checkout',
    "Switch to a different branch, tag, or commit. Use 'create' to create and switch to a new branch in one step.",
    gitCheckoutSchema,
    async ({ ref, create }) => {
      try {
        const args: string[] = ['checkout'];

        if (create) {
          args.push('-b');
        }

        args.push(ref);

        const result = await client.exec(args);

        // git checkout outputs to stderr on success (e.g. "Switched to branch 'main'")
        const output = result.exitCode === 0
          ? result.stderr || result.stdout || `Switched to ${ref}`
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
        const message = error instanceof Error ? error.message : 'Unknown error running git checkout';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: message, ref }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
