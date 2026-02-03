/**
 * Startup Validation Service
 * Validates LLM CLI connections and MCP server connections on app startup
 * Provides clear feedback to users about what's working and what isn't
 */

import { anthropicClient } from './anthropicClient';
import { openaiClient } from './openaiClient';
import { mcpClient } from './mcpClient';
import type { MCPServer } from '../types/mcp';

// ============================================================================
// Types
// ============================================================================

export interface ValidationResult {
  provider: string;
  status: 'ok' | 'error' | 'skipped' | 'warning';
  message: string;
  details?: string;
  action?: string; // Suggested action for user
}

export interface StartupValidationReport {
  timestamp: Date;
  llmProviders: ValidationResult[];
  mcpServers: ValidationResult[];
  overallStatus: 'healthy' | 'degraded' | 'critical';
  summary: string;
}

export interface ValidationCallbacks {
  onProgress?: (message: string) => void;
  onProviderValidated?: (result: ValidationResult) => void;
  onServerValidated?: (serverId: string, result: ValidationResult) => void;
  onComplete?: (report: StartupValidationReport) => void;
}

// ============================================================================
// Startup Validator Service
// ============================================================================

class StartupValidator {
  private lastReport: StartupValidationReport | null = null;
  private isRunning = false;

  /**
   * Get the most recent validation report
   */
  getLastReport(): StartupValidationReport | null {
    return this.lastReport;
  }

  /**
   * Run full startup validation
   */
  async validate(callbacks?: ValidationCallbacks): Promise<StartupValidationReport> {
    if (this.isRunning) {
      console.log('[StartupValidator] Validation already in progress, skipping');
      return this.lastReport || this.createEmptyReport();
    }

    this.isRunning = true;
    const llmResults: ValidationResult[] = [];
    const serverResults: ValidationResult[] = [];

    try {
      // Validate LLM providers
      callbacks?.onProgress?.('Validating LLM connections...');

      // Check Anthropic/Claude
      const anthropicResult = await this.validateAnthropic();
      llmResults.push(anthropicResult);
      callbacks?.onProviderValidated?.(anthropicResult);

      // Check OpenAI/ChatGPT
      const openaiResult = await this.validateOpenAI();
      llmResults.push(openaiResult);
      callbacks?.onProviderValidated?.(openaiResult);

      // Validate MCP servers that claim to be connected
      callbacks?.onProgress?.('Validating MCP server connections...');
      const servers = mcpClient.getAllServers();
      const connectedServers = servers.filter(s => s.status === 'connected');

      for (const server of connectedServers) {
        const result = await this.validateMcpServer(server);
        serverResults.push(result);
        callbacks?.onServerValidated?.(server.id, result);
      }

      // Compile report
      const report = this.compileReport(llmResults, serverResults);
      this.lastReport = report;
      callbacks?.onComplete?.(report);

      return report;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Validate just the LLM connections (quick check)
   */
  async validateLLMOnly(callbacks?: ValidationCallbacks): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];

    callbacks?.onProgress?.('Validating LLM connections...');

    const anthropicResult = await this.validateAnthropic();
    results.push(anthropicResult);
    callbacks?.onProviderValidated?.(anthropicResult);

    const openaiResult = await this.validateOpenAI();
    results.push(openaiResult);
    callbacks?.onProviderValidated?.(openaiResult);

    return results;
  }

  /**
   * Validate a specific MCP server
   */
  async validateServer(serverId: string): Promise<ValidationResult> {
    const server = mcpClient.getAllServers().find(s => s.id === serverId);
    if (!server) {
      return {
        provider: serverId,
        status: 'error',
        message: 'Server not found',
      };
    }
    return this.validateMcpServer(server);
  }

  // ============================================================================
  // Private Methods - LLM Validation
  // ============================================================================

