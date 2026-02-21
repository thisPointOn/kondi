#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { SlackClient } from './client.js';
import { registerPostMessageTool } from './tools/post-message.js';
import { registerGetMessagesTool } from './tools/get-messages.js';
import { registerGetThreadTool } from './tools/get-thread.js';
import { registerListChannelsTool } from './tools/list-channels.js';
import { registerAddReactionTool } from './tools/add-reaction.js';
import { registerSearchMessagesTool } from './tools/search-messages.js';
import { registerGetUserInfoTool } from './tools/get-user-info.js';
import { registerListUsersTool } from './tools/list-users.js';
import { registerUpdateMessageTool } from './tools/update-message.js';
import { registerDeleteMessageTool } from './tools/delete-message.js';
import { registerGetChannelInfoTool } from './tools/get-channel-info.js';
import { registerPinMessageTool } from './tools/pin-message.js';
import { registerGetPinsTool } from './tools/get-pins.js';
import { registerRemoveReactionTool } from './tools/remove-reaction.js';
import { registerGetReactionsTool } from './tools/get-reactions.js';

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
kondi-slack-mcp v${VERSION}

MCP server providing Slack Web API tools for messaging, channels, and reactions.

Usage:
  kondi-slack-mcp [options]

Options:
  --transport <type>  Transport mode: stdio (default) or sse
  --port <number>     Port for SSE transport (default: 18208)
  --help, -h          Show this help message

Environment Variables:
  KONDI_SLACK_BOT_TOKEN    Slack bot token (xoxb-...)
  KONDI_SLACK_BASE_URL     Slack API base URL (default: https://slack.com/api)
  KONDI_SLACK_TIMEOUT_MS   Request timeout in ms (default: 10000)
  KONDI_SLACK_TRANSPORT    Transport mode
  KONDI_SLACK_PORT         SSE port
  KONDI_SLACK_LOG_LEVEL    Log level: debug, info, warn, error

Config File:
  ~/.config/kondi-slack/config.json

Tools:
  slack_post_message      Post a message to a channel or thread
  slack_get_messages      Retrieve recent messages from a channel
  slack_get_thread        Retrieve replies in a thread
  slack_list_channels     List channels the bot can access
  slack_add_reaction      Add an emoji reaction to a message
  slack_search_messages   Search for messages across the workspace
  slack_get_user_info     Get detailed profile info for a user
  slack_list_users        List all users in the workspace
  slack_update_message    Update an existing message
  slack_delete_message    Delete a message from a channel
  slack_get_channel_info  Get detailed info about a channel
  slack_pin_message       Pin a message in a channel
  slack_get_pins          Get all pinned items in a channel
  slack_remove_reaction   Remove a reaction from a message
  slack_get_reactions     Get all reactions on a message
`);
      process.exit(0);
    }
  }

  // Create MCP server
  const server = new McpServer({
    name: 'kondi-slack',
    version: VERSION,
  });

  // Create Slack client
  const client = new SlackClient(config.api, config.auth);

  // Register tools
  registerPostMessageTool(server, client);
  registerGetMessagesTool(server, client);
  registerGetThreadTool(server, client);
  registerListChannelsTool(server, client);
  registerAddReactionTool(server, client);
  registerSearchMessagesTool(server, client);
  registerGetUserInfoTool(server, client);
  registerListUsersTool(server, client);
  registerUpdateMessageTool(server, client);
  registerDeleteMessageTool(server, client);
  registerGetChannelInfoTool(server, client);
  registerPinMessageTool(server, client);
  registerGetPinsTool(server, client);
  registerRemoveReactionTool(server, client);
  registerGetReactionsTool(server, client);

  // Log startup info to stderr (stdout is reserved for MCP protocol)
  const log = (msg: string) => {
    if (transport === 'stdio') {
      process.stderr.write(`[kondi-slack] ${msg}\n`);
    } else {
      console.log(`[kondi-slack] ${msg}`);
    }
  };

  log(`Starting kondi-slack-mcp v${VERSION}`);
  log(`  Transport: ${transport}`);

  // Check auth
  if (!client.hasToken()) {
    log(`  Auth: NO TOKEN CONFIGURED`);
    log(`  WARNING: All tools will return auth errors until a bot token is set.`);
    log(`  Set KONDI_SLACK_BOT_TOKEN or add auth.bot_token to ~/.config/kondi-slack/config.json`);
  } else {
    const startTime = Date.now();
    const authOk = await client.authTest();
    const authTime = ((Date.now() - startTime) / 1000).toFixed(2);

    if (authOk) {
      log(`  Auth: ${config.api.base_url} ... valid (${authTime}s)`);
    } else {
      log(`  Auth: ${config.api.base_url} ... INVALID TOKEN`);
      log(`  WARNING: The bot token appears to be invalid. Check KONDI_SLACK_BOT_TOKEN.`);
    }
  }

  log(`  Tools: slack_post_message, slack_get_messages, slack_get_thread, slack_list_channels, slack_add_reaction, slack_search_messages, slack_get_user_info, slack_list_users, slack_update_message, slack_delete_message, slack_get_channel_info, slack_pin_message, slack_get_pins, slack_remove_reaction, slack_get_reactions`);

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
        const hasToken = client.hasToken();
        const authOk = hasToken ? await client.authTest() : false;
        res.writeHead(authOk ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: authOk ? 'healthy' : hasToken ? 'unhealthy' : 'unconfigured',
            auth: authOk ? 'valid' : hasToken ? 'invalid' : 'missing',
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
