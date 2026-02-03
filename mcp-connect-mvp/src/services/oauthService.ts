import { invoke } from '@tauri-apps/api/core';

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp in milliseconds
  token_type: string;
  provider: 'anthropic' | 'openai';
}

export interface OAuthSession {
  auth_url: string;
  code_verifier: string;
  state: string;
}

export interface AuthProfile {
  provider: 'anthropic' | 'openai';
  tokens: OAuthTokens;
  createdAt: string;
  lastUsed?: string;
  status: 'active' | 'expired' | 'error';
}

const STORAGE_KEY = 'kondi-auth-profiles';
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry

class OAuthService {
  private profiles: Map<string, AuthProfile> = new Map();

  constructor() {
    this.loadFromStorage();
  }

  private loadFromStorage() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        for (const [key, profile] of Object.entries(data.profiles || {})) {
          this.profiles.set(key, profile as AuthProfile);
        }
        console.log('[OAuth] Loaded profiles:', Array.from(this.profiles.keys()));
      }
    } catch (e) {
      console.error('[OAuth] Failed to load profiles from storage:', e);
    }
  }

  private saveToStorage() {
    try {
      const data = {
        profiles: Object.fromEntries(this.profiles),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.error('[OAuth] Failed to save profiles to storage:', e);
    }
  }

  /**
   * Start Anthropic OAuth flow (step 1)
   * Opens browser for user to authenticate with Claude account
   * Returns session info - caller must then call completeAnthropicOAuth with the code
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

      // Store the profile
      const profile: AuthProfile = {
        provider: 'anthropic',
        tokens,
        createdAt: new Date().toISOString(),
        status: 'active',
      };
      this.profiles.set('anthropic', profile);
      this.saveToStorage();

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
    // Step 1: Start OAuth and open browser
    const session = await this.startAnthropicOAuth();

    // Step 2: Get code from user
    const code = await getCode();
    if (!code) {
      throw new Error('OAuth cancelled - no code provided');
    }

    // Step 3: Exchange code for tokens
    return this.completeAnthropicOAuth(code, session.code_verifier, session.state);
  }

  /**
   * Start OpenAI OAuth flow
   * Opens browser for user to authenticate with ChatGPT account
   */
  async connectOpenAI(): Promise<OAuthTokens> {
    console.log('[OAuth] Starting OpenAI OAuth flow...');

    try {
      const tokens = await invoke<OAuthTokens>('start_openai_oauth');

      // Store the profile
      const profile: AuthProfile = {
        provider: 'openai',
        tokens,
        createdAt: new Date().toISOString(),
        status: 'active',
      };
      this.profiles.set('openai', profile);
      this.saveToStorage();

      console.log('[OAuth] OpenAI connected successfully');
      return tokens;
    } catch (err) {
      console.error('[OAuth] OpenAI OAuth failed:', err);
      throw err;
    }
  }

  /**
   * Get a valid access token for a provider, auto-refreshing if needed
   */
  async getAccessToken(provider: 'anthropic' | 'openai'): Promise<string> {
    const profile = this.profiles.get(provider);
    if (!profile?.tokens) {
      throw new Error(`No ${provider} OAuth profile found. Please connect your account first.`);
    }

    // Check if token needs refresh
    if (Date.now() + REFRESH_BUFFER_MS >= profile.tokens.expires_at) {
      console.log(`[OAuth] ${provider} token expiring soon, refreshing...`);

      try {
        const newTokens = provider === 'anthropic'
          ? await invoke<OAuthTokens>('refresh_anthropic_token', { refreshToken: profile.tokens.refresh_token })
          : await invoke<OAuthTokens>('refresh_openai_token', { refreshToken: profile.tokens.refresh_token });

        profile.tokens = newTokens;
        profile.status = 'active';
        profile.lastUsed = new Date().toISOString();
        this.saveToStorage();

        console.log(`[OAuth] ${provider} token refreshed successfully`);
        return newTokens.access_token;
      } catch (err) {
        console.error(`[OAuth] ${provider} token refresh failed:`, err);
        profile.status = 'expired';
        this.saveToStorage();
        throw new Error(`${provider} token refresh failed. Please reconnect your account.`);
      }
    }

    // Update last used
    profile.lastUsed = new Date().toISOString();
    this.saveToStorage();

    return profile.tokens.access_token;
  }

  /**
   * Get connection status for a provider
   */
  getConnectionStatus(provider: 'anthropic' | 'openai'): {
    connected: boolean;
    status: 'active' | 'expired' | 'error' | 'none';
    expiresAt?: number;
  } {
    const profile = this.profiles.get(provider);
    if (!profile) {
      return { connected: false, status: 'none' };
    }
    return {
      connected: profile.status === 'active',
      status: profile.status,
      expiresAt: profile.tokens?.expires_at,
    };
  }

  /**
   * Disconnect a provider (remove stored credentials)
   */
  disconnect(provider: 'anthropic' | 'openai') {
    this.profiles.delete(provider);
    this.saveToStorage();
    console.log(`[OAuth] ${provider} disconnected`);
  }

  /**
   * Check if a provider has valid OAuth credentials
   * This checks if tokens exist and are not expired
   */
  isConnected(provider: 'anthropic' | 'openai'): boolean {
    const profile = this.profiles.get(provider);
    if (!profile?.tokens?.access_token) return false;
    if (profile.status !== 'active') return false;
    // Also check if token is expired (with a small buffer)
    // Tokens that need refresh within the buffer are still "connected" since refresh will happen
    return true;
  }

  /**
   * Check if tokens are expired and need refresh
   * Returns true if tokens exist but are expired or expiring soon
   */
  needsRefresh(provider: 'anthropic' | 'openai'): boolean {
    const profile = this.profiles.get(provider);
    if (!profile?.tokens?.expires_at) return false;
    return Date.now() + REFRESH_BUFFER_MS >= profile.tokens.expires_at;
  }

  /**
   * Check if tokens are completely expired (past expiry + buffer)
   */
  isExpired(provider: 'anthropic' | 'openai'): boolean {
    const profile = this.profiles.get(provider);
    if (!profile?.tokens?.expires_at) return false;
    return Date.now() >= profile.tokens.expires_at;
  }

  /**
   * Try to refresh token proactively (useful for startup validation)
   * Returns true if refresh succeeded or wasn't needed
   */
  async tryRefresh(provider: 'anthropic' | 'openai'): Promise<{ success: boolean; error?: string }> {
    const profile = this.profiles.get(provider);
    if (!profile?.tokens) {
      return { success: false, error: 'No OAuth profile found' };
    }

    // If not expired, no refresh needed
    if (!this.needsRefresh(provider)) {
      return { success: true };
    }

    console.log(`[OAuth] Proactively refreshing ${provider} token...`);

    try {
      const newTokens = provider === 'anthropic'
        ? await invoke<OAuthTokens>('refresh_anthropic_token', { refreshToken: profile.tokens.refresh_token })
        : await invoke<OAuthTokens>('refresh_openai_token', { refreshToken: profile.tokens.refresh_token });

      profile.tokens = newTokens;
      profile.status = 'active';
      profile.lastUsed = new Date().toISOString();
      this.saveToStorage();

      console.log(`[OAuth] ${provider} token refreshed successfully`);
      return { success: true };
    } catch (err) {
      console.error(`[OAuth] ${provider} token refresh failed:`, err);
      profile.status = 'expired';
      this.saveToStorage();
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
    const profile = this.profiles.get(provider);
    if (!profile?.tokens?.expires_at) return null;
    return Math.max(0, profile.tokens.expires_at - Date.now());
  }
}

export const oauthService = new OAuthService();
