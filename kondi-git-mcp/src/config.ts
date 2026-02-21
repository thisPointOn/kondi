import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Config } from './types.js';

const DEFAULT_CONFIG: Config = {
  api: {
    working_dir: process.cwd(),
    timeout_ms: 30000,
  },
  server: {
    transport: 'stdio',
    port: 18209,
    log_level: 'info',
  },
};

function loadConfigFile(): Partial<Config> {
  const configPaths = [
    join(homedir(), '.config', 'kondi-git', 'config.json'),
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

  if (env.KONDI_GIT_WORKING_DIR) {
    config.api.working_dir = env.KONDI_GIT_WORKING_DIR;
  }

  if (env.KONDI_GIT_TIMEOUT_MS) {
    config.api.timeout_ms = parseInt(env.KONDI_GIT_TIMEOUT_MS, 10);
  }

  if (env.KONDI_GIT_TRANSPORT) {
    config.server.transport = env.KONDI_GIT_TRANSPORT as 'stdio' | 'sse';
  }

  if (env.KONDI_GIT_PORT) {
    config.server.port = parseInt(env.KONDI_GIT_PORT, 10);
  }

  if (env.KONDI_GIT_LOG_LEVEL) {
    config.server.log_level = env.KONDI_GIT_LOG_LEVEL as Config['server']['log_level'];
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
