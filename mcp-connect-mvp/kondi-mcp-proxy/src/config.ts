/**
 * Config file reader/writer
 * Each proxy has its own config file that it reads and writes to.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ProxyConfig } from './types.js';

let configPath: string;
let cachedConfig: ProxyConfig | null = null;

export function setConfigPath(configFilePath: string): void {
  configPath = configFilePath;
  cachedConfig = null;
}

export function getConfigPath(): string {
  return configPath;
}

export function readConfig(): ProxyConfig {
  if (!configPath) {
    throw new Error('Config path not set');
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  cachedConfig = JSON.parse(content) as ProxyConfig;
  return cachedConfig;
}

export function getCachedConfig(): ProxyConfig | null {
  return cachedConfig;
}

export function writeConfig(config: ProxyConfig): void {
  if (!configPath) {
    throw new Error('Config path not set');
  }

  // Ensure directory exists
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Write with secure permissions
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  cachedConfig = config;
}

export function updateCredentials(updates: {
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
}): void {
  const config = readConfig();

  if (config.authMethod === 'oauth' && config.oauth) {
    if (updates.accessToken !== undefined) {
      config.oauth.accessToken = updates.accessToken;
    }
    if (updates.refreshToken !== undefined) {
      config.oauth.refreshToken = updates.refreshToken;
    }
    if (updates.tokenExpiresAt !== undefined) {
      config.oauth.tokenExpiresAt = updates.tokenExpiresAt;
    }
  }

  writeConfig(config);
}

export function clearCredentials(): void {
  const config = readConfig();

  if (config.authMethod === 'oauth' && config.oauth) {
    delete config.oauth.accessToken;
    delete config.oauth.refreshToken;
    delete config.oauth.tokenExpiresAt;
  }

  writeConfig(config);
}
