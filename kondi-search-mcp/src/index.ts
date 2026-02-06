#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { registerSearchTool } from './tools/web-search.js';
import { registerFetchTool } from './tools/web-fetch.js';
import { SearxngClient } from './searxng/client.js';

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
kondi-search-mcp v${VERSION}

MCP server providing web search and fetch tools via local SearXNG.

Usage:
  kondi-search-mcp [options]

Options:
  --transport <type>  Transport mode: stdio (default) or sse
  --port <number>     Port for SSE transport (default: 18100)
  --help, -h          Show this help message

Environment Variables:
  KONDI_SEARCH_SEARXNG_URL   SearXNG URL (default: http://localhost:8888)
  KONDI_SEARCH_TRANSPORT     Transport mode
  KONDI_SEARCH_PORT          SSE port
  KONDI_SEARCH_LOG_LEVEL     Log level: debug, info, warn, error

Config File:
  ~/.config/kondi-search/config.json

Tools:
  web_search  Search the web via SearXNG
  web_fetch   Fetch and extract content from web pages
`);
      process.exit(0);
    }
  }

  // Create MCP server
  const server = new McpServer({
    name: 'kondi-search',
    version: VERSION,
  });

  // Register tools
  registerSearchTool(server, config);
  registerFetchTool(server, config);

  // Log startup info to stderr (stdout is reserved for MCP protocol)
  const log = (msg: string) => {
    if (transport === 'stdio') {
      process.stderr.write(`[kondi-search] ${msg}\n`);
    } else {
      console.log(`[kondi-search] ${msg}`);
    }
  };

  log(`Starting kondi-search-mcp v${VERSION}`);
  log(`  Transport: ${transport}`);

  // Health check SearXNG
  const searxng = new SearxngClient(config.searxng);
  const startTime = Date.now();
  const searxngHealthy = await searxng.healthCheck();
  const healthTime = ((Date.now() - startTime) / 1000).toFixed(2);

  if (searxngHealthy) {
    log(`  SearXNG: ${config.searxng.url} ... ✓ reachable (${healthTime}s)`);
  } else {
    log(`  SearXNG: ${config.searxng.url} ... ✗ unreachable`);
    log(`  WARNING: web_search will return errors until SearXNG is available.`);
    log(`  web_fetch is available independently.`);
  }

  log(`  Tools: web_search, web_fetch`);

  // Start appropriate transport
  if (transport === 'stdio') {
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    log(`Ready.${searxngHealthy ? '' : ' (degraded)'}`);
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
        const healthy = await searxng.healthCheck();
        res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: healthy ? 'healthy' : 'degraded',
            searxng: healthy ? 'up' : 'down',
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
      log(`Ready.${searxngHealthy ? '' : ' (degraded)'}`);
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
