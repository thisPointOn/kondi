/**
 * FlowForge Step Runner
 * Executes individual workflow steps
 */

import {
  Step,
  StepType,
  WorkflowSpec,
  WorkflowState,
  StepInput,
  InputSource,
  EvaluationResult,
} from '../core/types.js';
import {
  StepExecutionError,
  StepTimeoutError,
  ToolNotFoundError,
  ApprovalRequiredError,
} from '../core/errors.js';
import { providerRegistry } from '../providers/registry.js';
import { ToolBridge, getDefaultToolBridge } from './tool-bridge.js';
import { Evaluator, getDefaultEvaluator } from './evaluator.js';
import { RetryLoop, RetryContext, getDefaultRetryLoop } from './retry-loop.js';
import { Logger, createStepLogger } from '../utils/logger.js';

// ============================================================================
// Step Runner Types
// ============================================================================

export interface StepRunnerConfig {
  /** Tool bridge for MCP tool execution */
  toolBridge?: ToolBridge;

  /** Evaluator for output evaluation */
  evaluator?: Evaluator;

  /** Retry loop for retry logic */
  retryLoop?: RetryLoop;

  /** Default timeout for steps (ms) */
  defaultTimeout?: number;

  /** Whether to evaluate outputs by default */
  evaluateByDefault?: boolean;
}

export interface StepExecutionContext {
  workflow: WorkflowSpec;
  state: WorkflowState;
  step: Step;
  workflowInputs: Record<string, unknown>;
  stepOutputs: Record<string, unknown>;
  attemptNumber: number;
  retryFeedback?: string;
}

export interface StepExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  evaluation?: EvaluationResult;
  requiresApproval?: boolean;
  approvalMessage?: string;
}

// ============================================================================
// Step Runner
// ============================================================================

export class StepRunner {
  private config: StepRunnerConfig;
  private toolBridge: ToolBridge;
  private evaluator: Evaluator;
  private retryLoop: RetryLoop;
  private logger: Logger;

  // Approval callbacks
  private approvalCallbacks: Map<string, (approved: boolean, output?: unknown) => void> =
    new Map();

  constructor(config?: StepRunnerConfig) {
    this.config = {
      defaultTimeout: 30000,
      evaluateByDefault: true,
      ...config,
    };
    this.toolBridge = config?.toolBridge || getDefaultToolBridge();
    this.evaluator = config?.evaluator || getDefaultEvaluator();
    this.retryLoop = config?.retryLoop || getDefaultRetryLoop();
    this.logger = createStepLogger('step-runner', 'global', 'runner');
  }

