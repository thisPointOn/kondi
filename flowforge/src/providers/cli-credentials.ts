/**
 * FlowForge CLI Credentials Reader
 * Reads OAuth credentials from various CLI tools (Codex, Claude, Gemini, etc.)
 * Based on OpenClaw's cli-credentials.ts patterns
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================================
// Types
// ============================================================================

export interface OAuthCredential {
  type: 'oauth';
  provider: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
}

export interface TokenCredential {
  type: 'token';
  provider: string;
  token: string;
  expiresAt?: number;
}

export type CLICredential = OAuthCredential | TokenCredential;

// ============================================================================
// Path Resolution
// ============================================================================

function resolveHomePath(relativePath: string): string {
  const home = os.homedir();
  return path.join(home, relativePath);
}

function resolveCodexHomePath(): string {
  const configured = process.env.CODEX_HOME;
  const home = configured || resolveHomePath('.codex');
  try {
    return fs.realpathSync(home);
  } catch {
    return home;
  }
}

// ============================================================================
// Codex CLI (OpenAI OAuth)
// ============================================================================

function computeCodexKeychainAccount(codexHome: string): string {
  const hash = createHash('sha256').update(codexHome).digest('hex');
  return `cli|${hash.slice(0, 16)}`;
}

/**
 * Read OpenAI OAuth credentials from Codex CLI
 * - macOS: Reads from Keychain
 * - Other platforms: Reads from ~/.codex/auth.json
 */
export function readCodexCredentials(): OAuthCredential | null {
  // Try Keychain first on macOS
  if (process.platform === 'darwin') {
    const keychainCreds = readCodexKeychainCredentials();
    if (keychainCreds) return keychainCreds;
  }

  // Fall back to file
  return readCodexFileCredentials();
}

