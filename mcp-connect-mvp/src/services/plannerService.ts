/**
 * Planner Service
 * Connects to LLM for interactive workflow planning
 * Supports multiple LLM providers
 */

import { anthropicClient } from './anthropicClient';
import { openaiClient } from './openaiClient';
import type { Message } from '../types/mcp';

// ============================================================================
// Types
// ============================================================================

export interface PlanningMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  specUpdate?: Partial<WorkflowSpec>;
}

export interface WorkflowSpec {
  name?: string;
  description?: string;
  inputs?: Array<{
    name: string;
    type: string;
    description?: string;
    required?: boolean;
  }>;
  outputs?: Array<{
    name: string;
    type: string;
    description?: string;
    fromStep?: string;
  }>;
  steps?: Array<WorkflowStep>;
  config?: {
    defaultProvider?: string;
    defaultModel?: string;
    maxRetries?: number;
    timeout?: number;
  };
  status?: 'draft' | 'ready';
}

export interface WorkflowStep {
  id: string;
  name: string;
  type: 'llm' | 'tool' | 'human' | 'conditional' | 'parallel';
  description?: string;
  config?: Record<string, unknown>;
  successCriteria?: string;
  maxRetries?: number;
  blockedBy?: string[];
  inputs?: Array<{ name: string; source: unknown }>;
  outputs?: Array<{ name: string; path?: string }>;
}

export interface PlanningSession {
  id: string;
  messages: PlanningMessage[];
  currentSpec?: Partial<WorkflowSpec>;
  status: 'active' | 'completed' | 'abandoned';
  createdAt: string;
  updatedAt: string;
  provider: 'anthropic' | 'openai';
  model: string;
}

export interface PlannerResponse {
  message: string;
  specUpdate?: Partial<WorkflowSpec>;
  isComplete?: boolean;
  /** The provider that generated this response */
  provider: 'anthropic' | 'openai';
  /** The model that generated this response */
  model: string;
}

// ============================================================================
// System Prompt
// ============================================================================

const PLANNING_SYSTEM_PROMPT = `You are a workflow planning assistant helping users create automated workflows.

Your job is to:
1. Understand the user's goal thoroughly before proposing solutions
2. Ask clarifying questions ONE at a time to understand:
   - What is the input data and its scale?
   - What is the desired output/end state?
   - What are the constraints (time, cost, accuracy)?
   - What tools or services are available?
3. Once you understand the problem, propose a workflow with clear steps
4. Refine based on feedback until the user is satisfied

CRITICAL RULES:
- NEVER re-ask a question that has already been answered in the conversation
- ALWAYS read the full conversation history before responding
- If information was already provided, acknowledge it and use it - don't ask for it again
- Keep track of what you know: input data, output goals, constraints, tools mentioned
- If you're unsure whether something was answered, summarize what you know and ask if it's correct

IMPORTANT: Do NOT assume what the user wants. Listen carefully to their description and ask relevant questions about THEIR specific use case. Never default to generic templates.

Guidelines:
- Keep steps atomic and clear
- Write success criteria that are specific and testable
- Identify where human approval might be needed
- Consider what could go wrong and how to handle it
- For large-scale data processing, consider batching and parallelization

When you're ready to propose a workflow, output it in JSON format wrapped in \`\`\`json code blocks:

\`\`\`json
{
  "name": "Workflow Name",
  "description": "Clear description of what this workflow does",
  "inputs": [
    {
      "name": "input_name",
      "type": "string",
      "description": "What this input is for",
      "required": true
    }
  ],
  "outputs": [
    {
      "name": "output_name",
      "type": "string",
      "description": "What this output contains",
      "fromStep": "step_id"
    }
  ],
  "steps": [
    {
      "id": "step_1",
      "name": "Step Name",
      "type": "llm",
      "description": "What this step does",
      "config": {
        "provider": "anthropic",
        "model": "claude-3-5-sonnet-latest",
        "systemPrompt": "You are...",
        "userPrompt": "Process the following: {input_name}"
      },
      "successCriteria": "The output should contain...",
      "maxRetries": 2
    }
  ]
}
\`\`\`

Step types available:
- "llm": Uses an LLM to generate content or process information
- "tool": Executes an MCP tool (requires serverId and toolName in config)
- "human": Requires human input or approval
- "conditional": Branches based on conditions
- "parallel": Runs multiple steps in parallel

Always explain your reasoning when proposing workflows.
Ask the user if they want to make any changes before finalizing.`;

