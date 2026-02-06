import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Config } from './types.js';

const DEFAULT_CONFIG: Config = {
  searxng: {
    url: 'http://localhost:8888',
    timeout_ms: 10000,
    default_language: 'en',
    default_categories: 'general',
    engines: ['google', 'bing', 'duckduckgo', 'brave'],
  },
  fetch: {
    user_agent: 'Mozilla/5.0 (compatible; KondiSearch/1.0)',
    default_timeout_seconds: 15,
    max_content_length: 50000,
    max_body_size_bytes: 10485760, // 10 MB
    rate_limit_per_domain: 30,
    blocked_domains: [],
    follow_redirects: true,
    max_redirects: 5,
  },
  server: {
    transport: 'stdio',
    port: 18100,
    log_level: 'info',
    log_file: join(homedir(), '.local', 'share', 'kondi-search', 'server.log'),
  },
};

function expandPath(path: string): string {
  if (path.startsWith('~')) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

function loadConfigFile(): Partial<Config> {
  const configPaths = [
    join(homedir(), '.config', 'kondi-search', 'config.json'),
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

  if (env.KONDI_SEARCH_SEARXNG_URL) {
    config.searxng.url = env.KONDI_SEARCH_SEARXNG_URL;
  }

  if (env.KONDI_SEARCH_TRANSPORT) {
    config.server.transport = env.KONDI_SEARCH_TRANSPORT as 'stdio' | 'sse';
  }

  if (env.KONDI_SEARCH_PORT) {
    config.server.port = parseInt(env.KONDI_SEARCH_PORT, 10);
  }

  if (env.KONDI_SEARCH_LOG_LEVEL) {
    config.server.log_level = env.KONDI_SEARCH_LOG_LEVEL as Config['server']['log_level'];
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

  // Expand paths
  config.server.log_file = expandPath(config.server.log_file);

  return config;
}

export function getDefaultConfig(): Config {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}
