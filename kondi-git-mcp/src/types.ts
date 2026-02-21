export interface ApiConfig {
  working_dir: string;
  timeout_ms: number;
}

export interface ServerConfig {
  transport: 'stdio' | 'sse';
  port: number;
  log_level: 'debug' | 'info' | 'warn' | 'error';
}

export interface Config {
  api: ApiConfig;
  server: ServerConfig;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
