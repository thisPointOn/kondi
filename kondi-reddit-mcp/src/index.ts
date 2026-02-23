#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { registerSubmitPostTool } from './tools/submit-post.js';
import { registerGetPostsTool } from './tools/get-posts.js';
import { registerGetCommentsTool } from './tools/get-comments.js';
import { registerSubmitCommentTool } from './tools/submit-comment.js';
import { registerSearchTool } from './tools/search.js';
import { registerGetSubredditInfoTool } from './tools/get-subreddit-info.js';
import { registerGetMeTool } from './tools/get-me.js';
import { registerVoteTool } from './tools/vote.js';
import { registerGetUserTool } from './tools/get-user.js';
import { registerGetPostDetailTool } from './tools/get-post-detail.js';
import { registerSaveTool } from './tools/save.js';
import { registerGetSavedTool } from './tools/get-saved.js';
import { registerGetSubredditRulesTool } from './tools/get-subreddit-rules.js';
import { registerDeleteTool } from './tools/delete.js';

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
kondi-reddit-mcp v${VERSION}

MCP server providing Reddit API tools for posts, comments, and browsing.

Usage:
  kondi-reddit-mcp [options]

Options:
  --transport <type>  Transport mode: stdio (default) or sse
  --port <number>     Port for SSE transport (default: 18206)
  --help, -h          Show this help message

Environment Variables:
  KONDI_REDDIT_CLIENT_ID       Reddit app client ID (for auto token acquisition)
  KONDI_REDDIT_CLIENT_SECRET   Reddit app client secret (for auto token acquisition)
  KONDI_REDDIT_USERNAME        Reddit username (for auto token acquisition)
  KONDI_REDDIT_PASSWORD        Reddit password (for auto token acquisition)
  KONDI_REDDIT_ACCESS_TOKEN    Reddit OAuth2 access token (alternative to above)
  KONDI_REDDIT_BASE_URL        Reddit API base URL (default: https://oauth.reddit.com)
  KONDI_REDDIT_TIMEOUT_MS      Request timeout in ms (default: 10000)
  KONDI_REDDIT_USER_AGENT      User-Agent header
  KONDI_REDDIT_TRANSPORT       Transport mode
  KONDI_REDDIT_PORT            SSE port
  KONDI_REDDIT_LOG_LEVEL       Log level: debug, info, warn, error

Config File:
  ~/.config/kondi-reddit/config.json

Tools:
  reddit_submit_post          Submit a new post to a subreddit
  reddit_get_posts            Get hot posts from a subreddit
  reddit_get_comments         Get comments on a post
  reddit_submit_comment       Reply to a post or comment
  reddit_search               Search Reddit for posts, subreddits, or users
  reddit_get_subreddit_info   Get detailed info about a subreddit
  reddit_get_me               Get the authenticated user's profile
  reddit_vote                 Vote on a post or comment
  reddit_get_user             Get a user's public profile
  reddit_get_post_detail      Get a post with its full comment tree
  reddit_save                 Save a post or comment for later
  reddit_get_saved            Get your saved posts and comments
  reddit_get_subreddit_rules  Get the rules for a subreddit
  reddit_delete               Delete your own post or comment
`);
      process.exit(0);
    }
  }

  // Create MCP server
  const server = new McpServer({
    name: 'kondi-reddit',
    version: VERSION,
  });

  // Register tools
  registerSubmitPostTool(server, config);
  registerGetPostsTool(server, config);
  registerGetCommentsTool(server, config);
  registerSubmitCommentTool(server, config);
  registerSearchTool(server, config);
  registerGetSubredditInfoTool(server, config);
  registerGetMeTool(server, config);
  registerVoteTool(server, config);
  registerGetUserTool(server, config);
  registerGetPostDetailTool(server, config);
  registerSaveTool(server, config);
  registerGetSavedTool(server, config);
  registerGetSubredditRulesTool(server, config);
  registerDeleteTool(server, config);

  // Log startup info to stderr (stdout is reserved for MCP protocol)
  const log = (msg: string) => {
    if (transport === 'stdio') {
      process.stderr.write(`[kondi-reddit] ${msg}\n`);
    } else {
      console.log(`[kondi-reddit] ${msg}`);
    }
  };

  log(`Starting kondi-reddit-mcp v${VERSION}`);
  log(`  Transport: ${transport}`);
  const hasPasswordGrant = !!(config.auth.client_id && config.auth.client_secret && config.auth.username && config.auth.password);
  const hasManualToken = !!config.auth.access_token;
  const authStatus = hasPasswordGrant
    ? 'configured (auto token via password grant)'
    : hasManualToken
      ? 'configured (manual access token)'
      : 'NOT configured (set KONDI_REDDIT_CLIENT_ID + CLIENT_SECRET + USERNAME + PASSWORD, or set KONDI_REDDIT_ACCESS_TOKEN)';
  log(`  Auth: ${authStatus}`);
  log(`  Tools: reddit_submit_post, reddit_get_posts, reddit_get_comments, reddit_submit_comment, reddit_search, reddit_get_subreddit_info, reddit_get_me, reddit_vote, reddit_get_user, reddit_get_post_detail, reddit_save, reddit_get_saved, reddit_get_subreddit_rules, reddit_delete`);

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
        const healthHasPasswordGrant = !!(config.auth.client_id && config.auth.client_secret && config.auth.username && config.auth.password);
        const healthHasManualToken = !!config.auth.access_token;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'healthy',
            auth: healthHasPasswordGrant ? 'password_grant' : healthHasManualToken ? 'manual_token' : 'missing',
            version: VERSION,
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