  /**
   * Execute a step
   */
  async executeStep(context: StepExecutionContext): Promise<StepExecutionResult> {
    const { step, workflow, state } = context;
    const timeout = step.timeout ?? this.config.defaultTimeout;

    this.logger.info(`Executing step: ${step.name}`, {
      stepId: step.id,
      stepType: step.type,
      workflowId: workflow.id,
      executionId: state.executionId,
      attemptNumber: context.attemptNumber,
    });

    try {
      // Check condition
      if (step.condition && !this.evaluateCondition(step.condition, context)) {
        return {
          success: true,
          output: null,
        };
      }

      // Check approval requirement
      if (step.requiresApproval && context.attemptNumber === 1) {
        return {
          success: false,
          requiresApproval: true,
          approvalMessage: step.approvalMessage || `Approval required for step: ${step.name}`,
        };
      }

      // Execute based on step type
      let result: StepExecutionResult;

      if (timeout) {
        result = await Promise.race([
          this.executeByType(context),
          this.createTimeout(timeout, step.id),
        ]);
      } else {
        result = await this.executeByType(context);
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(`Step execution failed: ${step.name}`, error, {
        stepId: step.id,
        workflowId: workflow.id,
        executionId: state.executionId,
      });

      return {
        success: false,
        error: message,
      };
    }
  }

  /**
   * Execute step with retry and evaluation
   */
  async executeStepWithRetry(
    context: Omit<StepExecutionContext, 'attemptNumber' | 'retryFeedback'>,
    options?: {
      onAttemptStart?: (attempt: number) => void;
      onAttemptComplete?: (
        attempt: number,
        result: StepExecutionResult
      ) => void;
      onRetry?: (attempt: number, delay: number, feedback?: string) => void;
    }
  ): Promise<StepExecutionResult & { attemptCount: number }> {
    const { step, workflow, state } = context;

    const retryResult = await this.retryLoop.executeWithEvaluation(
      async (retryCtx: RetryContext, feedback?: string): Promise<unknown> => {
        const result = await this.executeStep({
          ...context,
          attemptNumber: retryCtx.attemptNumber,
          retryFeedback: feedback,
        });

        if (!result.success) {
          throw new StepExecutionError(step.id, retryCtx.attemptNumber, result.error || 'Unknown error');
        }

        if (result.requiresApproval) {
          throw new ApprovalRequiredError(step.id, result.approvalMessage || 'Approval required');
        }

        return result.output;
      },
      async (output: unknown): Promise<EvaluationResult> => {
        if (!step.successCriteria) {
          return this.evaluator.createPassResult('No success criteria');
        }

        return this.evaluator.evaluate({
          step,
          output,
          workflowInputs: context.workflowInputs,
          previousOutputs: context.stepOutputs,
        });
      },
      {
        step,
        workflowId: workflow.id,
        executionId: state.executionId,
      },
      {
        onAttemptStart: options?.onAttemptStart,
        onAttemptComplete: (attempt, result, evaluation) => {
          options?.onAttemptComplete?.(attempt, {
            success: evaluation.verdict === 'PASS',
            output: result,
            evaluation,
          });
        },
        onRetry: options?.onRetry,
      }
    );

    return {
      success: retryResult.success,
      output: retryResult.result,
      error: retryResult.error,
      evaluation: retryResult.finalEvaluation,
      attemptCount: retryResult.attemptCount,
    };
  }

  /**
   * Handle step approval
   */
  async waitForApproval(
    stepId: string,
    timeout?: number
  ): Promise<{ approved: boolean; output?: unknown }> {
    return new Promise((resolve) => {
      this.approvalCallbacks.set(stepId, (approved, output) => {
        this.approvalCallbacks.delete(stepId);
        resolve({ approved, output });
      });

      if (timeout) {
        setTimeout(() => {
          if (this.approvalCallbacks.has(stepId)) {
            this.approvalCallbacks.delete(stepId);
            resolve({ approved: false });
          }
        }, timeout);
      }
    });
  }

  /**
   * Provide approval for a step
   */
  approveStep(stepId: string, approved: boolean, output?: unknown): void {
    const callback = this.approvalCallbacks.get(stepId);
    if (callback) {
      callback(approved, output);
    }
  }

  // ============================================================================
  // Private Methods - Step Type Execution
  // ============================================================================

  private async executeByType(context: StepExecutionContext): Promise<StepExecutionResult> {
    const { step } = context;

    switch (step.type) {
      case 'llm':
        return this.executeLLMStep(context);
      case 'tool':
        return this.executeToolStep(context);
      case 'human':
        return this.executeHumanStep(context);
      case 'conditional':
        return this.executeConditionalStep(context);
      case 'parallel':
        return this.executeParallelStep(context);
      default:
        throw new StepExecutionError(
          step.id,
          context.attemptNumber,
          `Unknown step type: ${step.type}`
        );
    }
  }

  private async executeLLMStep(context: StepExecutionContext): Promise<StepExecutionResult> {
    const { step, workflow, retryFeedback } = context;
    const config = step.config;

    // Resolve inputs
    const inputValues = this.resolveInputs(step.inputs || [], context);

    // Build prompt
    let userPrompt = config.userPrompt || '';

    // Inject input values into prompt
    for (const [name, value] of Object.entries(inputValues)) {
      userPrompt = userPrompt.replace(
        new RegExp(`\\{${name}\\}`, 'g'),
        String(value)
      );
    }

    // Add retry feedback if available
    if (retryFeedback) {
      userPrompt = `${userPrompt}\n\n--- FEEDBACK FROM PREVIOUS ATTEMPT ---\n${retryFeedback}\n\nPlease address the feedback above and try again.`;
    }

    // Get provider and model
    const provider = config.provider || workflow.config.defaultProvider;
    const model = config.model || workflow.config.defaultModel;

    try {
      const result = await providerRegistry.complete(
        {
          model,
          messages: [{ role: 'user', content: userPrompt }],
          systemPrompt: config.systemPrompt,
          temperature: config.temperature,
          maxTokens: config.maxTokens,
        },
        { preferredProvider: provider }
      );

      return {
        success: true,
        output: result.content,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async executeToolStep(context: StepExecutionContext): Promise<StepExecutionResult> {
    const { step, workflow, state } = context;
    const config = step.config;

    if (!config.serverId || !config.toolName) {
      return {
        success: false,
        error: 'Tool step requires serverId and toolName',
      };
    }

    // Resolve input values
    const inputValues = this.resolveInputs(step.inputs || [], context);

    // Merge with configured arguments
    const args = {
      ...config.toolArguments,
      ...inputValues,
    };

    const result = await this.toolBridge.executeTool(
      config.serverId,
      config.toolName,
      args,
      {
        workflowId: workflow.id,
        executionId: state.executionId,
        stepId: step.id,
        timeout: step.timeout,
      }
    );

    if (result.success) {
      return {
        success: true,
        output: this.toolBridge.formatToolOutput(result.output),
      };
    } else {
      return {
        success: false,
        error: result.error,
      };
    }
  }

  private async executeHumanStep(context: StepExecutionContext): Promise<StepExecutionResult> {
    const { step } = context;

    // Human steps always require approval
    return {
      success: false,
      requiresApproval: true,
      approvalMessage: step.config.prompt || `Human input required: ${step.name}`,
    };
  }

  private async executeConditionalStep(
    context: StepExecutionContext
  ): Promise<StepExecutionResult> {
    const { step } = context;
    const branches = step.config.branches || [];

    for (const branch of branches) {
      // Evaluate branch condition
      const conditionMet = this.evaluateExpression(branch.condition, context);
      if (conditionMet) {
        return {
          success: true,
          output: { selectedBranch: branch.stepId },
        };
      }
    }

    // No branch matched
    return {
      success: true,
      output: { selectedBranch: null },
    };
  }

  private async executeParallelStep(
    context: StepExecutionContext
  ): Promise<StepExecutionResult> {
    // Parallel steps are handled by the main executor
    // This just marks which steps should run in parallel
    const { step } = context;

    return {
      success: true,
      output: {
        parallelSteps: step.config.parallelSteps || [],
        agentCount: step.config.agentCount,
      },
    };
  }

  // ============================================================================
  // Private Methods - Utilities
  // ============================================================================

  private resolveInputs(
    inputs: StepInput[],
    context: StepExecutionContext
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const input of inputs) {
      resolved[input.name] = this.resolveInputSource(input.source, context);
    }

    return resolved;
  }

  private resolveInputSource(source: InputSource, context: StepExecutionContext): unknown {
    switch (source.type) {
      case 'workflow_input':
        return context.workflowInputs[source.name];

      case 'step_output':
        return context.stepOutputs[source.stepId];

      case 'literal':
        return source.value;

      case 'template':
        return this.resolveTemplate(source.template, context);

      default:
        return undefined;
    }
  }

  private resolveTemplate(template: string, context: StepExecutionContext): string {
    let result = template;

    // Replace workflow inputs
    for (const [key, value] of Object.entries(context.workflowInputs)) {
      result = result.replace(
        new RegExp(`\\{\\{inputs\\.${key}\\}\\}`, 'g'),
        String(value)
      );
    }

    // Replace step outputs
    for (const [stepId, value] of Object.entries(context.stepOutputs)) {
      result = result.replace(
        new RegExp(`\\{\\{steps\\.${stepId}\\.output\\}\\}`, 'g'),
        String(value)
      );
    }

    return result;
  }

  private evaluateCondition(
    condition: Step['condition'],
    context: StepExecutionContext
  ): boolean {
    if (!condition) return true;

    switch (condition.type) {
      case 'expression':
        return this.evaluateExpression(condition.expression || 'true', context);

      case 'step_status':
        if (!condition.stepId) return true;
        const stepState = context.state.steps[condition.stepId];
        return stepState?.status === condition.status;

      case 'input_value':
        if (!condition.inputName) return true;
        const inputValue = context.workflowInputs[condition.inputName];
        return this.compareValues(inputValue, condition.value, condition.operator);

      default:
        return true;
    }
  }

  private evaluateExpression(expression: string, context: StepExecutionContext): boolean {
    // Simple expression evaluation
    // In production, use a proper expression parser

    try {
      // Replace variables with values
      let expr = expression;

      for (const [key, value] of Object.entries(context.workflowInputs)) {
        expr = expr.replace(
          new RegExp(`inputs\\.${key}`, 'g'),
          JSON.stringify(value)
        );
      }

      for (const [stepId, value] of Object.entries(context.stepOutputs)) {
        expr = expr.replace(
          new RegExp(`steps\\.${stepId}\\.output`, 'g'),
          JSON.stringify(value)
        );
      }

      // Simple boolean evaluation (very limited - use proper parser in production)
      if (expr === 'true') return true;
      if (expr === 'false') return false;

      // Try to evaluate simple comparisons
      const compareMatch = expr.match(/(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)/);
      if (compareMatch) {
        const [, left, op, right] = compareMatch;
        const leftVal = JSON.parse(left.trim());
        const rightVal = JSON.parse(right.trim());

        switch (op) {
          case '===':
          case '==':
            return leftVal === rightVal;
          case '!==':
          case '!=':
            return leftVal !== rightVal;
          case '>':
            return leftVal > rightVal;
          case '<':
            return leftVal < rightVal;
          case '>=':
            return leftVal >= rightVal;
          case '<=':
            return leftVal <= rightVal;
        }
      }

      return true;
    } catch {
      return true; // Default to true on parse error
    }
  }

  private compareValues(
    actual: unknown,
    expected: unknown,
    operator?: string
  ): boolean {
    switch (operator) {
      case 'eq':
        return actual === expected;
      case 'neq':
        return actual !== expected;
      case 'gt':
        return Number(actual) > Number(expected);
      case 'lt':
        return Number(actual) < Number(expected);
      case 'gte':
        return Number(actual) >= Number(expected);
      case 'lte':
        return Number(actual) <= Number(expected);
      case 'contains':
        return String(actual).includes(String(expected));
      case 'exists':
        return actual !== undefined && actual !== null;
      default:
        return actual === expected;
    }
  }

  private createTimeout(ms: number, stepId: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new StepTimeoutError(stepId, ms));
      }, ms);
    });
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultRunner: StepRunner | null = null;

export function getDefaultStepRunner(): StepRunner {
  if (!defaultRunner) {
    defaultRunner = new StepRunner();
  }
  return defaultRunner;
}

export function setDefaultStepRunner(runner: StepRunner): void {
  defaultRunner = runner;
}
