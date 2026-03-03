/**
 * Startup Validation Service
 * Validates LLM auth profiles and MCP server connections on app startup
 */

import { anthropicClient } from './anthropicClient';
import { openaiClient } from './openaiClient';
import { codexClient } from './codexClient';
import { deepseekClient, xaiClient, ollamaClient } from './openaiCompatibleClient';
import { geminiClient } from './geminiClient';
import { mcpClient } from './mcpClient';
import {
  hasProfiles,
  listProfiles,
  resolveApiKey,
  importCliCredentials,
  refreshExpiring,
  PROFILE_IDS,
} from './auth-profiles';
import type { MCPServer } from '../types/mcp';

// ============================================================================
// Types
// ============================================================================

export interface ValidationResult {
  provider: string;
  status: 'ok' | 'error' | 'skipped' | 'warning';
  message: string;
  details?: string;
  action?: string;
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

  getLastReport(): StartupValidationReport | null {
    return this.lastReport;
  }

  async validate(callbacks?: ValidationCallbacks): Promise<StartupValidationReport> {
    if (this.isRunning) {
      console.log('[StartupValidator] Validation already in progress, skipping');
      return this.lastReport || this.createEmptyReport();
    }

    this.isRunning = true;
    const llmResults: ValidationResult[] = [];
    const serverResults: ValidationResult[] = [];

    try {
      callbacks?.onProgress?.('Importing CLI credentials...');

      // Auto-import Claude CLI credentials if available
      try {
        await importCliCredentials();
      } catch {
        // Not an error — CLI credentials may not exist
      }

      // Proactively refresh near-expiry OAuth tokens
      callbacks?.onProgress?.('Refreshing tokens...');
      try {
        await refreshExpiring();
      } catch {
        // Non-fatal
      }

      // Validate LLM providers
      callbacks?.onProgress?.('Validating LLM connections...');

      const anthropicResults = await this.validateAnthropic();
      for (const r of anthropicResults) {
        llmResults.push(r);
        callbacks?.onProviderValidated?.(r);
      }

      const openaiResults = await this.validateOpenAI();
      for (const r of openaiResults) {
        llmResults.push(r);
        callbacks?.onProviderValidated?.(r);
      }

      const deepseekResult = await this.validateDeepSeek();
      llmResults.push(deepseekResult);
      callbacks?.onProviderValidated?.(deepseekResult);

      const xaiResult = await this.validateXai();
      llmResults.push(xaiResult);
      callbacks?.onProviderValidated?.(xaiResult);

      const ollamaResult = await this.validateOllama();
      llmResults.push(ollamaResult);
      callbacks?.onProviderValidated?.(ollamaResult);

      const googleResult = await this.validateGoogle();
      llmResults.push(googleResult);
      callbacks?.onProviderValidated?.(googleResult);

      // Validate MCP servers
      callbacks?.onProgress?.('Validating MCP server connections...');
      const servers = mcpClient.getAllServers();
      const connectedServers = servers.filter(s => s.status === 'connected');

      for (const server of connectedServers) {
        const result = await this.validateMcpServer(server);
        serverResults.push(result);
        callbacks?.onServerValidated?.(server.id, result);
      }

      const report = this.compileReport(llmResults, serverResults);
      this.lastReport = report;
      callbacks?.onComplete?.(report);

      return report;
    } finally {
      this.isRunning = false;
    }
  }

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

  async validateServer(serverId: string): Promise<ValidationResult> {
    const server = mcpClient.getAllServers().find(s => s.id === serverId);
    if (!server) {
      return { provider: serverId, status: 'error', message: 'Server not found' };
    }
    return this.validateMcpServer(server);
  }

  // ============================================================================
  // Anthropic Validation
  // ============================================================================

  private async validateAnthropic(): Promise<ValidationResult[]> {
    console.log('[StartupValidator] ========================================');
    console.log('[StartupValidator] Anthropic Validation');
    console.log('[StartupValidator] ========================================');

    const results: ValidationResult[] = [];

    // Validate subscription (OAuth) profiles
    const oauthProfiles = listProfiles('anthropic').filter(
      p => p.credential.type === 'oauth' || p.credential.type === 'token'
    );

    if (oauthProfiles.length > 0) {
      const subResult = await this.testAnthropicAuth('Anthropic CLI');
      results.push(subResult);
    } else {
      results.push({
        provider: 'Anthropic CLI',
        status: 'skipped',
        message: 'No subscription credentials',
        action: 'Connect via OAuth or import CLI credentials',
      });
    }

    // Validate API key profiles
    const apiKeyProfiles = listProfiles('anthropic').filter(
      p => p.credential.type === 'api_key'
    );

    if (apiKeyProfiles.length > 0) {
      const apiResult = await this.testAnthropicApiKey();
      results.push(apiResult);
    } else {
      results.push({
        provider: 'Anthropic API',
        status: 'skipped',
        message: 'No API key configured',
      });
    }

    return results;
  }

