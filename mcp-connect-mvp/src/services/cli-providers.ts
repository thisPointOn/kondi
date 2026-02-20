/**
 * CLI Providers — Stub (CLI spawning replaced by direct API with auth profiles)
 *
 * CLI-specific modules are no longer needed. All LLM calls now go through
 * direct API with OAuth tokens or API keys managed by the auth-profiles system.
 *
 * These stubs are kept for backwards compatibility with any remaining imports.
 */

export const claudeCodeWrapper = {
  checkInstalled: async (): Promise<{ installed: boolean; version?: string }> => ({ installed: false }),
  checkAuthenticated: async (): Promise<boolean> => false,
  login: async (): Promise<boolean> => false,
  call: async (): Promise<{ success: boolean; sessionId: string | null; result: string; error?: string }> =>
    ({ success: false, sessionId: null, result: '', error: 'CLI not available' }),
  callSync: async (): Promise<{ success: boolean; sessionId: string | null; result: string; error?: string }> =>
    ({ success: false, sessionId: null, result: '', error: 'CLI not available' }),
  listMCPServers: async (): Promise<string[]> => [],
  addMCPServer: async (_name: string, _config: object): Promise<boolean> => false,
  removeMCPServer: async (_name: string): Promise<boolean> => false,
};

export const codexWrapper = {
  checkInstalled: async (): Promise<{ installed: boolean; version?: string }> => ({ installed: false }),
  checkAuthenticated: async (): Promise<boolean> => false,
  login: async (): Promise<boolean> => false,
  call: async (): Promise<{ success: boolean; sessionId: string | null; result: string; error?: string }> =>
    ({ success: false, sessionId: null, result: '', error: 'CLI not available' }),
  callSync: async (): Promise<{ success: boolean; sessionId: string | null; result: string; error?: string }> =>
    ({ success: false, sessionId: null, result: '', error: 'CLI not available' }),
  listMCPServers: async (): Promise<string[]> => [],
  addMCPServer: async (_name: string, _command: string, _args: string[], _env?: Record<string, string>): Promise<boolean> => false,
  removeMCPServer: async (_name: string): Promise<boolean> => false,
};

export const claudeCliClient = {
  setWorkingDir: (_dir: string): void => {},
  setMcpConfig: (_config: any): void => {},
  getSessionId: (): string | null => null,
  clearSession: (): void => {},
  chat: async (): Promise<any> => { throw new Error('CLI not available'); },
  isAvailable: async (): Promise<boolean> => false,
  isAuthenticated: async (): Promise<boolean> => false,
};

export const claudeSessionManager = {
  getClaudeSessionId: (_id: string): string | null => null,
  registerSession: (_kondiId: string, _sessionId: string, _model: string): void => {},
  touch: (_id: string): void => {},
  getSessionInfo: (_id: string): any => null,
  clearSession: (_id: string): void => {},
  prune: (): number => 0,
};

export const codexSessionManager = {
  getCodexThreadId: (_id: string): string | null => null,
  registerSession: (_kondiId: string, _threadId: string, _model: string): void => {},
  touch: (_id: string): void => {},
  getSessionInfo: (_id: string): any => null,
  clearSession: (_id: string): void => {},
  prune: (): number => 0,
};

export const mcpCliSync = {
  syncServer: async (_server: any): Promise<void> => {},
  resyncServer: async (_server: any): Promise<void> => {},
  unsyncServer: async (_server: any): Promise<void> => {},
  getSyncedServers: (): string[] => [],
};

export const CLI_AVAILABLE = false;
