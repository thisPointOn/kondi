#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { FacebookClient } from './client.js';
import { registerPagePostTool } from './tools/page-post.js';
import { registerGetPagePostsTool } from './tools/get-page-posts.js';
import { registerGetPostTool } from './tools/get-post.js';
import { registerDeletePostTool } from './tools/delete-post.js';
import { registerGetPostCommentsTool } from './tools/get-post-comments.js';
import { registerReplyToCommentTool } from './tools/reply-to-comment.js';
import { registerGetPageInfoTool } from './tools/get-page-info.js';
import { registerGetPostReactionsTool } from './tools/get-post-reactions.js';
import { registerGetPageInsightsTool } from './tools/get-page-insights.js';
import { registerPublishPhotoTool } from './tools/publish-photo.js';
import { registerGetPostInsightsTool } from './tools/get-post-insights.js';
import { registerDeleteCommentTool } from './tools/delete-comment.js';

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
kondi-facebook-mcp v${VERSION}

MCP server for Facebook/Meta Graph API — manage page content, comments, reactions, photos, and analytics.

Usage:
  kondi-facebook-mcp [options]

Options:
  --transport <type>  Transport mode: stdio (default) or sse
  --port <number>     Port for SSE transport (default: 18204)
  --help, -h          Show this help message

Environment Variables:
  KONDI_FACEBOOK_PAGE_ACCESS_TOKEN  Facebook Page Access Token (required)
  KONDI_FACEBOOK_PAGE_ID            Default Facebook Page ID
  KONDI_FACEBOOK_BASE_URL           Graph API base URL (default: https://graph.facebook.com/v19.0)
  KONDI_FACEBOOK_TIMEOUT_MS         Request timeout in ms (default: 10000)
  KONDI_FACEBOOK_TRANSPORT          Transport mode
  KONDI_FACEBOOK_PORT               SSE port
  KONDI_FACEBOOK_LOG_LEVEL          Log level: debug, info, warn, error

Config File:
  ~/.config/kondi-facebook/config.json

Tools:
  fb_page_post          Publish a post to a Page's feed
  fb_get_page_posts     Retrieve recent posts from a Page
  fb_get_post           Get details of a specific post
  fb_delete_post        Delete a post by ID
  fb_get_post_comments  Get comments on a post
  fb_reply_to_comment   Reply to a comment
  fb_get_page_info      Get detailed page information
  fb_get_post_reactions Get reactions on a post
  fb_get_page_insights  Get page analytics/insights
  fb_publish_photo      Publish a photo to a page
  fb_get_post_insights  Get analytics for a specific post
  fb_delete_comment     Delete a comment
`);
      process.exit(0);
    }
  }

  // Create MCP server
  const server = new McpServer({
    name: 'kondi-facebook',
    version: VERSION,
  });

  // Register tools
  registerPagePostTool(server, config);
  registerGetPagePostsTool(server, config);
  registerGetPostTool(server, config);
  registerDeletePostTool(server, config);
  registerGetPostCommentsTool(server, config);
  registerReplyToCommentTool(server, config);
  registerGetPageInfoTool(server, config);
  registerGetPostReactionsTool(server, config);
  registerGetPageInsightsTool(server, config);
  registerPublishPhotoTool(server, config);
  registerGetPostInsightsTool(server, config);
  registerDeleteCommentTool(server, config);

  // Log startup info to stderr (stdout is reserved for MCP protocol)
  const log = (msg: string) => {
    if (transport === 'stdio') {
      process.stderr.write(`[kondi-facebook] ${msg}\n`);
    } else {
      console.log(`[kondi-facebook] ${msg}`);
    }
  };

  log(`Starting kondi-facebook-mcp v${VERSION}`);
  log(`  Transport: ${transport}`);
  log(`  Graph API: ${config.api.base_url}`);

  // Health check — verify token validity
  const client = new FacebookClient(config.api, config.auth);
  const hasToken = !!config.auth.page_access_token;

  if (hasToken) {
    const startTime = Date.now();
    const tokenValid = await client.healthCheck();
    const healthTime = ((Date.now() - startTime) / 1000).toFixed(2);

    if (tokenValid) {
      log(`  Token: valid (${healthTime}s)`);
    } else {
      log(`  Token: INVALID or expired`);
      log(`  WARNING: API calls will fail until a valid token is configured.`);
    }
  } else {
    log(`  Token: NOT SET`);
    log(`  WARNING: Set KONDI_FACEBOOK_PAGE_ACCESS_TOKEN to use this server.`);
  }

  if (config.auth.page_id) {
    log(`  Page ID: ${config.auth.page_id}`);
  } else {
    log(`  Page ID: not set (must be passed per-call)`);
  }

  log(`  Tools: fb_page_post, fb_get_page_posts, fb_get_post, fb_delete_post, fb_get_post_comments, fb_reply_to_comment, fb_get_page_info, fb_get_post_reactions, fb_get_page_insights, fb_publish_photo, fb_get_post_insights, fb_delete_comment`);

  // Start appropriate transport
  if (transport === 'stdio') {
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    log(`Ready.${hasToken ? '' : ' (no token)'}`);
  } else {
    // SSE transport
    log(`  Port: ${port}`);

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
        const healthy = hasToken ? await client.healthCheck() : false;
        res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: healthy ? 'healthy' : 'degraded',
            token: hasToken ? (healthy ? 'valid' : 'invalid') : 'missing',
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
      log(`Ready.${hasToken ? '' : ' (no token)'}`);
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