  private async validateAnthropic(): Promise<ValidationResult> {
    console.log('[StartupValidator] ========================================');
    console.log('[StartupValidator] Anthropic Validation');
    console.log('[StartupValidator] ========================================');

    // Check user's preferred auth method
    const savedAuthMethod = localStorage.getItem('anthropic-auth-method');
    const useCliWrapper = localStorage.getItem('anthropic-use-cli-wrapper') === 'true';
    console.log('[StartupValidator] User auth method preference:', savedAuthMethod, 'useCliWrapper:', useCliWrapper);

    // If user has explicitly chosen API key mode, validate that first
    if (savedAuthMethod === 'api_key') {
      console.log('[StartupValidator] User prefers API key mode, validating...');
      return this.testAnthropicApiKey();
    }

    // Check if CLI is available (for oauth/cli mode or if no preference set)
    const cliStatus = await anthropicClient.checkCliAvailable();
    console.log('[StartupValidator] CLI status check:', cliStatus);

    if (cliStatus.installed && cliStatus.authenticated) {
      // CLI is available and authenticated - enable wrapper mode
      console.log('[StartupValidator] CLI is available, enabling wrapper mode...');
      anthropicClient.setUseCliWrapper(true);
      localStorage.setItem('anthropic-use-cli-wrapper', 'true');
      localStorage.setItem('anthropic-auth-method', 'oauth'); // CLI uses subscription auth

      // Test the CLI connection with an actual chat call
      const cliResult = await this.testAnthropicCli();
      return cliResult;
    }

    // CLI not available - fall back to API key if present
    console.log('[StartupValidator] CLI not available, checking for API key...');
    const authMethod = anthropicClient.getAuthMethod();
    console.log('[StartupValidator] Auth method:', authMethod);

    if (authMethod === 'api_key') {
      return this.testAnthropicApiKey();
    }

    // No working auth method
    return {
      provider: 'Anthropic (Claude)',
      status: 'error',
      message: 'Not configured',
      details: cliStatus.installed ? 'CLI found but not authenticated' : 'No API key or CLI available',
      action: cliStatus.installed ? 'Run "claude" in terminal to log in' : 'Add an API key in Settings or install Claude CLI',
    };
  }

