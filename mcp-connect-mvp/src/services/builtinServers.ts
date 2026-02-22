/**
 * Built-in Social MCP Servers
 *
 * Registers the bundled social-platform MCP servers so they appear in the
 * "Built-in" section of the Tools panel.  They start disconnected — the user
 * must supply an API token (via env var or config file) and click Connect.
 */

import type { MCPServer } from '../types/mcp';
import type { MCPClient } from './mcpClient';

// ── helpers ────────────────────────────────────────────────────────────────

declare const __PROJECT_ROOT__: string;

function basePath(pkg: string): string {
  if (import.meta.env.DEV) {
    return `${__PROJECT_ROOT__}/${pkg}`;
  }
  return `~/.local/share/kondi/mcp-servers/${pkg}`;
}

// ── server definitions ─────────────────────────────────────────────────────

interface BuiltinDef {
  id: string;
  name: string;
  pkg: string;
  description: string;
  envKey: string;
  icon: string;
}

const BUILTIN_DEFS: BuiltinDef[] = [
  {
    id: 'kondi-x',
    name: 'X / Twitter',
    pkg: 'kondi-x-mcp',
    description: 'Post tweets, search, and manage your X account',
    envKey: 'KONDI_X_BEARER_TOKEN',
    icon: '🐦',
  },
  {
    id: 'kondi-discord',
    name: 'Discord',
    pkg: 'kondi-discord-mcp',
    description: 'Send messages, read channels, and manage reactions',
    envKey: 'KONDI_DISCORD_BOT_TOKEN',
    icon: '💬',
  },
  {
    id: 'kondi-linkedin',
    name: 'LinkedIn',
    pkg: 'kondi-linkedin-mcp',
    description: 'Create posts and view your professional profile',
    envKey: 'KONDI_LINKEDIN_ACCESS_TOKEN',
    icon: '💼',
  },
  {
    id: 'kondi-facebook',
    name: 'Facebook',
    pkg: 'kondi-facebook-mcp',
    description: 'Manage page posts and content',
    envKey: 'KONDI_FACEBOOK_PAGE_ACCESS_TOKEN',
    icon: '📘',
  },
  {
    id: 'kondi-instagram',
    name: 'Instagram',
    pkg: 'kondi-instagram-mcp',
    description: 'Publish photos and view post insights',
    envKey: 'KONDI_INSTAGRAM_ACCESS_TOKEN',
    icon: '📷',
  },
  {
    id: 'kondi-reddit',
    name: 'Reddit',
    pkg: 'kondi-reddit-mcp',
    description: 'Submit posts, read subreddits, and comment',
    envKey: 'KONDI_REDDIT_ACCESS_TOKEN',
    icon: '🤖',
  },
  {
    id: 'kondi-telegram',
    name: 'Telegram',
    pkg: 'kondi-telegram-mcp',
    description: 'Send messages, photos, and manage chats',
    envKey: 'KONDI_TELEGRAM_BOT_TOKEN',
    icon: '✈️',
  },
  {
    id: 'kondi-slack',
    name: 'Slack',
    pkg: 'kondi-slack-mcp',
    description: 'Post messages, list channels, and add reactions',
    envKey: 'KONDI_SLACK_BOT_TOKEN',
    icon: '📨',
  },
  {
    id: 'kondi-git',
    name: 'Git',
    pkg: 'kondi-git-mcp',
    description: 'View status, log, diff, commit, push, branch, and more',
    envKey: 'KONDI_GIT_WORKING_DIR',
    icon: '🔀',
  },
];

// ── public API ─────────────────────────────────────────────────────────────

function toServerConfig(def: BuiltinDef): MCPServer {
  const serverPath = basePath(def.pkg);
  return {
    id: def.id,
    name: def.name,
    url: 'stdio',
    transport: 'stdio',
    status: 'disconnected',
    type: 'github_mcp_local',
    icon: def.icon,
    metadata: {
      serverPath,
      managed: true,
      builtin: true,
      manifest: {
        name: def.pkg,
        version: '1.0.0',
        description: def.description,
        runtime: 'node',
        entrypoint: 'dist/index.js',
        run: {
          command: 'node',
          args: ['dist/index.js'],
          env: { [def.envKey]: '' },
        },
      },
    },
  };
}

/**
 * Register all built-in social MCP servers with the client.
 * Skips any that are already registered (e.g. restored from localStorage).
 */
export function registerBuiltinServers(mcpClient: MCPClient): void {
  const existing = new Set(mcpClient.getAllServers().map(s => s.id));

  for (const def of BUILTIN_DEFS) {
    if (existing.has(def.id)) {
      console.log(`[builtinServers] ${def.id} already registered, skipping`);
      continue;
    }
    const config = toServerConfig(def);
    mcpClient.addServer(config);
    console.log(`[builtinServers] Registered ${def.id}`);
  }
}
