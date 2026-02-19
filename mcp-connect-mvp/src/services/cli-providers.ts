/**
 * CLI Providers — Central adapter for CLI-specific modules
 *
 * All CLI-related imports are routed through this file. When shipping
 * without CLI support, replace this file's content with the contents of
 * cli-providers.stub.ts (which exports no-op implementations).
 *
 * Removable CLI files (delete these when shipping without CLI):
 *   - claudeCodeWrapper.ts
 *   - codexWrapper.ts
 *   - claudeCliClient.ts
 *   - claudeSessionManager.ts
 *   - codexSessionManager.ts
 *   - mcpCliSync.ts
 */

export { claudeCodeWrapper } from './claudeCodeWrapper';
export { codexWrapper } from './codexWrapper';
export { claudeCliClient } from './claudeCliClient';
export { claudeSessionManager } from './claudeSessionManager';
export { codexSessionManager } from './codexSessionManager';
export { mcpCliSync } from './mcpCliSync';

export const CLI_AVAILABLE = true;