  private async testAnthropicCli(): Promise<ValidationResult> {
    try {
      // First check if CLI is installed
      const cliStatus = await anthropicClient.checkCliAvailable();

      if (!cliStatus.installed) {
        return {
          provider: 'Anthropic (Claude)',
          status: 'error',
          message: 'Claude CLI not installed',
          details: 'CLI wrapper mode is enabled but CLI is not found',
          action: 'Install: npm install -g @anthropic-ai/claude-code',
        };
      }

      if (!cliStatus.authenticated) {
        return {
          provider: 'Anthropic (Claude)',
          status: 'error',
          message: 'Claude CLI not authenticated',
          details: 'CLI is installed but not logged in',
          action: 'Run "claude" in terminal to log in',
        };
      }

      // Now make an actual test call through the chat pathway
      console.log('[StartupValidator] Testing Anthropic chat pathway...');
      try {
        const testMessage = {
          id: 'validation-test',
          role: 'user' as const,
          content: 'Say "OK" and nothing else.',
          timestamp: new Date(),
        };

        const response = await anthropicClient.chat(
          [testMessage],
          new Map(), // no tools
          'claude-3-5-haiku-latest', // fast model for test
        );

        if (response.message && response.message.content) {
          console.log('[StartupValidator] Anthropic chat test passed');
          return {
            provider: 'Anthropic (Claude)',
            status: 'ok',
            message: 'Connected and verified',
            details: `CLI version: ${cliStatus.version || 'unknown'}`,
          };
        }
      } catch (chatErr) {
        const errMsg = chatErr instanceof Error ? chatErr.message : String(chatErr);
        console.error('[StartupValidator] Anthropic chat test failed:', errMsg);

        // Check for specific error types
        if (errMsg.includes('401') || errMsg.includes('insufficient permissions') || errMsg.includes('Missing scopes')) {
          return {
            provider: 'Anthropic (Claude)',
            status: 'error',
            message: 'Authentication failed',
            details: 'Got 401 error - CLI wrapper may not be properly enabled',
            action: 'Go to Provider Settings, disconnect and reconnect via CLI',
          };
        }

        return {
          provider: 'Anthropic (Claude)',
          status: 'error',
          message: 'Chat test failed',
          details: errMsg,
          action: 'Check console for details and try reconnecting',
        };
      }

      return {
        provider: 'Anthropic (Claude)',
        status: 'ok',
        message: 'Connected via Claude CLI',
        details: `Version: ${cliStatus.version || 'unknown'}`,
      };
    } catch (err) {
      return {
        provider: 'Anthropic (Claude)',
        status: 'error',
        message: 'CLI validation failed',
        details: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async testAnthropicApiKey(): Promise<ValidationResult> {
    console.log('[StartupValidator] Testing Anthropic API key mode...');
    try {
      // Try to validate the API key first
      const stored = localStorage.getItem('mcp-api-keys');
      if (stored) {
        const keys = JSON.parse(stored);
        if (keys.anthropic) {
          const result = await anthropicClient.validateKey(keys.anthropic);
          if (result.ok) {
            // API key is valid, but let's also test a chat call
            try {
              const testMessage = {
                id: 'validation-test',
                role: 'user' as const,
                content: 'Say "OK" and nothing else.',
                timestamp: new Date(),
              };
              await anthropicClient.chat([testMessage], new Map(), 'claude-3-5-haiku-latest');
              return {
                provider: 'Anthropic (Claude)',
                status: 'ok',
                message: 'API key valid and working',
              };
            } catch (chatErr) {
              const errMsg = chatErr instanceof Error ? chatErr.message : String(chatErr);
              return {
                provider: 'Anthropic (Claude)',
                status: 'error',
                message: 'API key valid but chat failed',
                details: errMsg.slice(0, 100),
                action: 'Check console for details',
              };
            }
          } else {
            return {
              provider: 'Anthropic (Claude)',
              status: 'error',
              message: 'API key invalid',
              details: result.error || 'Validation failed',
              action: 'Check your API key in Settings',
            };
          }
        }
      }

      return {
        provider: 'Anthropic (Claude)',
        status: 'error',
        message: 'No API key found',
        action: 'Add an API key in Settings or connect via CLI',
      };
    } catch (err) {
      return {
        provider: 'Anthropic (Claude)',
        status: 'error',
        message: 'API key validation failed',
        details: err instanceof Error ? err.message : String(err),
      };
    }
  }


  private async validateOpenAI(): Promise<ValidationResult> {
    console.log('[StartupValidator] ========================================');
    console.log('[StartupValidator] OpenAI Validation');
    console.log('[StartupValidator] ========================================');

    // Check user's preferred auth method
    const savedAuthMethod = localStorage.getItem('openai-auth-method');
    const useCliWrapper = localStorage.getItem('openai-use-cli-wrapper') === 'true';
    console.log('[StartupValidator] User auth method preference:', savedAuthMethod, 'useCliWrapper:', useCliWrapper);

    // If user has explicitly chosen API key mode, validate that first
    if (savedAuthMethod === 'api_key') {
      console.log('[StartupValidator] User prefers API key mode, validating...');
      return this.testOpenAIApiKey();
    }

    // Check if CLI is available (for oauth/cli mode or if no preference set)
    const cliStatus = await openaiClient.checkCliAvailable();
    console.log('[StartupValidator] Codex CLI status check:', cliStatus);

    if (cliStatus.installed && cliStatus.authenticated) {
      // CLI is available and authenticated - enable wrapper mode
      console.log('[StartupValidator] Codex CLI is available, enabling wrapper mode...');
      openaiClient.setUseCliWrapper(true);
      localStorage.setItem('openai-use-cli-wrapper', 'true');
      localStorage.setItem('openai-auth-method', 'oauth'); // CLI uses subscription auth

      // Test the CLI connection with an actual chat call
      const cliResult = await this.testOpenAICli();
      return cliResult;
    }

    // CLI not available - fall back to API key if present
    console.log('[StartupValidator] Codex CLI not available, checking for API key...');
    const authMethod = openaiClient.getAuthMethod();
    console.log('[StartupValidator] Auth method:', authMethod);

    if (authMethod === 'api_key') {
      return this.testOpenAIApiKey();
    }

    // No working auth method
    return {
      provider: 'OpenAI (ChatGPT)',
      status: 'error',
      message: 'Not configured',
      details: cliStatus.installed ? 'Codex CLI found but not authenticated' : 'No API key or CLI available',
      action: cliStatus.installed ? 'Run "codex login" in terminal' : 'Add an API key in Settings or install Codex CLI',
    };
  }

  private async testOpenAICli(): Promise<ValidationResult> {
    try {
      const cliStatus = await openaiClient.checkCliAvailable();

      if (!cliStatus.installed) {
        return {
          provider: 'OpenAI (ChatGPT)',
          status: 'error',
          message: 'Codex CLI not installed',
          details: 'CLI wrapper mode is enabled but CLI is not found',
          action: 'Install: npm install -g @openai/codex',
        };
      }

      if (!cliStatus.authenticated) {
        return {
          provider: 'OpenAI (ChatGPT)',
          status: 'error',
          message: 'Codex CLI not authenticated',
          details: 'CLI is installed but not logged in',
          action: 'Run "codex login" in terminal',
        };
      }

      // Now make an actual test call
      console.log('[StartupValidator] Testing OpenAI chat pathway...');
      try {
        const testMessage = {
          id: 'validation-test',
          role: 'user' as const,
          content: 'Say "OK" and nothing else.',
          timestamp: new Date(),
        };
        const response = await openaiClient.chat([testMessage], new Map(), 'gpt-4o-mini');
        if (response.message && response.message.content) {
          console.log('[StartupValidator] OpenAI chat test passed');
          return {
            provider: 'OpenAI (ChatGPT)',
            status: 'ok',
            message: 'Connected and verified',
            details: `CLI version: ${cliStatus.version || 'unknown'}`,
          };
        }
      } catch (chatErr) {
        const errMsg = chatErr instanceof Error ? chatErr.message : String(chatErr);
        console.error('[StartupValidator] OpenAI chat test failed:', errMsg);

        if (errMsg.includes('401') || errMsg.includes('insufficient permissions')) {
          return {
            provider: 'OpenAI (ChatGPT)',
            status: 'error',
            message: 'Authentication failed',
            details: 'Got 401 error - CLI wrapper may not be properly enabled',
            action: 'Go to Provider Settings, disconnect and reconnect via CLI',
          };
        }

        return {
          provider: 'OpenAI (ChatGPT)',
          status: 'error',
          message: 'Chat test failed',
          details: errMsg,
          action: 'Check console for details and try reconnecting',
        };
      }

      return {
        provider: 'OpenAI (ChatGPT)',
        status: 'ok',
        message: 'Connected via Codex CLI',
        details: `Version: ${cliStatus.version || 'unknown'}`,
      };
    } catch (err) {
      return {
        provider: 'OpenAI (ChatGPT)',
        status: 'error',
        message: 'CLI validation failed',
        details: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async testOpenAIApiKey(): Promise<ValidationResult> {
    console.log('[StartupValidator] Testing OpenAI API key mode...');
    try {
      const stored = localStorage.getItem('mcp-api-keys');
      if (stored) {
        const keys = JSON.parse(stored);
        if (keys.openai) {
          const result = await openaiClient.validateKey(keys.openai);
          if (result.ok) {
            // API key is valid, now test chat
            try {
              const testMessage = {
                id: 'validation-test',
                role: 'user' as const,
                content: 'Say "OK" and nothing else.',
                timestamp: new Date(),
              };
              await openaiClient.chat([testMessage], new Map(), 'gpt-4o-mini');
              return {
                provider: 'OpenAI (ChatGPT)',
                status: 'ok',
                message: 'API key valid and working',
              };
            } catch (chatErr) {
              const errMsg = chatErr instanceof Error ? chatErr.message : String(chatErr);
              return {
                provider: 'OpenAI (ChatGPT)',
                status: 'error',
                message: 'API key valid but chat failed',
                details: errMsg.slice(0, 100),
                action: 'Check console for details',
              };
            }
          } else {
            return {
              provider: 'OpenAI (ChatGPT)',
              status: 'error',
              message: 'API key invalid',
              details: result.error || 'Validation failed',
              action: 'Check your API key in Settings',
            };
          }
        }
      }

      return {
        provider: 'OpenAI (ChatGPT)',
        status: 'error',
        message: 'No API key found',
        action: 'Add an API key in Settings or connect via CLI',
      };
    } catch (err) {
      return {
        provider: 'OpenAI (ChatGPT)',
        status: 'error',
        message: 'API key validation failed',
        details: err instanceof Error ? err.message : String(err),
      };
    }
  }


  // ============================================================================
  // Private Methods - MCP Server Validation
  // ============================================================================

  private async validateMcpServer(server: MCPServer): Promise<ValidationResult> {
    try {
      // Check if we can get tools from this server
      const tools = mcpClient.getTools(server.id);

      if (server.status === 'connected') {
        if (tools && tools.length >= 0) {
          return {
            provider: server.name,
            status: 'ok',
            message: 'Connected',
            details: `${tools.length} tools available`,
          };
        }
      }

      return {
        provider: server.name,
        status: 'error',
        message: 'Connection lost',
        details: 'Server was marked connected but is not responding',
        action: 'Try reconnecting the server',
      };
    } catch (err) {
      return {
        provider: server.name,
        status: 'error',
        message: 'Connection failed',
        details: err instanceof Error ? err.message : String(err),
        action: 'Check server configuration and try reconnecting',
      };
    }
  }

  // ============================================================================
  // Private Methods - Report Compilation
  // ============================================================================

  private compileReport(
    llmResults: ValidationResult[],
    serverResults: ValidationResult[]
  ): StartupValidationReport {
    // Count by status
    const llmErrors = llmResults.filter(r => r.status === 'error');
    const llmWarnings = llmResults.filter(r => r.status === 'warning');
    const llmOk = llmResults.filter(r => r.status === 'ok');
    const serverErrors = serverResults.filter(r => r.status === 'error');
    const serverOk = serverResults.filter(r => r.status === 'ok');

    // Determine overall status
    let overallStatus: 'healthy' | 'degraded' | 'critical' = 'healthy';

    if (llmErrors.length > 0 && llmOk.length === 0) {
      // No working LLM providers - critical
      overallStatus = 'critical';
    } else if (llmErrors.length > 0 || llmWarnings.length > 0 || serverErrors.length > 0) {
      // Some issues but at least one LLM works - degraded
      overallStatus = 'degraded';
    }

    // Build summary message
    const summaryParts: string[] = [];

    if (llmOk.length > 0) {
      summaryParts.push(`${llmOk.length} LLM provider(s) ready`);
    }
    if (llmErrors.length > 0) {
      summaryParts.push(`${llmErrors.length} LLM provider(s) have errors`);
    }
    if (llmWarnings.length > 0) {
      summaryParts.push(`${llmWarnings.length} LLM provider(s) need attention`);
    }
    if (serverOk.length > 0) {
      summaryParts.push(`${serverOk.length} MCP server(s) connected`);
    }
    if (serverErrors.length > 0) {
      summaryParts.push(`${serverErrors.length} MCP server(s) disconnected`);
    }

    const summary = summaryParts.length > 0
      ? summaryParts.join(', ')
      : 'No providers configured';

    return {
      timestamp: new Date(),
      llmProviders: llmResults,
      mcpServers: serverResults,
      overallStatus,
      summary,
    };
  }

  private createEmptyReport(): StartupValidationReport {
    return {
      timestamp: new Date(),
      llmProviders: [],
      mcpServers: [],
      overallStatus: 'healthy',
      summary: 'No validation performed',
    };
  }
}

// ============================================================================
// Export Singleton
// ============================================================================

export const startupValidator = new StartupValidator();
