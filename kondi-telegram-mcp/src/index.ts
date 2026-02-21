#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { TelegramClient } from './client.js';
import { registerSendMessageTool } from './tools/send-message.js';
import { registerGetUpdatesTool } from './tools/get-updates.js';
import { registerSendPhotoTool } from './tools/send-photo.js';
import { registerGetChatTool } from './tools/get-chat.js';
import { registerGetMeTool } from './tools/get-me.js';

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
kondi-telegram-mcp v${VERSION}

MCP server providing Telegram Bot API tools.

Usage:
  kondi-telegram-mcp [options]

Options:
  --transport <type>  Transport mode: stdio (default) or sse
  --port <number>     Port for SSE transport (default: 18207)
  --help, -h          Show this help message

Environment Variables:
  KONDI_TELEGRAM_BOT_TOKEN   Telegram bot token (required)
  KONDI_TELEGRAM_BASE_URL    API base URL (default: https://api.telegram.org)
  KONDI_TELEGRAM_TIMEOUT_MS  Request timeout in ms (default: 10000)
  KONDI_TELEGRAM_TRANSPORT   Transport mode
  KONDI_TELEGRAM_PORT        SSE port
  KONDI_TELEGRAM_LOG_LEVEL   Log level: debug, info, warn, error

Config File:
  ~/.config/kondi-telegram/config.json

Tools:
  telegram_send_message  Send a text message to a chat
  telegram_get_updates   Receive incoming updates
  telegram_send_photo    Send a photo by URL
  telegram_get_chat      Get chat information
  telegram_get_me        Get bot information
`);
      process.exit(0);
    }
  }

  // Create MCP server
  const server = new McpServer({
    name: 'kondi-telegram',
    version: VERSION,
  });

  // Register tools
  registerSendMessageTool(server, config);
  registerGetUpdatesTool(server, config);
  registerSendPhotoTool(server, config);
  registerGetChatTool(server, config);
  registerGetMeTool(server, config);

  // Log startup info to stderr (stdout is reserved for MCP protocol)
  const log = (msg: string) => {
    if (transport === 'stdio') {
      process.stderr.write(`[kondi-telegram] ${msg}\n`);
    } else {
      console.log(`[kondi-telegram] ${msg}`);
    }
  };

  log(`Starting kondi-telegram-mcp v${VERSION}`);
  log(`  Transport: ${transport}`);

  // Health check — verify bot token
  if (config.auth.bot_token) {
    const client = new TelegramClient(config.api, config.auth);
    const startTime = Date.now();
    const healthy = await client.healthCheck();
    const healthTime = ((Date.now() - startTime) / 1000).toFixed(2);

    if (healthy) {
      log(`  Telegram API: ${config.api.base_url} ... reachable (${healthTime}s)`);
    } else {
      log(`  Telegram API: ${config.api.base_url} ... unreachable or invalid token`);
      log(`  WARNING: Tools will return errors until the bot token is valid.`);
    }
  } else {
    log(`  WARNING: No bot token configured.`);
    log(`  Set KONDI_TELEGRAM_BOT_TOKEN or add auth.bot_token to config.`);
  }

  log(`  Tools: telegram_send_message, telegram_get_updates, telegram_send_photo, telegram_get_chat, telegram_get_me`);

  // Start appropriate transport
  if (transport === 'stdio') {
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    log(`Ready.`);
  } else {
    // SSE transport
    log(`  Port: ${port}`);

    // Dynamic import for SSE transport
    const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
    const http = await import('http');

    const client = new TelegramClient(config.api, config.auth);

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
        const healthy = config.auth.bot_token ? await client.healthCheck() : false;
        res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: healthy ? 'healthy' : 'degraded',
            telegram_api: healthy ? 'up' : 'down',
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
      log(`Ready.`);
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