  private async testAnthropicAuth(label: string): Promise<ValidationResult> {
    try {
      console.log(`[StartupValidator] Testing ${label} auth...`);
      // Pin to CLI profile — never fall back to API key when testing subscription
      const resolved = await resolveApiKey('anthropic', PROFILE_IDS.anthropicCli);
      if (!resolved) {
        return {
          provider: label,
          status: 'error',
          message: 'No usable credentials',
          action: 'Connect via OAuth or import CLI credentials',
        };
      }

      // Quick API test — list models
      const result = await anthropicClient.validateKey(resolved.apiKey);
      if (result.ok) {
        return {
          provider: label,
          status: 'ok',
          message: 'Connected and verified',
          details: `Profile: ${resolved.profileId}`,
        };
      }

      return {
        provider: label,
        status: 'error',
        message: 'Auth test failed',
        details: result.error?.slice(0, 200),
        action: 'Check credentials or reconnect',
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        provider: label,
        status: 'error',
        message: 'Auth test failed',
        details: errMsg.slice(0, 200),
        action: 'Check credentials or reconnect',
      };
    }
  }

  private async testAnthropicApiKey(): Promise<ValidationResult> {
    console.log('[StartupValidator] Testing Anthropic API key...');
    try {
      // Find the API key profile
      const apiProfile = listProfiles('anthropic').find(p => p.credential.type === 'api_key');
      if (!apiProfile || apiProfile.credential.type !== 'api_key') {
        return { provider: 'Anthropic API', status: 'skipped', message: 'No API key configured' };
      }

      const result = await anthropicClient.validateKey(apiProfile.credential.key);
      if (result.ok) {
        return { provider: 'Anthropic API', status: 'ok', message: 'API key valid' };
      }
      return {
        provider: 'Anthropic API',
        status: 'error',
        message: 'API key invalid',
        details: result.error || 'Validation failed',
        action: 'Check your API key in Settings',
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

  // ============================================================================
  // OpenAI Validation
  // ============================================================================

  private async validateOpenAI(): Promise<ValidationResult[]> {
    console.log('[StartupValidator] ========================================');
    console.log('[StartupValidator] OpenAI Validation');
    console.log('[StartupValidator] ========================================');

    const results: ValidationResult[] = [];

    // Validate subscription (OAuth) profiles
    const oauthProfiles = listProfiles('openai').filter(
      p => p.credential.type === 'oauth' || p.credential.type === 'token'
    );

    if (oauthProfiles.length > 0) {
      const subResult = await this.testOpenAIAuth('OpenAI CLI');
      results.push(subResult);
    } else {
      results.push({
        provider: 'OpenAI CLI',
        status: 'skipped',
        message: 'No subscription credentials',
      });
    }

    // Validate API key profiles
    const apiKeyProfiles = listProfiles('openai').filter(
      p => p.credential.type === 'api_key'
    );

    if (apiKeyProfiles.length > 0) {
      const apiResult = await this.testOpenAIApiKey();
      results.push(apiResult);
    } else {
      results.push({
        provider: 'OpenAI API',
        status: 'skipped',
        message: 'No API key configured',
      });
    }

    return results;
  }

  private async testOpenAIAuth(label: string): Promise<ValidationResult> {
    try {
      console.log(`[StartupValidator] Testing ${label} auth...`);

      // Use codexClient.validate() which checks OAuth token via the Codex endpoint
      const result = await codexClient.validate();
      if (result.ok) {
        return {
          provider: label,
          status: 'ok',
          message: 'Connected and verified',
        };
      }

      return {
        provider: label,
        status: 'error',
        message: 'Auth test failed',
        details: result.error?.slice(0, 200),
        action: 'Check credentials or reconnect',
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        provider: label,
        status: 'error',
        message: 'Auth test failed',
        details: errMsg.slice(0, 200),
        action: 'Check credentials or reconnect',
      };
    }
  }

  private async testOpenAIApiKey(): Promise<ValidationResult> {
    console.log('[StartupValidator] Testing OpenAI API key...');
    try {
      const apiProfile = listProfiles('openai').find(p => p.credential.type === 'api_key');
      if (!apiProfile || apiProfile.credential.type !== 'api_key') {
        return { provider: 'OpenAI API', status: 'skipped', message: 'No API key configured' };
      }

      const result = await openaiClient.validateKey(apiProfile.credential.key);
      if (result.ok) {
        return { provider: 'OpenAI API', status: 'ok', message: 'API key valid and working' };
      }
      return {
        provider: 'OpenAI API',
        status: 'error',
        message: 'API key invalid',
        details: result.error || 'Validation failed',
        action: 'Check your API key in Settings',
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
  // DeepSeek Validation
  // ============================================================================

  private async validateDeepSeek(): Promise<ValidationResult> {
    if (!hasProfiles('deepseek')) {
      return { provider: 'DeepSeek', status: 'skipped', message: 'No API key configured' };
    }
    try {
      const result = await deepseekClient.validateConnection();
      if (result.ok) {
        return { provider: 'DeepSeek', status: 'ok', message: 'API key valid' };
      }
      return { provider: 'DeepSeek', status: 'error', message: 'API key invalid', details: result.error };
    } catch (err) {
      return { provider: 'DeepSeek', status: 'error', message: 'Validation failed', details: err instanceof Error ? err.message : String(err) };
    }
  }

  // ============================================================================
  // x.ai Validation
  // ============================================================================

  private async validateXai(): Promise<ValidationResult> {
    if (!hasProfiles('xai')) {
      return { provider: 'xAI', status: 'skipped', message: 'No API key configured' };
    }
    try {
      const result = await xaiClient.validateConnection();
      if (result.ok) {
        return { provider: 'xAI', status: 'ok', message: 'API key valid' };
      }
      return { provider: 'xAI', status: 'error', message: 'API key invalid', details: result.error };
    } catch (err) {
      return { provider: 'xAI', status: 'error', message: 'Validation failed', details: err instanceof Error ? err.message : String(err) };
    }
  }

  // ============================================================================
  // Ollama Validation
  // ============================================================================

  private async validateOllama(): Promise<ValidationResult> {
    try {
      const models = await ollamaClient.discoverModels();
      if (models.length > 0) {
        return { provider: 'Ollama', status: 'ok', message: `Running with ${models.length} model(s)`, details: models.map(m => m.name).slice(0, 5).join(', ') };
      }
      // Ollama reachable but no models
      return { provider: 'Ollama', status: 'warning', message: 'Running but no models installed', action: 'Run "ollama pull llama3.1" to get started' };
    } catch {
      return { provider: 'Ollama', status: 'skipped', message: 'Not running locally' };
    }
  }

  // ============================================================================
  // Google (Gemini) Validation
  // ============================================================================

  private async validateGoogle(): Promise<ValidationResult> {
    if (!hasProfiles('google')) {
      return { provider: 'Google Gemini', status: 'skipped', message: 'No credentials configured' };
    }
    try {
      const result = await geminiClient.validateConnection();
      if (result.ok) {
        return { provider: 'Google Gemini', status: 'ok', message: 'Connected and verified' };
      }
      return { provider: 'Google Gemini', status: 'error', message: 'Connection failed', details: result.error, action: 'Reconnect via OAuth' };
    } catch (err) {
      return { provider: 'Google Gemini', status: 'error', message: 'Validation failed', details: err instanceof Error ? err.message : String(err) };
    }
  }

  // ============================================================================
  // MCP Server Validation
  // ============================================================================

  private async validateMcpServer(server: MCPServer): Promise<ValidationResult> {
    try {
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
  // Report Compilation
  // ============================================================================

  private compileReport(
    llmResults: ValidationResult[],
    serverResults: ValidationResult[]
  ): StartupValidationReport {
    const llmErrors = llmResults.filter(r => r.status === 'error');
    const llmWarnings = llmResults.filter(r => r.status === 'warning');
    const llmOk = llmResults.filter(r => r.status === 'ok');
    const serverErrors = serverResults.filter(r => r.status === 'error');
    const serverOk = serverResults.filter(r => r.status === 'ok');

    let overallStatus: 'healthy' | 'degraded' | 'critical' = 'healthy';

    if (llmErrors.length > 0 && llmOk.length === 0) {
      overallStatus = 'critical';
    } else if (llmErrors.length > 0 || llmWarnings.length > 0 || serverErrors.length > 0) {
      overallStatus = 'degraded';
    }

    const summaryParts: string[] = [];
    if (llmOk.length > 0) summaryParts.push(`${llmOk.length} LLM provider(s) ready`);
    if (llmErrors.length > 0) summaryParts.push(`${llmErrors.length} LLM provider(s) have errors`);
    if (llmWarnings.length > 0) summaryParts.push(`${llmWarnings.length} LLM provider(s) need attention`);
    if (serverOk.length > 0) summaryParts.push(`${serverOk.length} MCP server(s) connected`);
    if (serverErrors.length > 0) summaryParts.push(`${serverErrors.length} MCP server(s) disconnected`);

    const summary = summaryParts.length > 0 ? summaryParts.join(', ') : 'No providers configured';

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

export const startupValidator = new StartupValidator();
