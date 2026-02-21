import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Config } from './types.js';

const DEFAULT_CONFIG: Config = {
  api: {
    base_url: 'https://oauth.reddit.com',
    timeout_ms: 10000,
    user_agent: 'kondi-reddit-mcp/1.0.0',
  },
  auth: {
    access_token: '',
    client_id: '',
    client_secret: '',
  },
  server: {
    transport: 'stdio',
    port: 18206,
    log_level: 'info',
  },
};

function loadConfigFile(): Partial<Config> {
  const configPaths = [
    join(homedir(), '.config', 'kondi-reddit', 'config.json'),
    join(process.cwd(), 'config.json'),
  ];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, 'utf-8');
        return JSON.parse(content);
      } catch (e) {
        console.error(`Failed to parse config at ${configPath}:`, e);
      }
    }
  }

  return {};
}

function applyEnvOverrides(config: Config): Config {
  const env = process.env;

  // Auth
  if (env.KONDI_REDDIT_ACCESS_TOKEN) {
    config.auth.access_token = env.KONDI_REDDIT_ACCESS_TOKEN;
  }
  if (env.KONDI_REDDIT_CLIENT_ID) {
    config.auth.client_id = env.KONDI_REDDIT_CLIENT_ID;
  }
  if (env.KONDI_REDDIT_CLIENT_SECRET) {
    config.auth.client_secret = env.KONDI_REDDIT_CLIENT_SECRET;
  }

  // API
  if (env.KONDI_REDDIT_BASE_URL) {
    config.api.base_url = env.KONDI_REDDIT_BASE_URL;
  }
  if (env.KONDI_REDDIT_TIMEOUT_MS) {
    config.api.timeout_ms = parseInt(env.KONDI_REDDIT_TIMEOUT_MS, 10);
  }
  if (env.KONDI_REDDIT_USER_AGENT) {
    config.api.user_agent = env.KONDI_REDDIT_USER_AGENT;
  }

  // Server
  if (env.KONDI_REDDIT_TRANSPORT) {
    config.server.transport = env.KONDI_REDDIT_TRANSPORT as 'stdio' | 'sse';
  }
  if (env.KONDI_REDDIT_PORT) {
    config.server.port = parseInt(env.KONDI_REDDIT_PORT, 10);
  }
  if (env.KONDI_REDDIT_LOG_LEVEL) {
    config.server.log_level = env.KONDI_REDDIT_LOG_LEVEL as Config['server']['log_level'];
  }

  return config;
}

function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (
      sourceValue !== undefined &&
      typeof sourceValue === 'object' &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(targetValue as object, sourceValue as object) as T[keyof T];
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[keyof T];
    }
  }

  return result;
}

export function loadConfig(): Config {
  const fileConfig = loadConfigFile();
  let config = deepMerge(DEFAULT_CONFIG, fileConfig);
  config = applyEnvOverrides(config);
  return config;
}

export function getDefaultConfig(): Config {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}
