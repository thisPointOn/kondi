#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { registerGitStatusTool } from './tools/git-status.js';
import { registerGitLogTool } from './tools/git-log.js';
import { registerGitDiffTool } from './tools/git-diff.js';
import { registerGitShowTool } from './tools/git-show.js';
import { registerGitBranchTool } from './tools/git-branch.js';
import { registerGitCheckoutTool } from './tools/git-checkout.js';
import { registerGitAddTool } from './tools/git-add.js';
import { registerGitCommitTool } from './tools/git-commit.js';
import { registerGitPushTool } from './tools/git-push.js';
import { registerGitPullTool } from './tools/git-pull.js';
import { registerGitStashTool } from './tools/git-stash.js';
import { registerGitBlameTool } from './tools/git-blame.js';
import { registerGitRemoteTool } from './tools/git-remote.js';
import { registerGitTagTool } from './tools/git-tag.js';
import { registerGitMergeTool } from './tools/git-merge.js';

const VERSION = '1.0.0';

async function main() {
  const config = loadConfig();

  // Parse command line arguments
  const args = process.argv.slice(2);
  let transport: 'stdio' | 'sse' = config.server.transport;
  let port = config.server.port;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--transport' && args[i + 1]) {
      transport = args[i + 1] as 'stdio' | 'sse';
      i++;
    } else if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
kondi-git-mcp v${VERSION}

MCP server providing Git tools.

Usage:
  kondi-git-mcp [options]

Options:
  --transport <type>  Transport mode: stdio (default) or sse
  --port <number>     Port for SSE transport (default: 18209)
  --help, -h          Show this help message

Environment Variables:
  KONDI_GIT_WORKING_DIR  Git working directory (default: current directory)
  KONDI_GIT_TIMEOUT_MS   Command timeout in milliseconds (default: 30000)
  KONDI_GIT_TRANSPORT    Transport mode
  KONDI_GIT_PORT         SSE port
  KONDI_GIT_LOG_LEVEL    Log level: debug, info, warn, error

Config File:
  ~/.config/kondi-git/config.json

Tools:
  git_status      Show working tree status
  git_log         View commit history
  git_diff        Show changes (staged or unstaged)
  git_show        Show commit contents
  git_branch      List branches
  git_checkout    Switch branches or create new ones
  git_add         Stage files for commit
  git_commit      Create a commit
  git_push        Push commits to remote
  git_pull        Fetch and integrate remote changes
  git_stash       Temporarily save uncommitted changes
  git_blame       Show line-by-line file annotations
  git_remote      List remote repositories
  git_tag         List or create tags
  git_merge       Merge branches
`);
      process.exit(0);
    }
  }

  // Create MCP server
  const server = new McpServer({
    name: 'kondi-git',
    version: VERSION,
  });

  // Register tools
  registerGitStatusTool(server, config);
  registerGitLogTool(server, config);
  registerGitDiffTool(server, config);
  registerGitShowTool(server, config);
  registerGitBranchTool(server, config);
  registerGitCheckoutTool(server, config);
  registerGitAddTool(server, config);
  registerGitCommitTool(server, config);
  registerGitPushTool(server, config);
  registerGitPullTool(server, config);
  registerGitStashTool(server, config);
  registerGitBlameTool(server, config);
  registerGitRemoteTool(server, config);
  registerGitTagTool(server, config);
  registerGitMergeTool(server, config);

  // Log startup info to stderr (stdout is reserved for MCP protocol)
  const log = (msg: string) => {
    if (transport === 'stdio') {
      process.stderr.write(`[kondi-git] ${msg}\n`);
    } else {
      console.log(`[kondi-git] ${msg}`);
    }
  };

  log(`Starting kondi-git-mcp v${VERSION}`);
  log(`  Transport: ${transport}`);
  log(`  Working Dir: ${config.api.working_dir}`);
  log(`  Timeout: ${config.api.timeout_ms}ms`);
  log(`  Tools: git_status, git_log, git_diff, git_show, git_branch, git_checkout, git_add, git_commit, git_push, git_pull, git_stash, git_blame, git_remote, git_tag, git_merge`);

  // Start appropriate transport
  if (transport === 'stdio') {
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    log('Ready.');
  } else {
    // SSE transport
    log(`  Port: ${port}`);

    // Dynamic import for SSE transport
    const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
    const http = await import('http');

    const httpServer = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // Health endpoint
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ready',
            version: VERSION,
            working_dir: config.api.working_dir,
          })
        );
        return;
      }

      // MCP endpoint
      if (req.url === '/mcp' || req.url === '/sse') {
        const sseTransport = new SSEServerTransport('/mcp', res);
        await server.connect(sseTransport);
        return;
      }

      // 404 for other paths
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    httpServer.listen(port, () => {
      log('Ready.');
      log(`  SSE endpoint: http://localhost:${port}/mcp`);
      log(`  Health check: http://localhost:${port}/health`);
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      log('Shutting down...');
      httpServer.close(() => {
        process.exit(0);
      });
    });

    process.on('SIGTERM', () => {
      log('Shutting down...');
      httpServer.close(() => {
        process.exit(0);
      });
    });
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
