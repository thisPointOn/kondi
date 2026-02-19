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

      // Check Anthropic/Claude (separate results for CLI and API)
      const anthropicResults = await this.validateAnthropic();
      for (const r of anthropicResults) {
        llmResults.push(r);
        callbacks?.onProviderValidated?.(r);
      }

      // Check OpenAI/ChatGPT (separate results for CLI and API)
      const openaiResults = await this.validateOpenAI();
      for (const r of openaiResults) {
        llmResults.push(r);
        callbacks?.onProviderValidated?.(r);
      }

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

    const anthropicResults = await this.validateAnthropic();
    for (const r of anthropicResults) {
      results.push(r);
      callbacks?.onProviderValidated?.(r);
    }

    const openaiResults = await this.validateOpenAI();
    for (const r of openaiResults) {
      results.push(r);
      callbacks?.onProviderValidated?.(r);
    }

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

  private async validateAnthropic(): Promise<ValidationResult[]> {
    console.log('[StartupValidator] ========================================');
    console.log('[StartupValidator] Anthropic Validation');
    console.log('[StartupValidator] ========================================');

    const results: ValidationResult[] = [];

    // --- Validate CLI (Claude Code) independently ---
    const cliStatus = await anthropicClient.checkCliAvailable();
    console.log('[StartupValidator] Claude CLI status check:', cliStatus);

    if (cliStatus.installed && cliStatus.authenticated) {
      console.log('[StartupValidator] Claude CLI is available');
      // Only auto-enable CLI wrapper if the user hasn't explicitly chosen API mode
      const storedProviderId = localStorage.getItem('kondi-provider-id');
      const userChoseApi = storedProviderId === 'anthropic-api';
      if (!userChoseApi) {
        anthropicClient.setUseCliWrapper(true);
        localStorage.setItem('anthropic-use-cli-wrapper', 'true');
        localStorage.setItem('anthropic-auth-method', 'oauth');
      } else {
        console.log('[StartupValidator] User explicitly chose API mode — not overriding');
      }

      // Test the CLI with an actual chat call
      const cliResult = await this.testAnthropicCli();
      results.push(cliResult);
    } else if (cliStatus.installed) {
      results.push({
        provider: 'Anthropic CLI',
        status: 'warning',
        message: 'Not authenticated',
        details: 'Claude CLI found but not logged in',
        action: 'Run "claude" in terminal to log in',
      });
    } else {
      results.push({
        provider: 'Anthropic CLI',
        status: 'skipped',
        message: 'Claude CLI not installed',
      });
    }

    // --- Validate API key independently ---
    const apiResult = await this.testAnthropicApiKey();
    results.push(apiResult);

    return results;
  }

  private async testAnthropicCli(): Promise<ValidationResult> {
    try {
      console.log('[StartupValidator] Testing Anthropic CLI chat pathway...');
      const cliStatus = await anthropicClient.checkCliAvailable();

      const testMessage = {
        id: 'validation-test',
        role: 'user' as const,
        content: 'Say "OK" and nothing else.',
        timestamp: new Date(),
      };

      const response = await anthropicClient.chat(
        [testMessage],
        new Map(),
        'claude-haiku-4-5-20251001',
      );

      if (response.message && response.message.content) {
        console.log('[StartupValidator] Anthropic CLI chat test passed');
        return {
          provider: 'Anthropic CLI',
          status: 'ok',
          message: 'Connected and verified',
          details: `CLI version: ${cliStatus.version || 'unknown'}`,
        };
      }

      return {
        provider: 'Anthropic CLI',
        status: 'error',
        message: 'Chat test returned empty response',
        action: 'Check console for details',
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[StartupValidator] Anthropic CLI test failed:', errMsg);
      return {
        provider: 'Anthropic CLI',
        status: 'error',
        message: 'Chat test failed',
        details: errMsg.slice(0, 200),
        action: 'Check console for details and try reconnecting',
      };
    }
  }

  private async testAnthropicApiKey(): Promise<ValidationResult> {
    console.log('[StartupValidator] Testing Anthropic API key...');
    try {
      const stored = localStorage.getItem('mcp-api-keys');
      if (stored) {
        const keys = JSON.parse(stored);
        if (keys.anthropic) {
          const result = await anthropicClient.validateKey(keys.anthropic);
          if (result.ok) {
            return {
              provider: 'Anthropic API',
              status: 'ok',
              message: 'API key valid',
            };
          } else {
            return {
              provider: 'Anthropic API',
              status: 'error',
              message: 'API key invalid',
              details: result.error || 'Validation failed',
              action: 'Check your API key in Settings',
            };
          }
        }
      }

      return {
        provider: 'Anthropic API',
        status: 'skipped',
        message: 'No API key configured',
      };
    } catch (err) {
      return {
        provider: 'Anthropic API',
        status: 'error',
        message: 'API key validation failed',
        details: err instanceof Error ? err.message : String(err),
      };
    }
  }


  private async validateOpenAI(): Promise<ValidationResult[]> {
    console.log('[StartupValidator] ========================================');
    console.log('[StartupValidator] OpenAI Validation');
    console.log('[StartupValidator] ========================================');

    const results: ValidationResult[] = [];

    // --- Validate CLI (Codex) independently ---
    const cliStatus = await openaiClient.checkCliAvailable();
    console.log('[StartupValidator] Codex CLI status check:', cliStatus);

    if (cliStatus.installed && cliStatus.authenticated) {
      // checkCliAvailable already ran a real exec call and it succeeded
      console.log('[StartupValidator] Codex CLI is available and authenticated');
      // Only auto-enable CLI wrapper if the user hasn't explicitly chosen API mode
      const storedProviderId = localStorage.getItem('kondi-provider-id');
      const userChoseApi = storedProviderId === 'openai-api';
      if (!userChoseApi) {
        openaiClient.setUseCliWrapper(true);
        localStorage.setItem('openai-use-cli-wrapper', 'true');
        localStorage.setItem('openai-auth-method', 'oauth');
      } else {
        console.log('[StartupValidator] User explicitly chose API mode — not overriding');
      }
      results.push({
        provider: 'OpenAI CLI',
        status: 'ok',
        message: 'Connected and verified',
        details: `CLI version: ${cliStatus.version || 'unknown'}`,
      });
    } else if (cliStatus.installed) {
      results.push({
        provider: 'OpenAI CLI',
        status: 'warning',
        message: 'Not authenticated',
        details: 'Codex CLI found but not logged in',
        action: 'Run "codex login" in terminal',
      });
    } else {
      results.push({
        provider: 'OpenAI CLI',
        status: 'skipped',
        message: 'Codex CLI not installed',
      });
    }

    // --- Validate API key independently ---
    const apiResult = await this.testOpenAIApiKey();
    results.push(apiResult);

    return results;
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
            // API key is valid, now test chat using the user's selected model
            try {
              const testMessage = {
                id: 'validation-test',
                role: 'user' as const,
                content: 'Say "OK" and nothing else.',
                timestamp: new Date(),
              };
              const selectedModel = keys.openaiModel || localStorage.getItem('kondi-openai-model') || 'gpt-4o-mini';
              await openaiClient.chat([testMessage], new Map(), selectedModel);
              return {
                provider: 'OpenAI API',
                status: 'ok',
                message: 'API key valid and working',
              };
            } catch (chatErr) {
              const errMsg = chatErr instanceof Error ? chatErr.message : String(chatErr);
              return {
                provider: 'OpenAI API',
                status: 'error',
                message: 'API key valid but chat failed',
                details: errMsg,
                action: 'Check console for details',
              };
            }
          } else {
            return {
              provider: 'OpenAI API',
              status: 'error',
              message: 'API key invalid',
              details: result.error || 'Validation failed',
              action: 'Check your API key in Settings',
            };
          }
        }
      }

      return {
        provider: 'OpenAI API',
        status: 'skipped',
        message: 'No API key configured',
      };
    } catch (err) {
      return {
        provider: 'OpenAI API',
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