// ============================================================================
// Planner Service
// ============================================================================

class PlannerService {
  private sessions: Map<string, PlanningSession> = new Map();

  /**
   * Start a new planning session
   */
  async startSession(
    provider: 'anthropic' | 'openai' = 'anthropic',
    model?: string
  ): Promise<{ session: PlanningSession; greeting: string }> {
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Default models per provider - use best available
    const defaultModel = model || (provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-5.2-codex');

    const session: PlanningSession = {
      id: sessionId,
      messages: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
      provider,
      model: defaultModel,
    };

    this.sessions.set(sessionId, session);

    const greeting = `Hello! I'm your workflow planning assistant. I'll help you design automated workflows tailored to your specific needs.

Tell me what you'd like to automate - describe your use case, the data involved, and what outcome you're looking for. I'll ask clarifying questions to make sure I understand before proposing a solution.`;

    console.log('[Planner] Session started:', sessionId, 'provider:', provider, 'model:', defaultModel);

    return { session, greeting };
  }

  /**
   * Send a message to the planner
   */
  async sendMessage(sessionId: string, userMessage: string): Promise<PlannerResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.status !== 'active') {
      throw new Error(`Session is ${session.status}`);
    }

    // Add user message
    const userMsg: PlanningMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userMessage,
      timestamp: new Date().toISOString(),
    };
    session.messages.push(userMsg);

    console.log('[Planner] User message:', userMessage.slice(0, 100) + '...');

    // Build messages for LLM
    const llmMessages = this.buildLLMMessages(session);

    try {
      // Call appropriate LLM based on provider
      let assistantContent: string;

      // No MCP tools available in planning mode
      const emptyTools = new Map();

      if (session.provider === 'openai') {
        const authMode = openaiClient.getAuthMethod();
        console.log('[Planner] OpenAI auth mode:', authMode);

        const response = await openaiClient.chat(
          llmMessages,
          emptyTools,
          session.model,
          PLANNING_SYSTEM_PROMPT
        );
        assistantContent = response.message.content;
      } else {
        const authMode = anthropicClient.getAuthMethod();
        console.log('[Planner] Anthropic auth mode:', authMode);

        const response = await anthropicClient.chat(
          llmMessages,
          emptyTools,
          session.model,
          undefined, // serverSummary
          PLANNING_SYSTEM_PROMPT
        );
        assistantContent = response.message.content;
      }

      // Extract spec from response if present
      const specUpdate = this.extractSpec(assistantContent);

      // Add assistant message
      const assistantMsg: PlanningMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: assistantContent,
        timestamp: new Date().toISOString(),
        specUpdate,
      };
      session.messages.push(assistantMsg);

      // Update current spec if we found one
      if (specUpdate) {
        session.currentSpec = this.mergeSpec(session.currentSpec, specUpdate);
      }

      session.updatedAt = new Date().toISOString();

      // Check if workflow is complete
      const isComplete = this.checkCompletion(session.currentSpec);

      console.log('[Planner] Response generated, hasSpec:', !!specUpdate, 'isComplete:', isComplete);

      return {
        message: assistantContent,
        specUpdate: session.currentSpec,
        isComplete,
        provider: session.provider,
        model: session.model,
      };
    } catch (error) {
      console.error('[Planner] LLM call failed:', error);
      throw error;
    }
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): PlanningSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get the current spec for a session
   */
  getSpec(sessionId: string): Partial<WorkflowSpec> | undefined {
    return this.sessions.get(sessionId)?.currentSpec;
  }

  /**
   * Get session history
   */
  getHistory(sessionId: string): PlanningMessage[] {
    return this.sessions.get(sessionId)?.messages || [];
  }

  /**
   * Apply a direct edit to the spec
   */
  applyEdit(sessionId: string, specEdit: Partial<WorkflowSpec>): Partial<WorkflowSpec> | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    session.currentSpec = this.mergeSpec(session.currentSpec, specEdit);
    session.updatedAt = new Date().toISOString();

    return session.currentSpec;
  }

  /**
   * Complete the session
   */
  completeSession(sessionId: string): { session: PlanningSession; spec: Partial<WorkflowSpec> | undefined } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.status = 'completed';
    session.updatedAt = new Date().toISOString();

    console.log('[Planner] Session completed:', sessionId);

    return { session, spec: session.currentSpec };
  }

  /**
   * Abandon the session
   */
  abandonSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = 'abandoned';
      session.updatedAt = new Date().toISOString();
    }
    console.log('[Planner] Session abandoned:', sessionId);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private buildLLMMessages(session: PlanningSession): Message[] {
    const messages: Message[] = [];

    // Add context summary at the start if we have any info established
    const contextSummary = this.buildContextSummary(session);
    if (contextSummary) {
      messages.push({
        id: 'context-summary',
        role: 'user',
        content: contextSummary,
        timestamp: new Date(session.createdAt),
      });
      messages.push({
        id: 'context-ack',
        role: 'assistant',
        content: 'I understand. I have the context from our conversation and will continue from where we left off.',
        timestamp: new Date(session.createdAt),
      });
    }

    // Add all conversation messages
    for (const msg of session.messages) {
      if (msg.role === 'system') continue;
      messages.push({
        id: msg.id,
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
        timestamp: new Date(msg.timestamp),
      });
    }

    return messages;
  }

  /**
   * Build a summary of established context to prevent re-asking questions
   */
  private buildContextSummary(session: PlanningSession): string | null {
    const facts: string[] = [];

    // Extract key information from the current spec
    if (session.currentSpec) {
      if (session.currentSpec.name) {
        facts.push(`Workflow name: "${session.currentSpec.name}"`);
      }
      if (session.currentSpec.description) {
        facts.push(`Description: ${session.currentSpec.description}`);
      }
      if (session.currentSpec.inputs && session.currentSpec.inputs.length > 0) {
        facts.push(`Inputs defined: ${session.currentSpec.inputs.map(i => i.name).join(', ')}`);
      }
      if (session.currentSpec.outputs && session.currentSpec.outputs.length > 0) {
        facts.push(`Outputs defined: ${session.currentSpec.outputs.map(o => o.name).join(', ')}`);
      }
      if (session.currentSpec.steps && session.currentSpec.steps.length > 0) {
        facts.push(`Steps defined (${session.currentSpec.steps.length}): ${session.currentSpec.steps.map(s => s.name).join(', ')}`);
      }
    }

    // Scan messages for key information patterns
    for (const msg of session.messages) {
      if (msg.role !== 'user') continue;

      // Look for data source mentions
      if (/spreadsheet|csv|excel|google sheets/i.test(msg.content)) {
        facts.push(`Data source mentioned: spreadsheet/CSV`);
      }
      if (/database|sql|postgres|mysql/i.test(msg.content)) {
        facts.push(`Data source mentioned: database`);
      }
      if (/api|endpoint|rest/i.test(msg.content)) {
        facts.push(`Data source mentioned: API`);
      }

      // Look for scale mentions
      const scaleMatch = msg.content.match(/(\d+(?:,\d+)*(?:\.\d+)?)\s*(?:rows?|records?|items?|entries|leads?|contacts?)/i);
      if (scaleMatch) {
        facts.push(`Scale mentioned: ${scaleMatch[0]}`);
      }
    }

    if (facts.length === 0) return null;

    return `[CONTEXT - Information already established in this conversation. DO NOT re-ask about these topics:]
${facts.map(f => `• ${f}`).join('\n')}

Continue the conversation naturally, building on this context.`;
  }

  private extractSpec(content: string): Partial<WorkflowSpec> | undefined {
    // Look for JSON code blocks
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
    if (!jsonMatch) return undefined;

    try {
      const parsed = JSON.parse(jsonMatch[1]);

      // Validate it looks like a workflow spec
      if (parsed.name || parsed.steps || parsed.description) {
        return parsed as Partial<WorkflowSpec>;
      }
    } catch (e) {
      console.warn('[Planner] Failed to parse JSON from response:', e);
    }

    return undefined;
  }

  private mergeSpec(
    existing: Partial<WorkflowSpec> | undefined,
    update: Partial<WorkflowSpec>
  ): Partial<WorkflowSpec> {
    if (!existing) return update;

    return {
      ...existing,
      ...update,
      // Merge arrays intelligently
      inputs: update.inputs || existing.inputs,
      outputs: update.outputs || existing.outputs,
      steps: update.steps || existing.steps,
      config: { ...existing.config, ...update.config },
    };
  }

  private checkCompletion(spec: Partial<WorkflowSpec> | undefined): boolean {
    if (!spec) return false;

    return !!(
      spec.name &&
      spec.description &&
      spec.steps &&
      spec.steps.length > 0 &&
      spec.steps.every(s => s.name && s.type && s.description)
    );
  }
}

// ============================================================================
// Export Singleton
// ============================================================================

export const plannerService = new PlannerService();
