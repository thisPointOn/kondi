#!/usr/bin/env node
/**
 * PKCE helper for Pontiac MCP OAuth.
 * Usage: node scripts/oauth-pontiac.js
 * - Prints auth URL; open it in a browser.
 * - Waits for callback on http://localhost:8080/callback
 * - Exchanges code for token and prints access_token.
 */
import http from 'http';
import crypto from 'crypto';
import { URL } from 'url';

const CLIENT_ID = process.env.PONTIAC_CLIENT_ID || 'pontiac-mcp-client';
const CLIENT_SECRET = process.env.PONTIAC_CLIENT_SECRET || 'pontiac-mcp-secret-2025';
const AUTH_URL = process.env.PONTIAC_AUTH_URL || 'https://pontiac.media:1443/oauth/authorize';
const TOKEN_URL = process.env.PONTIAC_TOKEN_URL || 'https://pontiac.media:1443/oauth/token';
const REDIRECT_URI = process.env.PONTIAC_REDIRECT_URI || 'http://localhost:8080/callback';
const PORT = Number(new URL(REDIRECT_URI).port) || 8080;

const codeVerifier = crypto.randomBytes(32).toString('hex');
const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
const state = crypto.randomBytes(8).toString('hex');

const authUrl = new URL(AUTH_URL);
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('code_challenge', codeChallenge);
authUrl.searchParams.set('code_challenge_method', 'S256');
authUrl.searchParams.set('state', state);

console.log('Open this URL to authorize:');
console.log(authUrl.toString());

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  if (url.pathname !== new URL(REDIRECT_URI).pathname) {
    res.writeHead(404);
    return res.end();
  }

  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  if (!code || returnedState !== state) {
    res.writeHead(400);
    res.end('Invalid OAuth response');
    return;
  }

  res.writeHead(200);
  res.end('You can close this window.');

  try {
    const tokenResp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier,
      }).toString(),
    });

    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      console.error('Token exchange failed:', text);
      process.exit(1);
    }

    const tokens = await tokenResp.json();
    console.log('\nAccess token (paste into “Access token” when adding server):\n');
    console.log(tokens.access_token);
  } catch (err) {
    console.error('OAuth error:', err);
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log(`Listening for callback on ${REDIRECT_URI}`);
});
