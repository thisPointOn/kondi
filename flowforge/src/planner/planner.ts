/**
 * FlowForge Planner
 * Interactive workflow planning orchestrator
 */

import {
  PlanningSession,
  PlanningMessage,
  WorkflowSpec,
} from '../core/types.js';
import { PlanningSessionClosedError } from '../core/errors.js';
import { providerRegistry } from '../providers/registry.js';
import { SessionManager, getDefaultSessionManager } from './session.js';
import { parseWorkflowSpec, parseStep, parseValidationResponse, ValidationResult } from './parser.js';
import {
  PLANNING_SYSTEM_PROMPT,
  GREETING_PROMPT,
  buildValidationPrompt,
  buildRefinementPrompt,
  buildStepGenerationPrompt,
} from './prompts.js';
import { Logger, createExecutionLogger } from '../utils/logger.js';

// ============================================================================
// Planner Types
// ============================================================================

export interface PlannerConfig {
  /** Session manager for session storage */
  sessionManager?: SessionManager;

  /** Default model for planning */
  defaultModel?: string;

  /** Default provider for planning */
  defaultProvider?: string;

  /** Available tools to suggest in workflows */
  availableTools?: Array<{
    serverId: string;
    name: string;
    description: string;
  }>;
}

export interface PlannerResponse {
  message: string;
  specUpdate?: Partial<WorkflowSpec>;
  isComplete?: boolean;
  validation?: ValidationResult;
}

// ============================================================================
// Planner
// ============================================================================

export class Planner {
  private config: PlannerConfig;
  private sessionManager: SessionManager;
  private logger: Logger;

  constructor(config?: PlannerConfig) {
    this.config = {
      defaultModel: 'claude-3-5-sonnet-latest',
      defaultProvider: 'anthropic',
      ...config,
    };
    this.sessionManager = config?.sessionManager || getDefaultSessionManager();
    this.logger = createExecutionLogger('planner', 'global');
  }

  /**
   * Start a new planning session
   */
  async startSession(): Promise<{ session: PlanningSession; greeting: string }> {
    const session = await this.sessionManager.createSession();

    // Add system message
    await this.sessionManager.addMessage(
      session.id,
      'system',
      PLANNING_SYSTEM_PROMPT
    );

    this.logger.info('Planning session started', { sessionId: session.id });

    return {
      session,
      greeting: GREETING_PROMPT,
    };
  }

  /**
   * Send a message in a planning conversation
   */
  async sendMessage(
    sessionId: string,
    userMessage: string
  ): Promise<PlannerResponse> {
    // Get session
    const session = await this.sessionManager.getSession(sessionId);

    if (session.status !== 'active') {
      throw new PlanningSessionClosedError(sessionId);
    }

    // Add user message
    await this.sessionManager.addMessage(sessionId, 'user', userMessage);

    this.logger.debug('User message received', { sessionId, messageLength: userMessage.length });

    // Build conversation history for LLM
    const messages = await this.buildConversationMessages(session);

    // Get response from LLM
    const result = await providerRegistry.complete(
      {
        model: this.config.defaultModel!,
        messages,
        systemPrompt: PLANNING_SYSTEM_PROMPT,
        temperature: 0.7,
        maxTokens: 4096,
      },
      { preferredProvider: this.config.defaultProvider }
    );

    const assistantMessage = result.content;

    // Parse response for spec updates
    const specUpdate = this.extractSpecUpdate(assistantMessage);

    // Add assistant message
    await this.sessionManager.addMessage(
      sessionId,
      'assistant',
      assistantMessage,
      specUpdate
    );

    this.logger.debug('Assistant response generated', {
      sessionId,
      hasSpecUpdate: !!specUpdate,
    });

    // Check if workflow is complete
    const isComplete = await this.checkCompletion(sessionId);

    return {
      message: assistantMessage,
      specUpdate,
      isComplete,
    };
  }

  /**
   * Apply a direct edit to the spec
   */
  async applyEdit(
    sessionId: string,
    specEdit: Partial<WorkflowSpec>
  ): Promise<PlannerResponse> {
    const session = await this.sessionManager.getSession(sessionId);

    if (session.status !== 'active') {
      throw new PlanningSessionClosedError(sessionId);
    }

    // Update the spec
    const updatedSpec = await this.sessionManager.updateSpec(sessionId, specEdit);

    // Add a note about the edit
    const editSummary = this.summarizeEdit(specEdit);
    await this.sessionManager.addMessage(
      sessionId,
      'user',
      `[Direct edit: ${editSummary}]`,
      specEdit
    );

    // Generate acknowledgment
    const ackMessage = `I've applied your edits: ${editSummary}. The workflow has been updated.`;
    await this.sessionManager.addMessage(sessionId, 'assistant', ackMessage);

    const isComplete = await this.checkCompletion(sessionId);

    return {
      message: ackMessage,
      specUpdate: updatedSpec,
      isComplete,
    };
  }

  /**
   * Validate the current spec
   */
  async validateSpec(sessionId: string): Promise<ValidationResult> {
    const spec = await this.sessionManager.getSpec(sessionId);

    if (!spec) {
      return {
        valid: false,
        issues: ['No workflow spec defined yet'],
        suggestions: ['Start by describing what you want to automate'],
        missingFields: ['name', 'description', 'steps'],
      };
    }

    // Use LLM for semantic validation
    const validationPrompt = buildValidationPrompt(JSON.stringify(spec, null, 2));

    const result = await providerRegistry.complete(
      {
        model: this.config.defaultModel!,
        messages: [{ role: 'user', content: validationPrompt }],
        temperature: 0.1,
        maxTokens: 1024,
      },
      { preferredProvider: this.config.defaultProvider }
    );

    const validation = parseValidationResponse(result.content);

    this.logger.debug('Spec validation completed', {
      sessionId,
      valid: validation.valid,
      issueCount: validation.issues.length,
    });

    return validation;
  }

