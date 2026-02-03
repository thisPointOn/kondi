/**
 * OAuth authentication handler
 * Manages browser-based OAuth flow, token refresh, and credential storage.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import open from 'open';
import { URL, URLSearchParams } from 'url';
import type { OAuthConfig } from '../types.js';
import { readConfig, updateCredentials, clearCredentials } from '../config.js';
import { log } from '../logger.js';

let callbackServer: http.Server | null = null;
let pendingAuthResolve: ((token: string) => void) | null = null;
let pendingAuthReject: ((error: Error) => void) | null = null;

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');
  return { verifier, challenge };
}

/**
 * Start the OAuth browser flow
 * Returns the browser URL that will be opened
 */
export async function startOAuthFlow(oauth: OAuthConfig): Promise<string> {
  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString('hex');

  // Build authorization URL
  const authUrl = new URL(oauth.authUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', oauth.clientId);
  authUrl.searchParams.set('redirect_uri', `http://localhost:${oauth.callbackPort}/callback`);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  if (oauth.scopes.length > 0) {
    authUrl.searchParams.set('scope', oauth.scopes.join(' '));
  }

  // Start callback server
  await startCallbackServer(oauth, verifier, state);

  // Open browser
  const browserUrl = authUrl.toString();
  log(`Opening browser for OAuth: ${browserUrl}`);
  await open(browserUrl);

  return browserUrl;
}

/**
 * Start the callback server to receive the OAuth redirect
 */
async function startCallbackServer(
  oauth: OAuthConfig,
  codeVerifier: string,
  expectedState: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (callbackServer) {
      callbackServer.close();
    }

    callbackServer = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${oauth.callbackPort}`);

      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<html><body><h1>Authentication Failed</h1><p>${error}</p></body></html>`);
          pendingAuthReject?.(new Error(`OAuth error: ${error}`));
          stopCallbackServer();
          return;
        }

        if (state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Authentication Failed</h1><p>Invalid state parameter</p></body></html>');
          pendingAuthReject?.(new Error('OAuth state mismatch'));
          stopCallbackServer();
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Authentication Failed</h1><p>No authorization code received</p></body></html>');
          pendingAuthReject?.(new Error('No authorization code'));
          stopCallbackServer();
          return;
        }

        // Exchange code for tokens
        try {
          const tokens = await exchangeCodeForTokens(oauth, code, codeVerifier);

          // Store tokens
          updateCredentials({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            tokenExpiresAt: tokens.expiresAt,
          });

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Authentication Successful!</h1><p>You can close this window and return to Kondi.</p></body></html>');

          pendingAuthResolve?.(tokens.accessToken);
          stopCallbackServer();
        } catch (err) {
          log(`Token exchange failed: ${err}`);
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<html><body><h1>Authentication Failed</h1><p>${err instanceof Error ? err.message : 'Unknown error'}</p></body></html>`);
          pendingAuthReject?.(err instanceof Error ? err : new Error('Token exchange failed'));
          stopCallbackServer();
        }
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    callbackServer.listen(oauth.callbackPort, '127.0.0.1', () => {
      log(`OAuth callback server listening on port ${oauth.callbackPort}`);
      resolve();
    });

    callbackServer.on('error', (err) => {
      log(`Callback server error: ${err}`);
      reject(err);
    });
  });
}

function stopCallbackServer(): void {
  if (callbackServer) {
    callbackServer.close();
    callbackServer = null;
  }
  pendingAuthResolve = null;
  pendingAuthReject = null;
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(
  oauth: OAuthConfig,
  code: string,
  codeVerifier: string
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: `http://localhost:${oauth.callbackPort}/callback`,
    client_id: oauth.clientId,
    code_verifier: codeVerifier,
  });

  if (oauth.clientSecret) {
    params.set('client_secret', oauth.clientSecret);
  }

  log(`Exchanging code for tokens at ${oauth.tokenUrl}`);

  const response = await fetch(oauth.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Math.floor(Date.now() / 1000) + data.expires_in : undefined,
  };
}

/**
 * Refresh the access token
 */
export async function refreshToken(oauth: OAuthConfig): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}> {
  if (!oauth.refreshToken) {
    throw new Error('No refresh token available');
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: oauth.refreshToken,
    client_id: oauth.clientId,
  });

  if (oauth.clientSecret) {
    params.set('client_secret', oauth.clientSecret);
  }

  log(`Refreshing token at ${oauth.tokenUrl}`);

  const response = await fetch(oauth.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${text}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const result = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || oauth.refreshToken, // Keep old if not rotated
    expiresAt: data.expires_in ? Math.floor(Date.now() / 1000) + data.expires_in : undefined,
  };

  // Update stored credentials
  updateCredentials(result);

  return result;
}

/**
 * Wait for the OAuth flow to complete
 * Call this after startOAuthFlow to wait for the callback
 */
export function waitForAuth(): Promise<string> {
  return new Promise((resolve, reject) => {
    pendingAuthResolve = resolve;
    pendingAuthReject = reject;

    // Timeout after 5 minutes
    setTimeout(() => {
      if (pendingAuthReject) {
        pendingAuthReject(new Error('OAuth flow timed out'));
        stopCallbackServer();
      }
    }, 5 * 60 * 1000);
  });
}

/**
 * Check if token needs refresh (expires in less than 5 minutes)
 */
export function needsRefresh(oauth: OAuthConfig): boolean {
  if (!oauth.tokenExpiresAt) return false;
  const now = Math.floor(Date.now() / 1000);
  return oauth.tokenExpiresAt - now < 300; // 5 minutes
}

/**
 * Check if we have valid credentials
 */
export function hasValidCredentials(oauth: OAuthConfig): boolean {
  if (!oauth.accessToken) return false;
  if (!oauth.tokenExpiresAt) return true; // No expiry = assume valid
  const now = Math.floor(Date.now() / 1000);
  return oauth.tokenExpiresAt > now;
}
