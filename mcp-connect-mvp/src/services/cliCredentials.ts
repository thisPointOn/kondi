/**
 * CLI Credentials Service
 * Checks for OAuth credentials from various CLI tools
 * Works with Tauri to read local files
 */

import { invoke } from '@tauri-apps/api/core';

export interface CLICredentialStatus {
  provider: string;
  available: boolean;
  expiresAt?: number;
  error?: string;
}

export interface AllCLICredentials {
  codex: CLICredentialStatus;
  claude: CLICredentialStatus;
  gemini: CLICredentialStatus;
  qwen: CLICredentialStatus;
  minimax: CLICredentialStatus;
}

/**
 * Check if CLI credentials are available for all supported providers
 * This calls into Tauri to read local credential files
 */
export async function checkAllCLICredentials(): Promise<AllCLICredentials> {
  const results: AllCLICredentials = {
    codex: { provider: 'openai-codex', available: false },
    claude: { provider: 'anthropic', available: false },
    gemini: { provider: 'gemini', available: false },
    qwen: { provider: 'qwen', available: false },
    minimax: { provider: 'minimax', available: false },
  };

  try {
    // Try to invoke Tauri command to check credentials
    const creds = await invoke<{
      codex?: { available: boolean; expires_at?: number };
      claude?: { available: boolean; expires_at?: number };
      gemini?: { available: boolean; expires_at?: number };
      qwen?: { available: boolean; expires_at?: number };
      minimax?: { available: boolean; expires_at?: number };
    }>('check_cli_credentials');

    if (creds.codex) {
      results.codex = {
        provider: 'openai-codex',
        available: creds.codex.available,
        expiresAt: creds.codex.expires_at,
      };
    }
    if (creds.claude) {
      results.claude = {
        provider: 'anthropic',
        available: creds.claude.available,
        expiresAt: creds.claude.expires_at,
      };
    }
    if (creds.gemini) {
      results.gemini = {
        provider: 'gemini',
        available: creds.gemini.available,
        expiresAt: creds.gemini.expires_at,
      };
    }
    if (creds.qwen) {
      results.qwen = {
        provider: 'qwen',
        available: creds.qwen.available,
        expiresAt: creds.qwen.expires_at,
      };
    }
    if (creds.minimax) {
      results.minimax = {
        provider: 'minimax',
        available: creds.minimax.available,
        expiresAt: creds.minimax.expires_at,
      };
    }
  } catch (err) {
    console.warn('[cliCredentials] Failed to check CLI credentials:', err);
    // Return defaults with error info
    const errorMsg = err instanceof Error ? err.message : 'Tauri not available';
    results.codex.error = errorMsg;
    results.claude.error = errorMsg;
    results.gemini.error = errorMsg;
    results.qwen.error = errorMsg;
    results.minimax.error = errorMsg;
  }

  return results;
}

/**
 * Get OAuth token for a specific provider from CLI credentials
 */
export async function getCLIToken(cliTool: string): Promise<string | null> {
  try {
    const token = await invoke<string | null>('get_cli_token', { cliTool });
    return token;
  } catch (err) {
    console.warn(`[cliCredentials] Failed to get token for ${cliTool}:`, err);
    return null;
  }
}

/**
 * Map CLI tool names to provider IDs
 */
export const CLI_TOOL_TO_PROVIDER: Record<string, string> = {
  codex: 'openai',
  claude: 'anthropic',
  gemini: 'gemini',
  qwen: 'qwen',
  minimax: 'minimax',
};

/**
 * Map provider IDs to CLI tool names
 */
export const PROVIDER_TO_CLI_TOOL: Record<string, string> = {
  openai: 'codex',
  'openai-oauth': 'codex',
  anthropic: 'claude',
  gemini: 'gemini',
  qwen: 'qwen',
  minimax: 'minimax',
};

/**
 * Log in to Codex CLI using automated OAuth flow
 * This runs the OpenAI OAuth flow and writes tokens to ~/.codex/auth.json
 */
export async function loginCodexCli(): Promise<string> {
  try {
    const result = await invoke<string>('login_codex_cli');
    return result;
  } catch (err) {
    console.error('[cliCredentials] Failed to log in to Codex CLI:', err);
    throw err;
  }
}

/**
 * Check if Codex CLI is logged in (has valid tokens)
 */
export async function isCodexLoggedIn(): Promise<boolean> {
  try {
    return await invoke<boolean>('is_codex_logged_in');
  } catch (err) {
    console.warn('[cliCredentials] Failed to check Codex login status:', err);
    return false;
  }
}