  /**
   * Generate a step based on task description
   */
  async generateStep(
    sessionId: string,
    taskDescription: string
  ): Promise<{ step: WorkflowSpec['steps'][0] | null; message: string }> {
    const spec = await this.sessionManager.getSpec(sessionId);
    const previousSteps = spec?.steps?.map((s) => ({ id: s.id, name: s.name })) || [];
    const tools = this.config.availableTools || [];

    const prompt = buildStepGenerationPrompt(
      taskDescription,
      tools.map((t) => ({ name: t.name, description: t.description })),
      previousSteps
    );

    const result = await providerRegistry.complete(
      {
        model: this.config.defaultModel!,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        maxTokens: 2048,
      },
      { preferredProvider: this.config.defaultProvider }
    );

    const parseResult = parseStep(result.content);

    if (parseResult.success && parseResult.step) {
      // Add step to spec
      const currentSteps = spec?.steps || [];
      await this.sessionManager.updateSpec(sessionId, {
        steps: [...currentSteps, parseResult.step],
      });

      return {
        step: parseResult.step,
        message: `Added step: ${parseResult.step.name}`,
      };
    }

    return {
      step: null,
      message: `Could not generate step: ${parseResult.errors?.join(', ') || 'Unknown error'}`,
    };
  }

  /**
   * Get the current spec
   */
  async getSpec(sessionId: string): Promise<Partial<WorkflowSpec> | undefined> {
    return this.sessionManager.getSpec(sessionId);
  }

  /**
   * Get conversation history
   */
  async getHistory(sessionId: string): Promise<PlanningMessage[]> {
    return this.sessionManager.getMessages(sessionId);
  }

  /**
   * Complete the planning session
   */
  async completeSession(
    sessionId: string
  ): Promise<{ session: PlanningSession; spec: Partial<WorkflowSpec> | undefined }> {
    const session = await this.sessionManager.completeSession(sessionId);
    const spec = session.currentSpec;

    this.logger.info('Planning session completed', { sessionId });

    return { session, spec };
  }

  /**
   * Abandon the planning session
   */
  async abandonSession(sessionId: string): Promise<void> {
    await this.sessionManager.abandonSession(sessionId);
    this.logger.info('Planning session abandoned', { sessionId });
  }

  /**
   * Set available tools for workflow suggestions
   */
  setAvailableTools(
    tools: Array<{ serverId: string; name: string; description: string }>
  ): void {
    this.config.availableTools = tools;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async buildConversationMessages(
    session: PlanningSession
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const msg of session.messages) {
      if (msg.role === 'system') continue; // System handled separately

      messages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      });
    }

    // Add current spec context if exists
    if (session.currentSpec) {
      messages.push({
        role: 'user',
        content: `[Current workflow spec:\n${JSON.stringify(session.currentSpec, null, 2)}\n]`,
      });
    }

    // Add available tools context
    if (this.config.availableTools && this.config.availableTools.length > 0) {
      const toolsContext = this.config.availableTools
        .map((t) => `- ${t.name} (${t.serverId}): ${t.description}`)
        .join('\n');

      messages.push({
        role: 'user',
        content: `[Available MCP tools:\n${toolsContext}\n]`,
      });
    }

    return messages;
  }

  private extractSpecUpdate(response: string): Partial<WorkflowSpec> | undefined {
    const parseResult = parseWorkflowSpec(response);

    if (parseResult.success && parseResult.spec) {
      return parseResult.spec;
    }

    // Try to extract partial updates
    if (parseResult.spec) {
      return parseResult.spec;
    }

    return undefined;
  }

  private async checkCompletion(sessionId: string): Promise<boolean> {
    const spec = await this.sessionManager.getSpec(sessionId);

    if (!spec) return false;

    // Basic completeness check
    return !!(
      spec.name &&
      spec.description &&
      spec.steps &&
      spec.steps.length > 0 &&
      spec.steps.every((s) => s.name && s.type && s.description)
    );
  }

  private summarizeEdit(edit: Partial<WorkflowSpec>): string {
    const parts: string[] = [];

    if (edit.name) parts.push(`name changed to "${edit.name}"`);
    if (edit.description) parts.push('description updated');
    if (edit.steps) parts.push(`${edit.steps.length} steps`);
    if (edit.inputs) parts.push(`${edit.inputs.length} inputs`);
    if (edit.outputs) parts.push(`${edit.outputs.length} outputs`);
    if (edit.config) parts.push('config updated');

    return parts.join(', ') || 'minor changes';
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultPlanner: Planner | null = null;

export function getDefaultPlanner(): Planner {
  if (!defaultPlanner) {
    defaultPlanner = new Planner();
  }
  return defaultPlanner;
}

export function setDefaultPlanner(planner: Planner): void {
  defaultPlanner = planner;
}

// ============================================================================
// Helper Functions
// ============================================================================

export async function startPlanningSession(): Promise<{
  session: PlanningSession;
  greeting: string;
}> {
  return getDefaultPlanner().startSession();
}

export async function sendPlannerMessage(
  sessionId: string,
  message: string
): Promise<PlannerResponse> {
  return getDefaultPlanner().sendMessage(sessionId, message);
}

export async function getPlannerSpec(
  sessionId: string
): Promise<Partial<WorkflowSpec> | undefined> {
  return getDefaultPlanner().getSpec(sessionId);
}

export async function completePlannerSession(
  sessionId: string
): Promise<{ session: PlanningSession; spec: Partial<WorkflowSpec> | undefined }> {
  return getDefaultPlanner().completeSession(sessionId);
}
