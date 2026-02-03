/**
 * Control endpoints for Kondi to manage the proxy
 * GET /health - status
 * POST /auth - trigger OAuth flow
 * POST /check - verify connection
 * POST /reload - reload config
 */

import express from 'express';
import type { ProxyConfig, HealthResponse, AuthResponse, CheckResponse } from './types.js';
import { readConfig } from './config.js';
import { log } from './logger.js';
import * as proxy from './proxy.js';
import * as oauth from './auth/oauth.js';

export function createControlRouter(): express.Router {
  const router = express.Router();

  // GET /health - Primary status endpoint
  router.get('/health', (req, res) => {
    const config = readConfig();
    const status = proxy.getStatus();

    const response: HealthResponse = {
      status,
      serverId: config.id,
      serverName: config.name,
      remoteUrl: config.remoteUrl,
      authMethod: config.authMethod,
      transport: config.transport,
      toolCount: proxy.getToolCount(),
      lastActivity: proxy.getLastActivity()?.toISOString(),
      error: proxy.getLastError() ?? undefined,
    };

    // Add auth info for OAuth
    if (config.authMethod === 'oauth' && config.oauth) {
      const now = Math.floor(Date.now() / 1000);
      response.auth = {
        authenticated: !!config.oauth.accessToken,
        tokenExpiresAt: config.oauth.tokenExpiresAt,
        expiresInSeconds: config.oauth.tokenExpiresAt
          ? Math.max(0, config.oauth.tokenExpiresAt - now)
          : undefined,
        lastRefreshAttempt: proxy.getLastRefreshAttempt()?.toISOString(),
        lastRefreshResult: proxy.getLastRefreshResult() ?? undefined,
      };
    }

    res.json(response);
  });

  // POST /auth - Trigger authentication flow
  router.post('/auth', async (req, res) => {
    const config = readConfig();

    if (config.authMethod !== 'oauth') {
      const response: AuthResponse = {
        status: proxy.getStatus(),
        message: 'No authentication flow needed for this auth method.',
      };
      return res.json(response);
    }

    if (!config.oauth) {
      return res.status(400).json({
        status: 'error',
        message: 'OAuth configuration missing',
      });
    }

    try {
      log('Starting OAuth flow...');
      proxy.setStatus('authenticating');

      const browserUrl = await oauth.startOAuthFlow(config.oauth);

      const response: AuthResponse = {
        status: 'authenticating',
        message: 'OAuth flow started. Complete authentication in your browser.',
        browserUrl,
      };

      res.json(response);

      // Wait for auth to complete in background
      try {
        const token = await oauth.waitForAuth();
        log('OAuth flow completed successfully');

        // Reconnect with new credentials
        const newConfig = readConfig();
        await proxy.connect(newConfig);
        proxy.startRefreshTimer(newConfig);
      } catch (err) {
        log(`OAuth flow failed: ${err instanceof Error ? err.message : err}`);
        proxy.setStatus('needs_auth');
      }
    } catch (err) {
      log(`Failed to start OAuth flow: ${err instanceof Error ? err.message : err}`);
      return res.status(500).json({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to start OAuth flow',
      });
    }
  });

  // POST /check - Verify connection and refresh if needed
  router.post('/check', async (req, res) => {
    try {
      log('Running connection check...');

      // Re-read config
      const config = readConfig();

      // Check credentials
      const credStatus = proxy.checkCredentials(config);
      if (credStatus === 'needs_auth' || credStatus === 'needs_reauth') {
        proxy.setStatus(credStatus);
        const response: CheckResponse = {
          status: credStatus,
          message: credStatus === 'needs_auth'
            ? 'No credentials. Authentication required.'
            : 'Credentials invalid. Re-authentication required.',
        };
        return res.json(response);
      }

      // Try to connect/refresh
      if (config.authMethod === 'oauth' && config.oauth) {
        if (oauth.needsRefresh(config.oauth)) {
          try {
            await oauth.refreshToken(config.oauth);
            log('Token refreshed during check');
          } catch (err) {
            proxy.setStatus('needs_reauth');
            const response: CheckResponse = {
              status: 'needs_reauth',
              message: 'Token refresh failed. Re-authentication required.',
            };
            return res.json(response);
          }
        }
      }

      // Reconnect to verify
      const newConfig = readConfig();
      await proxy.connect(newConfig);

      const status = proxy.getStatus();
      let message = 'Connection verified.';

      if (status === 'connected' && config.authMethod === 'oauth' && config.oauth?.tokenExpiresAt) {
        const now = Math.floor(Date.now() / 1000);
        const remaining = config.oauth.tokenExpiresAt - now;
        message = `Connection verified. Token valid for ${remaining} more seconds.`;
      }

      const response: CheckResponse = {
        status,
        message,
      };

      res.json(response);
    } catch (err) {
      log(`Check failed: ${err instanceof Error ? err.message : err}`);
      res.status(500).json({
        status: 'error',
        message: err instanceof Error ? err.message : 'Check failed',
      });
    }
  });

  // POST /reload - Reload config and reconnect
  router.post('/reload', async (req, res) => {
    try {
      log('Reloading...');
      await proxy.reload();

      res.json({
        status: 'reloading',
      });
    } catch (err) {
      log(`Reload failed: ${err instanceof Error ? err.message : err}`);
      res.status(500).json({
        status: 'error',
        message: err instanceof Error ? err.message : 'Reload failed',
      });
    }
  });

  return router;
}
