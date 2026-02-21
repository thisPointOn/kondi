#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { registerPostTweetTool } from './tools/post-tweet.js';
import { registerGetTweetTool } from './tools/get-tweet.js';
import { registerGetUserTweetsTool } from './tools/get-user-tweets.js';
import { registerSearchTweetsTool } from './tools/search-tweets.js';
import { registerDeleteTweetTool } from './tools/delete-tweet.js';

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
kondi-x-mcp v${VERSION}

MCP server providing X (Twitter) API tools.

Usage:
  kondi-x-mcp [options]

Options:
  --transport <type>  Transport mode: stdio (default) or sse
  --port <number>     Port for SSE transport (default: 18201)
  --help, -h          Show this help message

Environment Variables:
  KONDI_X_BEARER_TOKEN   X API Bearer Token (required)
  KONDI_X_BASE_URL       API base URL (default: https://api.x.com/2)
  KONDI_X_TIMEOUT_MS     Request timeout in milliseconds (default: 10000)
  KONDI_X_TRANSPORT      Transport mode
  KONDI_X_PORT           SSE port
  KONDI_X_LOG_LEVEL      Log level: debug, info, warn, error

Config File:
  ~/.config/kondi-x/config.json

Tools:
  x_post_tweet       Post a new tweet
  x_get_tweet        Get a tweet by ID
  x_get_user_tweets  Get a user's recent tweets
  x_search_tweets    Search recent tweets
  x_delete_tweet     Delete a tweet
`);
      process.exit(0);
    }
  }

  // Create MCP server
  const server = new McpServer({
    name: 'kondi-x',
    version: VERSION,
  });

  // Register tools
  registerPostTweetTool(server, config);
  registerGetTweetTool(server, config);
  registerGetUserTweetsTool(server, config);
  registerSearchTweetsTool(server, config);
  registerDeleteTweetTool(server, config);

  // Log startup info to stderr (stdout is reserved for MCP protocol)
  const log = (msg: string) => {
    if (transport === 'stdio') {
      process.stderr.write(`[kondi-x] ${msg}\n`);
    } else {
      console.log(`[kondi-x] ${msg}`);
    }
  };

  log(`Starting kondi-x-mcp v${VERSION}`);
  log(`  Transport: ${transport}`);
  log(`  API Base: ${config.api.base_url}`);
  log(`  Auth: ${config.auth.bearer_token ? 'Bearer token configured' : 'WARNING: No bearer token set'}`);
  log(`  Tools: x_post_tweet, x_get_tweet, x_get_user_tweets, x_search_tweets, x_delete_tweet`);

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
            status: config.auth.bearer_token ? 'ready' : 'no_auth',
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
