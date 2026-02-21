#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { DiscordClient } from './client.js';
import { registerSendMessageTool } from './tools/send-message.js';
import { registerGetMessagesTool } from './tools/get-messages.js';
import { registerGetChannelTool } from './tools/get-channel.js';
import { registerListGuildChannelsTool } from './tools/list-guild-channels.js';
import { registerCreateReactionTool } from './tools/create-reaction.js';
import { registerEditMessageTool } from './tools/edit-message.js';
import { registerDeleteMessageTool } from './tools/delete-message.js';
import { registerGetGuildTool } from './tools/get-guild.js';
import { registerPinMessageTool } from './tools/pin-message.js';
import { registerGetPinnedMessagesTool } from './tools/get-pinned-messages.js';
import { registerCreateThreadTool } from './tools/create-thread.js';
import { registerGetGuildMembersTool } from './tools/get-guild-members.js';
import { registerRemoveReactionTool } from './tools/remove-reaction.js';

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
kondi-discord-mcp v${VERSION}

MCP server providing Discord API tools for messaging, channels, and reactions.

Usage:
  kondi-discord-mcp [options]

Options:
  --transport <type>  Transport mode: stdio (default) or sse
  --port <number>     Port for SSE transport (default: 18202)
  --help, -h          Show this help message

Environment Variables:
  KONDI_DISCORD_BOT_TOKEN   Discord bot token (required)
  KONDI_DISCORD_BASE_URL    Discord API base URL (default: https://discord.com/api/v10)
  KONDI_DISCORD_TIMEOUT_MS  Request timeout in milliseconds (default: 10000)
  KONDI_DISCORD_TRANSPORT   Transport mode
  KONDI_DISCORD_PORT        SSE port
  KONDI_DISCORD_LOG_LEVEL   Log level: debug, info, warn, error

Config File:
  ~/.config/kondi-discord/config.json

Tools:
  discord_send_message        Send a message to a channel
  discord_get_messages        Retrieve messages from a channel
  discord_get_channel         Get channel information
  discord_list_guild_channels List channels in a guild
  discord_create_reaction     Add a reaction to a message
  discord_edit_message        Edit a previously sent message
  discord_delete_message      Delete a message from a channel
  discord_get_guild           Get guild (server) information
  discord_pin_message         Pin a message in a channel
  discord_get_pinned_messages Get all pinned messages in a channel
  discord_create_thread       Create a thread from a message
  discord_get_guild_members   List members of a guild
  discord_remove_reaction     Remove bot's reaction from a message
`);
      process.exit(0);
    }
  }

  // Create MCP server
  const server = new McpServer({
    name: 'kondi-discord',
    version: VERSION,
  });

  // Register tools
  registerSendMessageTool(server, config);
  registerGetMessagesTool(server, config);
  registerGetChannelTool(server, config);
  registerListGuildChannelsTool(server, config);
  registerCreateReactionTool(server, config);
  registerEditMessageTool(server, config);
  registerDeleteMessageTool(server, config);
  registerGetGuildTool(server, config);
  registerPinMessageTool(server, config);
  registerGetPinnedMessagesTool(server, config);
  registerCreateThreadTool(server, config);
  registerGetGuildMembersTool(server, config);
  registerRemoveReactionTool(server, config);

  // Log startup info to stderr (stdout is reserved for MCP protocol)
  const log = (msg: string) => {
    if (transport === 'stdio') {
      process.stderr.write(`[kondi-discord] ${msg}\n`);
    } else {
      console.log(`[kondi-discord] ${msg}`);
    }
  };

  log(`Starting kondi-discord-mcp v${VERSION}`);
  log(`  Transport: ${transport}`);

  // Check bot token and Discord API connectivity
  const client = new DiscordClient(config);
  if (!client.hasToken()) {
    log(`  Bot Token: NOT SET`);
    log(`  WARNING: No bot token configured. All tools will return errors.`);
    log(`  Set KONDI_DISCORD_BOT_TOKEN or add auth.bot_token to ~/.config/kondi-discord/config.json`);
  } else {
    log(`  Bot Token: configured`);
    const startTime = Date.now();
    const healthy = await client.healthCheck();
    const healthTime = ((Date.now() - startTime) / 1000).toFixed(2);

    if (healthy) {
      log(`  Discord API: ${config.api.base_url} ... reachable (${healthTime}s)`);
    } else {
      log(`  Discord API: ${config.api.base_url} ... unreachable or token invalid`);
      log(`  WARNING: Tools will return errors until the API is reachable with a valid token.`);
    }
  }

  log(`  Tools: discord_send_message, discord_get_messages, discord_get_channel, discord_list_guild_channels, discord_create_reaction, discord_edit_message, discord_delete_message, discord_get_guild, discord_pin_message, discord_get_pinned_messages, discord_create_thread, discord_get_guild_members, discord_remove_reaction`);

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
        const healthy = client.hasToken() ? await client.healthCheck() : false;
        res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: healthy ? 'healthy' : 'degraded',
            token_configured: client.hasToken(),
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