function readCodexKeychainCredentials(): OAuthCredential | null {
  if (process.platform !== 'darwin') return null;

  const codexHome = resolveCodexHomePath();
  const account = computeCodexKeychainAccount(codexHome);

  try {
    const secret = execSync(
      `security find-generic-password -s "Codex Auth" -a "${account}" -w`,
      {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    ).trim();

    const parsed = JSON.parse(secret);
    const tokens = parsed.tokens;
    const accessToken = tokens?.access_token;
    const refreshToken = tokens?.refresh_token;

    if (!accessToken || !refreshToken) return null;

    // Estimate expiry (1 hour from last refresh or now)
    const lastRefresh = parsed.last_refresh
      ? new Date(parsed.last_refresh).getTime()
      : Date.now();
    const expiresAt = lastRefresh + 60 * 60 * 1000;

    return {
      type: 'oauth',
      provider: 'openai-codex',
      accessToken,
      refreshToken,
      expiresAt,
      accountId: tokens?.account_id,
    };
  } catch {
    return null;
  }
}

function readCodexFileCredentials(): OAuthCredential | null {
  const authPath = path.join(resolveCodexHomePath(), 'auth.json');

  try {
    const content = fs.readFileSync(authPath, 'utf8');
    const parsed = JSON.parse(content);
    const tokens = parsed.tokens;

    if (!tokens?.access_token || !tokens?.refresh_token) return null;

    const expiresAt = parsed.expires_at
      ? new Date(parsed.expires_at).getTime()
      : Date.now() + 60 * 60 * 1000;

    return {
      type: 'oauth',
      provider: 'openai-codex',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      accountId: tokens?.account_id,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Claude CLI (Anthropic OAuth)
// ============================================================================

/**
 * Read Anthropic OAuth credentials from Claude CLI
 * Location: ~/.claude/.credentials.json or macOS Keychain
 */
export function readClaudeCredentials(): CLICredential | null {
  // Try Keychain first on macOS
  if (process.platform === 'darwin') {
    const keychainCreds = readClaudeKeychainCredentials();
    if (keychainCreds) return keychainCreds;
  }

  // Fall back to file
  return readClaudeFileCredentials();
}

function readClaudeKeychainCredentials(): CLICredential | null {
  if (process.platform !== 'darwin') return null;

  try {
    const secret = execSync(
      `security find-generic-password -s "Claude Code-credentials" -a "Claude Code" -w`,
      {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    ).trim();

    const parsed = JSON.parse(secret);

    if (parsed.claudeAiOauth) {
      return {
        type: 'oauth',
        provider: 'anthropic',
        accessToken: parsed.claudeAiOauth.accessToken,
        refreshToken: parsed.claudeAiOauth.refreshToken,
        expiresAt: new Date(parsed.claudeAiOauth.expiresAt).getTime(),
      };
    }

    if (parsed.apiKey) {
      return {
        type: 'token',
        provider: 'anthropic',
        token: parsed.apiKey,
      };
    }

    return null;
  } catch {
    return null;
  }
}

function readClaudeFileCredentials(): CLICredential | null {
  const credPath = resolveHomePath('.claude/.credentials.json');

  try {
    const content = fs.readFileSync(credPath, 'utf8');
    const parsed = JSON.parse(content);

    if (parsed.claudeAiOauth) {
      return {
        type: 'oauth',
        provider: 'anthropic',
        accessToken: parsed.claudeAiOauth.accessToken,
        refreshToken: parsed.claudeAiOauth.refreshToken,
        expiresAt: new Date(parsed.claudeAiOauth.expiresAt).getTime(),
      };
    }

    if (parsed.apiKey) {
      return {
        type: 'token',
        provider: 'anthropic',
        token: parsed.apiKey,
      };
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Gemini CLI (Google OAuth)
// ============================================================================

/**
 * Read Google OAuth credentials from Gemini CLI
 * Location: ~/.gemini/oauth_creds.json
 */
export function readGeminiCredentials(): OAuthCredential | null {
  const credPath = resolveHomePath('.gemini/oauth_creds.json');

  try {
    const content = fs.readFileSync(credPath, 'utf8');
    const parsed = JSON.parse(content);

    if (!parsed.access_token || !parsed.refresh_token) return null;

    const expiresAt = parsed.expires_at
      ? parsed.expires_at * 1000 // Convert seconds to ms
      : Date.now() + 60 * 60 * 1000;

    return {
      type: 'oauth',
      provider: 'gemini',
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresAt,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Qwen CLI (Alibaba OAuth)
// ============================================================================

/**
 * Read Qwen OAuth credentials from Qwen CLI
 * Location: ~/.qwen/oauth_creds.json
 */
export function readQwenCredentials(): OAuthCredential | null {
  const credPath = resolveHomePath('.qwen/oauth_creds.json');

  try {
    const content = fs.readFileSync(credPath, 'utf8');
    const parsed = JSON.parse(content);

    if (!parsed.access_token || !parsed.refresh_token) return null;

    const expiresAt = parsed.expires_at
      ? new Date(parsed.expires_at).getTime()
      : Date.now() + 60 * 60 * 1000;

    return {
      type: 'oauth',
      provider: 'qwen',
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresAt,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// MiniMax CLI (OAuth)
// ============================================================================

/**
 * Read MiniMax OAuth credentials
 * Location: ~/.minimax/oauth_creds.json
 */
export function readMiniMaxCredentials(): OAuthCredential | null {
  const credPath = resolveHomePath('.minimax/oauth_creds.json');

  try {
    const content = fs.readFileSync(credPath, 'utf8');
    const parsed = JSON.parse(content);

    if (!parsed.access_token || !parsed.refresh_token) return null;

    const expiresAt = parsed.expires_at
      ? new Date(parsed.expires_at).getTime()
      : Date.now() + 60 * 60 * 1000;

    return {
      type: 'oauth',
      provider: 'minimax',
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresAt,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Unified Reader
// ============================================================================

export interface AllCLICredentials {
  codex: OAuthCredential | null;
  claude: CLICredential | null;
  gemini: OAuthCredential | null;
  qwen: OAuthCredential | null;
  minimax: OAuthCredential | null;
}

/**
 * Read all available CLI credentials
 */
export function readAllCLICredentials(): AllCLICredentials {
  return {
    codex: readCodexCredentials(),
    claude: readClaudeCredentials(),
    gemini: readGeminiCredentials(),
    qwen: readQwenCredentials(),
    minimax: readMiniMaxCredentials(),
  };
}

/**
 * Check which CLI tools have valid credentials
 */
export function getAvailableCLIProviders(): string[] {
  const creds = readAllCLICredentials();
  const available: string[] = [];

  if (creds.codex) available.push('openai-codex');
  if (creds.claude) available.push('anthropic');
  if (creds.gemini) available.push('gemini');
  if (creds.qwen) available.push('qwen');
  if (creds.minimax) available.push('minimax');

  return available;
}
