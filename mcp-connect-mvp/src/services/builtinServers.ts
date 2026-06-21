/**
 * Built-in Social MCP Servers
 *
 * Registers the bundled social-platform MCP servers so they appear in the
 * "Built-in" section of the Tools panel.  They start disconnected — the user
 * must supply an API token (via env var or config file) and click Connect.
 */

import type { MCPServer } from '../types/mcp';
import type { MCPClient } from './mcpClient';
import { kondiPathSync } from './kondiPaths';

// ── helpers ────────────────────────────────────────────────────────────────

declare const __PROJECT_ROOT__: string;

function basePath(pkg: string): string {
  if (import.meta.env.DEV) {
    return `${__PROJECT_ROOT__}/${pkg}`;
  }
  return kondiPathSync('mcp-servers', pkg);
}

// ── server definitions ─────────────────────────────────────────────────────

interface BuiltinDef {
  id: string;
  name: string;
  pkg: string;
  description: string;
  /** Credential / config env vars the server needs (key → default value). */
  env: Record<string, string>;
  icon: string;
}

const BUILTIN_DEFS: BuiltinDef[] = [
  {
    id: 'kondi-x',
    name: 'X / Twitter',
    pkg: 'kondi-x-mcp',
    description: 'Post tweets, search, and manage your X account',
    env: {
      KONDI_X_BEARER_TOKEN: '',
      KONDI_X_CONSUMER_KEY: '',
      KONDI_X_CONSUMER_SECRET: '',
      KONDI_X_ACCESS_TOKEN: '',
      KONDI_X_ACCESS_TOKEN_SECRET: '',
    },
    icon: '🐦',
  },
  {
    id: 'kondi-discord',
    name: 'Discord',
    pkg: 'kondi-discord-mcp',
    description: 'Send messages, read channels, and manage reactions',
    env: { KONDI_DISCORD_BOT_TOKEN: '' },
    icon: '💬',
  },
  {
    id: 'kondi-linkedin',
    name: 'LinkedIn',
    pkg: 'kondi-linkedin-mcp',
    description: 'Create posts and view your professional profile',
    env: {
      KONDI_LINKEDIN_ACCESS_TOKEN: '',
      KONDI_LINKEDIN_PERSON_ID: '',
    },
    icon: '💼',
  },
  {
    id: 'kondi-facebook',
    name: 'Facebook',
    pkg: 'kondi-facebook-mcp',
    description: 'Manage page posts and content',
    env: {
      KONDI_FACEBOOK_PAGE_ACCESS_TOKEN: '',
      KONDI_FACEBOOK_PAGE_ID: '',
    },
    icon: '📘',
  },
  {
    id: 'kondi-instagram',
    name: 'Instagram',
    pkg: 'kondi-instagram-mcp',
    description: 'Publish photos and view post insights',
    env: {
      KONDI_INSTAGRAM_ACCESS_TOKEN: '',
      KONDI_INSTAGRAM_USER_ID: '',
    },
    icon: '📷',
  },
  {
    id: 'kondi-reddit',
    name: 'Reddit',
    pkg: 'kondi-reddit-mcp',
    description: 'Submit posts, read subreddits, and comment',
    env: {
      KONDI_REDDIT_CLIENT_ID: '',
      KONDI_REDDIT_CLIENT_SECRET: '',
      KONDI_REDDIT_USERNAME: '',
      KONDI_REDDIT_PASSWORD: '',
    },
    icon: '🤖',
  },
  {
    id: 'kondi-telegram',
    name: 'Telegram',
    pkg: 'kondi-telegram-mcp',
    description: 'Send messages, photos, and manage chats',
    env: { KONDI_TELEGRAM_BOT_TOKEN: '' },
    icon: '✈️',
  },
  {
    id: 'kondi-slack',
    name: 'Slack',
    pkg: 'kondi-slack-mcp',
    description: 'Post messages, list channels, and add reactions',
    env: { KONDI_SLACK_BOT_TOKEN: '' },
    icon: '📨',
  },
  {
    id: 'kondi-git',
    name: 'Git',
    pkg: 'kondi-git-mcp',
    description: 'View status, log, diff, commit, push, branch, and more',
    env: { KONDI_GIT_WORKING_DIR: '' },
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
          env: { ...def.env },
        },
      },
    },
  };
}

/**
 * Register all built-in social MCP servers with the client.
 * For already-registered servers, merges any new env var keys from the
 * current definition (preserving user-entered values) so that credential
 * fields added in later versions always appear in the UI.
 */
export function registerBuiltinServers(mcpClient: MCPClient): void {
  const existingMap = new Map(mcpClient.getAllServers().map(s => [s.id, s]));

  for (const def of BUILTIN_DEFS) {
    const existing = existingMap.get(def.id);

    if (existing) {
      const existingEnv: Record<string, string> = existing.metadata?.manifest?.run?.env || {};
      const hasNewKeys = Object.keys(def.env).some(k => !(k in existingEnv));

      if (hasNewKeys) {
        // Merge: new keys from def (empty string) + existing values take precedence
        const mergedEnv = { ...def.env, ...existingEnv };
        mcpClient.updateServer({
          ...existing,
          metadata: {
            ...existing.metadata,
            manifest: {
              ...existing.metadata?.manifest,
              run: {
                ...existing.metadata?.manifest?.run,
                env: mergedEnv,
              },
            },
          },
        });
        console.log(`[builtinServers] Merged new env vars into ${def.id}`);
      } else {
        console.log(`[builtinServers] ${def.id} already registered, skipping`);
      }
      continue;
    }

    const config = toServerConfig(def);
    mcpClient.addServer(config);
    console.log(`[builtinServers] Registered ${def.id}`);
  }
}
