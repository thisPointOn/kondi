#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { registerCreatePostTool } from './tools/create-post.js';
import { registerGetProfileTool } from './tools/get-profile.js';
import { registerGetConnectionsTool } from './tools/get-connections.js';
import { registerGetPostsTool } from './tools/get-posts.js';
import { registerDeletePostTool } from './tools/delete-post.js';
import { registerGetPostCommentsTool } from './tools/get-post-comments.js';
import { registerReplyToCommentTool } from './tools/reply-to-comment.js';
import { registerGetPostLikesTool } from './tools/get-post-likes.js';
import { registerLikePostTool } from './tools/like-post.js';
import { registerGetOrganizationTool } from './tools/get-organization.js';

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
kondi-linkedin-mcp v${VERSION}

MCP server providing LinkedIn API tools for posting, engagement, profile, and connections.

Usage:
  kondi-linkedin-mcp [options]

Options:
  --transport <type>  Transport mode: stdio (default) or sse
  --port <number>     Port for SSE transport (default: 18203)
  --help, -h          Show this help message

Environment Variables:
  KONDI_LINKEDIN_ACCESS_TOKEN   LinkedIn OAuth2 access token (required)
  KONDI_LINKEDIN_PERSON_ID      LinkedIn person ID for the authenticated user (required)
  KONDI_LINKEDIN_BASE_URL       API base URL (default: https://api.linkedin.com/v2)
  KONDI_LINKEDIN_TIMEOUT_MS     Request timeout in milliseconds (default: 10000)
  KONDI_LINKEDIN_TRANSPORT      Transport mode
  KONDI_LINKEDIN_PORT           SSE port
  KONDI_LINKEDIN_LOG_LEVEL      Log level: debug, info, warn, error

Config File:
  ~/.config/kondi-linkedin/config.json

Tools:
  linkedin_create_post        Create a LinkedIn post
  linkedin_get_profile        Get authenticated user's profile
  linkedin_get_connections    Get user's connections list
  linkedin_get_posts          Get your recent LinkedIn posts
  linkedin_delete_post        Delete one of your LinkedIn posts
  linkedin_get_post_comments  Get comments on a LinkedIn post
  linkedin_reply_to_comment   Reply to or comment on a post
  linkedin_get_post_likes     Get likes/reactions on a post
  linkedin_like_post          Like a LinkedIn post
  linkedin_get_organization   Get company/organization info
`);
      process.exit(0);
    }
  }

  // Create MCP server
  const server = new McpServer({
    name: 'kondi-linkedin',
    version: VERSION,
  });

  // Register tools
  registerCreatePostTool(server, config);
  registerGetProfileTool(server, config);
  registerGetConnectionsTool(server, config);
  registerGetPostsTool(server, config);
  registerDeletePostTool(server, config);
  registerGetPostCommentsTool(server, config);
  registerReplyToCommentTool(server, config);
  registerGetPostLikesTool(server, config);
  registerLikePostTool(server, config);
  registerGetOrganizationTool(server, config);

  // Log startup info to stderr (stdout is reserved for MCP protocol)
  const log = (msg: string) => {
    if (transport === 'stdio') {
      process.stderr.write(`[kondi-linkedin] ${msg}\n`);
    } else {
      console.log(`[kondi-linkedin] ${msg}`);
    }
  };

  log(`Starting kondi-linkedin-mcp v${VERSION}`);
  log(`  Transport: ${transport}`);
  log(`  API Base: ${config.api.base_url}`);
  log(`  Auth: ${config.auth.access_token ? 'token configured' : 'NO TOKEN - tools will return errors'}`);
  log(`  Person ID: ${config.auth.person_id || 'NOT SET - create_post will return errors'}`);
  log(`  Tools: linkedin_create_post, linkedin_get_profile, linkedin_get_connections, linkedin_get_posts, linkedin_delete_post, linkedin_get_post_comments, linkedin_reply_to_comment, linkedin_get_post_likes, linkedin_like_post, linkedin_get_organization`);

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
            status: config.auth.access_token ? 'healthy' : 'degraded',
            auth: config.auth.access_token ? 'configured' : 'missing',
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
