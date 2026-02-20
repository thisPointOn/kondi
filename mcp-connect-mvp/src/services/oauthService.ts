import { invoke } from '@tauri-apps/api/core';
import {
  upsertProfile,
  deleteProfile,
  getProfile,
  resolveApiKey,
  PROFILE_IDS,
  REFRESH_BUFFER_MS,
} from './auth-profiles';
import type { OAuthCredential, GeminiOAuthCredential } from './auth-profiles';

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp in milliseconds
  token_type: string;
  provider: 'anthropic' | 'openai' | 'google';
}

export interface GeminiOAuthResult {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  project_id: string;
  email?: string;
}

export interface OAuthSession {
  auth_url: string;
  code_verifier: string;
  state: string;
}

class OAuthService {
  /**
   * Start Anthropic OAuth flow (step 1)
   * Opens browser for user to authenticate with Claude account
   */
  async startAnthropicOAuth(): Promise<OAuthSession> {
    console.log('[OAuth] Starting Anthropic OAuth flow...');
    const session = await invoke<OAuthSession>('start_anthropic_oauth');
    console.log('[OAuth] Anthropic OAuth session started, waiting for code...');
    return session;
  }

  /**
   * Complete Anthropic OAuth flow (step 2)
   * Exchange the auth code for tokens
   */
  async completeAnthropicOAuth(code: string, codeVerifier: string, state: string): Promise<OAuthTokens> {
    console.log('[OAuth] Exchanging Anthropic auth code for tokens...');

    try {
      const tokens = await invoke<OAuthTokens>('exchange_anthropic_code', {
        code,
        codeVerifier,
        state,
      });

      // Store in auth profile system
      upsertProfile(
        PROFILE_IDS.anthropicOAuth,
        'anthropic',
        {
          type: 'oauth',
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: tokens.expires_at,
        },
        'OAuth (browser)',
      );

      console.log('[OAuth] Anthropic connected successfully');
      return tokens;
    } catch (err) {
      console.error('[OAuth] Anthropic OAuth failed:', err);
      throw err;
    }
  }

  /**
   * Start Anthropic OAuth flow with code prompt
   * Opens browser, prompts user for code, and completes the flow
   */
  async connectAnthropic(getCode: () => Promise<string | null>): Promise<OAuthTokens> {
    const session = await this.startAnthropicOAuth();
    const code = await getCode();
    if (!code) {
      throw new Error('OAuth cancelled - no code provided');
    }
    return this.completeAnthropicOAuth(code, session.code_verifier, session.state);
  }

  /**
   * Start OpenAI OAuth flow
   */
  async connectOpenAI(): Promise<OAuthTokens> {
    console.log('[OAuth] Starting OpenAI OAuth flow...');

    try {
      const tokens = await invoke<OAuthTokens>('start_openai_oauth');

      // Store in auth profile system
      upsertProfile(
        PROFILE_IDS.openaiOAuth,
        'openai',
        {
          type: 'oauth',
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: tokens.expires_at,
        },
        'OAuth (browser)',
      );

      console.log('[OAuth] OpenAI connected successfully');
      return tokens;
    } catch (err) {
      console.error('[OAuth] OpenAI OAuth failed:', err);
      throw err;
    }
  }

  /**
   * Start Gemini OAuth flow
   * Opens browser for Google OAuth, provisions Cloud Code Assist project
   */
  async connectGemini(): Promise<GeminiOAuthResult> {
    console.log('[OAuth] Starting Gemini OAuth flow...');

    try {
      const result = await invoke<GeminiOAuthResult>('start_gemini_oauth');

      // Store in auth profile system as GeminiOAuthCredential
      upsertProfile(
        PROFILE_IDS.googleOAuth,
        'google',
        {
          type: 'gemini_oauth',
          accessToken: result.access_token,
          refreshToken: result.refresh_token,
          expiresAt: result.expires_at,
          projectId: result.project_id,
          email: result.email,
        },
        'Google OAuth',
      );

      console.log('[OAuth] Gemini connected successfully, project:', result.project_id);
      return result;
    } catch (err) {
      console.error('[OAuth] Gemini OAuth failed:', err);
      throw err;
    }
  }

  /**
   * Get a valid access token for a provider, auto-refreshing if needed.
   * Delegates to auth profile system.
   */
  async getAccessToken(provider: 'anthropic' | 'openai'): Promise<string> {
    const resolved = await resolveApiKey(provider);
    if (!resolved) {
      throw new Error(`No ${provider} credentials found. Please connect your account first.`);
    }
    return resolved.apiKey;
  }

  /**
   * Get connection status for a provider
   */
  getConnectionStatus(provider: 'anthropic' | 'openai'): {
    connected: boolean;
    status: 'active' | 'expired' | 'error' | 'none';
    expiresAt?: number;
  } {
    const profileId = provider === 'anthropic'
      ? PROFILE_IDS.anthropicOAuth
      : PROFILE_IDS.openaiOAuth;

    const profile = getProfile(profileId);
    if (!profile) {
      return { connected: false, status: 'none' };
    }

    if (profile.credential.type === 'oauth') {
      const cred = profile.credential as OAuthCredential;
      const expired = Date.now() >= cred.expiresAt;
      const hasRefresh = !!cred.refreshToken;

      if (expired && !hasRefresh) {
        return { connected: false, status: 'expired', expiresAt: cred.expiresAt };
      }

      // If expired but has refresh token, still considered connected
      return {
        connected: true,
        status: expired ? 'expired' : 'active',
        expiresAt: cred.expiresAt,
      };
    }

    return { connected: true, status: 'active' };
  }

  /**
   * Disconnect a provider (remove stored credentials)
   */
  disconnect(provider: 'anthropic' | 'openai') {
    const profileId = provider === 'anthropic'
      ? PROFILE_IDS.anthropicOAuth
      : PROFILE_IDS.openaiOAuth;
    deleteProfile(profileId);
    console.log(`[OAuth] ${provider} disconnected`);
  }

  /**
   * Check if a provider has valid OAuth credentials
   */
  isConnected(provider: 'anthropic' | 'openai'): boolean {
    const status = this.getConnectionStatus(provider);
    return status.connected;
  }

  /**
   * Check if tokens need refresh
   */
  needsRefresh(provider: 'anthropic' | 'openai'): boolean {
    const profileId = provider === 'anthropic'
      ? PROFILE_IDS.anthropicOAuth
      : PROFILE_IDS.openaiOAuth;
    const profile = getProfile(profileId);
    if (!profile || profile.credential.type !== 'oauth') return false;
    return Date.now() + REFRESH_BUFFER_MS >= profile.credential.expiresAt;
  }

  /**
   * Try to refresh token proactively
   */
  async tryRefresh(provider: 'anthropic' | 'openai'): Promise<{ success: boolean; error?: string }> {
    if (!this.needsRefresh(provider)) {
      return { success: true };
    }

    try {
      // resolveApiKey handles auto-refresh
      await resolveApiKey(provider);
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Token refresh failed'
      };
    }
  }

  /**
   * Get time until token expires (in milliseconds)
   */
  getTimeUntilExpiry(provider: 'anthropic' | 'openai'): number | null {
    const profileId = provider === 'anthropic'
      ? PROFILE_IDS.anthropicOAuth
      : PROFILE_IDS.openaiOAuth;
    const profile = getProfile(profileId);
    if (!profile || profile.credential.type !== 'oauth') return null;
    return Math.max(0, profile.credential.expiresAt - Date.now());
  }
}

export const oauthService = new OAuthService();
