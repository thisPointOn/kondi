#!/usr/bin/env node
/**
 * Kondi MCP Proxy
 * Local proxy for remote MCP servers with auth handling
 *
 * Usage: kondi-mcp-proxy --config <path-to-config.json>
 */

import express from 'express';
import * as path from 'path';
import * as os from 'os';
import { setConfigPath, readConfig } from './config.js';
import { setLogFile, setServerName, log, logError } from './logger.js';
import { createControlRouter } from './control.js';
import * as proxy from './proxy.js';
import type { McpMessage } from './types.js';

// Parse command line arguments
function parseArgs(): { configPath: string } {
  const args = process.argv.slice(2);
  let configPath = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
      configPath = args[i + 1];
      i++;
    }
  }

  if (!configPath) {
    console.error('Usage: kondi-mcp-proxy --config <path-to-config.json>');
    process.exit(1);
  }

  // Expand ~ to home directory
  if (configPath.startsWith('~')) {
    configPath = path.join(os.homedir(), configPath.slice(1));
  }

  return { configPath };
}

async function main() {
  const { configPath } = parseArgs();

  // Initialize config
  setConfigPath(configPath);
  const config = readConfig();

  // Set up logging
  const logDir = path.join(os.homedir(), '.local', 'share', 'kondi', 'logs');
  setLogFile(path.join(logDir, `${config.name}.log`));
  setServerName(config.name);

  log('========================================');
  log(`Kondi MCP Proxy starting`);
  log(`Server: ${config.name}`);
  log(`Remote: ${config.remoteUrl}`);
  log(`Local port: ${config.localPort}`);
  log(`Auth method: ${config.authMethod}`);
  log('========================================');

  // Create Express app
  const app = express();
  app.use(express.json());

  // Control endpoints (health, auth, check, reload)
  app.use(createControlRouter());

  // SSE endpoint for MCP clients
  app.get('/sse', (req, res) => {
    const clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Send initial connected event
    res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

    // Register client
    proxy.addSseClient(res, clientId);

    // Handle disconnect
    req.on('close', () => {
      proxy.removeSseClient(clientId);
    });
  });

  // HTTP POST endpoint for MCP messages
  app.post('/mcp', async (req, res) => {
    const message: McpMessage = req.body;

    // Handle initialize requests locally - the proxy is already initialized with the remote
    // This allows multiple local clients to connect without re-initializing the remote
    if (message.method === 'initialize') {
      log(`[Local] Handling initialize request from local client`);
      return res.json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {
            tools: {},
            resources: {},
          },
          serverInfo: {
            name: `${config.name}-proxy`,
            version: '1.0.0',
          },
        },
      });
    }

    // Handle notifications/initialized - acknowledge without forwarding
    if (message.method === 'notifications/initialized') {
      log(`[Local] Acknowledging initialized notification from local client`);
      return res.status(204).send();
    }

    const status = proxy.getStatus();
    if (status === 'needs_auth') {
      return res.json({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32001,
          message: `Authentication required for ${config.name}. Please authenticate in Kondi.`,
          data: { serverId: config.id, reason: 'needs_auth' },
        },
      });
    }

    if (status === 'needs_reauth') {
      return res.json({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32001,
          message: `Re-authentication required for ${config.name}. Token expired or invalid.`,
          data: { serverId: config.id, reason: 'needs_reauth' },
        },
      });
    }

    if (status !== 'connected') {
      return res.json({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32002,
          message: `${config.name} is not connected (status: ${status}).`,
          data: { serverId: config.id, reason: status },
        },
      });
    }

    try {
      const result = await proxy.sendToRemote(config, message);
      res.json({
        jsonrpc: '2.0',
        id: message.id,
        result,
      });
    } catch (err) {
      res.json({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : 'Unknown error',
        },
      });
    }
  });

  // Also support /message endpoint (same as /mcp)
  app.post('/message', async (req, res) => {
    const message: McpMessage = req.body;

    // Handle initialize requests locally - the proxy is already initialized with the remote
    if (message.method === 'initialize') {
      log(`[Local] Handling initialize request from local client (via /message)`);
      return res.json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {
            tools: {},
            resources: {},
          },
          serverInfo: {
            name: `${config.name}-proxy`,
            version: '1.0.0',
          },
        },
      });
    }

    // Handle notifications/initialized - acknowledge without forwarding
    if (message.method === 'notifications/initialized') {
      log(`[Local] Acknowledging initialized notification from local client (via /message)`);
      return res.status(204).send();
    }

    const status = proxy.getStatus();
    if (status === 'needs_auth') {
      return res.json({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32001,
          message: `Authentication required for ${config.name}. Please authenticate in Kondi.`,
          data: { serverId: config.id, reason: 'needs_auth' },
        },
      });
    }

    if (status === 'needs_reauth') {
      return res.json({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32001,
          message: `Re-authentication required for ${config.name}. Token expired or invalid.`,
          data: { serverId: config.id, reason: 'needs_reauth' },
        },
      });
    }

    if (status !== 'connected') {
      return res.json({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32002,
          message: `${config.name} is not connected (status: ${status}).`,
          data: { serverId: config.id, reason: status },
        },
      });
    }

    try {
      const result = await proxy.sendToRemote(config, message);
      res.json({
        jsonrpc: '2.0',
        id: message.id,
        result,
      });
    } catch (err) {
      res.json({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : 'Unknown error',
        },
      });
    }
  });

  // Start server
  const server = app.listen(config.localPort, '127.0.0.1', () => {
    log(`Local proxy listening on http://127.0.0.1:${config.localPort}`);
    log(`  SSE endpoint: http://127.0.0.1:${config.localPort}/sse`);
    log(`  MCP endpoint: http://127.0.0.1:${config.localPort}/mcp`);
    log(`  Health:       http://127.0.0.1:${config.localPort}/health`);
  });

  // Check credentials and connect
  const credStatus = proxy.checkCredentials(config);
  log(`Initial credential status: ${credStatus}`);

  if (credStatus === 'needs_auth') {
    proxy.setStatus('needs_auth');
    log('No credentials - waiting for authentication');
  } else if (credStatus === 'needs_reauth') {
    proxy.setStatus('needs_reauth');
    log('Credentials expired - waiting for re-authentication');
  } else {
    // Try to connect
    await proxy.connect(config);

    // Start background refresh timer if OAuth
    if (config.authMethod === 'oauth') {
      proxy.startRefreshTimer(config);
    }
  }

  // Handle shutdown
  process.on('SIGTERM', () => {
    log('Received SIGTERM, shutting down...');
    proxy.disconnect();
    server.close(() => {
      log('Server closed');
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    log('Received SIGINT, shutting down...');
    proxy.disconnect();
    server.close(() => {
      log('Server closed');
      process.exit(0);
    });
  });
}

main().catch((err) => {
  logError('Fatal error', err instanceof Error ? err : undefined);
  process.exit(1);
});
