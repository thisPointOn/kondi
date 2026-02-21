#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { InstagramClient } from './client.js';
import { registerPublishPhotoTool } from './tools/publish-photo.js';
import { registerGetMediaTool } from './tools/get-media.js';
import { registerGetPostInsightsTool } from './tools/get-post-insights.js';

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
kondi-instagram-mcp v${VERSION}

MCP server providing Instagram Business Graph API tools.

Usage:
  kondi-instagram-mcp [options]

Options:
  --transport <type>  Transport mode: stdio (default) or sse
  --port <number>     Port for SSE transport (default: 18205)
  --help, -h          Show this help message

Environment Variables:
  KONDI_INSTAGRAM_ACCESS_TOKEN  Instagram / Facebook Graph API access token
  KONDI_INSTAGRAM_USER_ID       Instagram Business account user ID
  KONDI_INSTAGRAM_BASE_URL      Graph API base URL (default: https://graph.facebook.com/v19.0)
  KONDI_INSTAGRAM_TIMEOUT_MS    Request timeout in ms (default: 15000)
  KONDI_INSTAGRAM_TRANSPORT     Transport mode
  KONDI_INSTAGRAM_PORT          SSE port
  KONDI_INSTAGRAM_LOG_LEVEL     Log level: debug, info, warn, error

Config File:
  ~/.config/kondi-instagram/config.json

Tools:
  ig_publish_photo      Publish a photo to Instagram
  ig_get_media          Get recent media posts
  ig_get_post_insights  Get insights for a media post
`);
      process.exit(0);
    }
  }

  // Create MCP server
  const server = new McpServer({
    name: 'kondi-instagram',
    version: VERSION,
  });

  // Register tools
  registerPublishPhotoTool(server, config);
  registerGetMediaTool(server, config);
  registerGetPostInsightsTool(server, config);

  // Log startup info to stderr (stdout is reserved for MCP protocol)
  const log = (msg: string) => {
    if (transport === 'stdio') {
      process.stderr.write(`[kondi-instagram] ${msg}\n`);
    } else {
      console.log(`[kondi-instagram] ${msg}`);
    }
  };

  log(`Starting kondi-instagram-mcp v${VERSION}`);
  log(`  Transport: ${transport}`);

  // Health check Graph API
  const client = new InstagramClient(config);
  const startTime = Date.now();
  const apiHealthy = await client.healthCheck();
  const healthTime = ((Date.now() - startTime) / 1000).toFixed(2);

  if (apiHealthy) {
    log(`  Graph API: ${config.api.base_url} ... reachable (${healthTime}s)`);
    log(`  IG User ID: ${config.auth.ig_user_id}`);
  } else {
    log(`  Graph API: ${config.api.base_url} ... unreachable or not configured`);
    if (!config.auth.access_token) {
      log(`  WARNING: No access token configured. Set KONDI_INSTAGRAM_ACCESS_TOKEN.`);
    }
    if (!config.auth.ig_user_id) {
      log(`  WARNING: No IG user ID configured. Set KONDI_INSTAGRAM_USER_ID.`);
    }
  }

  log(`  Tools: ig_publish_photo, ig_get_media, ig_get_post_insights`);

  // Start appropriate transport
  if (transport === 'stdio') {
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    log(`Ready.${apiHealthy ? '' : ' (degraded — credentials missing or invalid)'}`);
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
        const healthy = await client.healthCheck();
        res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: healthy ? 'healthy' : 'degraded',
            graph_api: healthy ? 'up' : 'down',
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
      log(`Ready.${apiHealthy ? '' : ' (degraded)'}`);
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
