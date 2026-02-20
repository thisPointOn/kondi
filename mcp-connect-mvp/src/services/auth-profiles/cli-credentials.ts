/**
 * CLI Credential Reading
 * Read tokens from Claude CLI's credential files via Tauri command
 */

import { invoke } from '@tauri-apps/api/core';
import type { AuthProfile } from './types';
import { PROFILE_IDS } from './constants';
import { upsertProfile } from './profiles';

interface ClaudeCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/**
 * Read Claude CLI credentials from ~/.claude/.credentials.json
 * Returns the profile if successful, null if credentials not found
 */
export async function importCliCredentials(): Promise<AuthProfile | null> {
  try {
    const creds = await invoke<ClaudeCredentials>('read_claude_credentials');

    if (!creds.accessToken) {
      console.log('[CliCredentials] No access token found in CLI credentials');
      return null;
    }

    const profile = upsertProfile(
      PROFILE_IDS.anthropicCli,
      'anthropic',
      {
        type: 'oauth',
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken || '',
        expiresAt: creds.expiresAt || 0,
      },
      'CLI Import',
    );

    console.log('[CliCredentials] Imported Claude CLI credentials');
    return profile;
  } catch (err) {
    // Not an error — CLI credentials may not exist
    console.log('[CliCredentials] Could not read CLI credentials:', err);
    return null;
  }
}
