/**
 * FlowForge Retry Loop
 * Self-healing retry logic with exponential backoff and feedback integration
 */

import { Step, EvaluationResult, AttemptRecord } from '../core/types.js';
import { MaxRetriesExceededError } from '../core/errors.js';
import { Logger, createStepLogger } from '../utils/logger.js';

// ============================================================================
// Retry Types
// ============================================================================

export interface RetryConfig {
  /** Maximum number of retries */
  maxRetries: number;

  /** Initial delay between retries (ms) */
  initialDelay: number;

  /** Maximum delay between retries (ms) */
  maxDelay: number;

  /** Backoff multiplier */
  backoffMultiplier: number;

  /** Whether to add jitter to delays */
  jitter: boolean;

  /** Callback to check if error is retryable */
  isRetryable?: (error: Error) => boolean;
}

export interface RetryContext {
  step: Step;
  workflowId: string;
  executionId: string;
  attemptNumber: number;
  previousAttempts: AttemptRecord[];
  lastEvaluation?: EvaluationResult;
  lastError?: string;
}

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: string;
  attemptCount: number;
  attempts: AttemptRecord[];
}

export type StepExecutor<T> = (context: RetryContext, feedback?: string) => Promise<T>;

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  jitter: true,
};

// ============================================================================
// Retry Loop
// ============================================================================

export class RetryLoop {
  private config: RetryConfig;
  private logger: Logger;

  constructor(config?: Partial<RetryConfig>) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
    this.logger = createStepLogger('retry-loop', 'global', 'retry');
  }

  /**
   * Execute a step with retry logic
   */
  async execute<T>(
    executor: StepExecutor<T>,
    context: Omit<RetryContext, 'attemptNumber' | 'previousAttempts'>,
    options?: {
      onAttemptStart?: (attempt: number) => void;
      onAttemptComplete?: (attempt: number, success: boolean, result?: T, error?: string) => void;
      onRetry?: (attempt: number, delay: number, feedback?: string) => void;
    }
  ): Promise<RetryResult<T>> {
    const { step } = context;
    const maxRetries = step.maxRetries ?? this.config.maxRetries;
    const initialDelay = step.retryDelay ?? this.config.initialDelay;

    const attempts: AttemptRecord[] = [];
    let lastError: string | undefined;
    let lastEvaluation: EvaluationResult | undefined;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const attemptContext: RetryContext = {
        ...context,
        attemptNumber: attempt,
        previousAttempts: attempts,
        lastEvaluation,
        lastError,
      };

      const attemptStart = new Date().toISOString();
      options?.onAttemptStart?.(attempt);

      this.logger.debug(`Starting attempt ${attempt}/${maxRetries + 1}`, {
        stepId: step.id,
        workflowId: context.workflowId,
        executionId: context.executionId,
      });

      try {
        // Build feedback from previous attempt if available
        const feedback = this.buildRetryFeedback(attemptContext);

        // Execute the step
        const result = await executor(attemptContext, feedback);

        // Record successful attempt
        const attemptRecord: AttemptRecord = {
          attemptNumber: attempt,
          startedAt: attemptStart,
          completedAt: new Date().toISOString(),
          output: result,
        };
        attempts.push(attemptRecord);

        options?.onAttemptComplete?.(attempt, true, result);

        return {
          success: true,
          result,
          attemptCount: attempt,
          attempts,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        lastError = errorMessage;

        // Check if error includes evaluation result
        if (error instanceof EvaluationFailedError) {
          lastEvaluation = error.evaluation;
        }

        // Record failed attempt
        const attemptRecord: AttemptRecord = {
          attemptNumber: attempt,
          startedAt: attemptStart,
          completedAt: new Date().toISOString(),
          error: errorMessage,
          evaluation: lastEvaluation,
          retryFeedback: this.buildRetryFeedback(attemptContext),
        };
        attempts.push(attemptRecord);

        options?.onAttemptComplete?.(attempt, false, undefined, errorMessage);

        // Check if we should retry
        if (attempt > maxRetries) {
          this.logger.warn('Max retries exceeded', {
            stepId: step.id,
            attempts: attempt,
            lastError: errorMessage,
          });
          break;
        }

        // Check if error is retryable
        if (error instanceof Error && this.config.isRetryable && !this.config.isRetryable(error)) {
          this.logger.info('Error is not retryable', {
            stepId: step.id,
            error: errorMessage,
          });
          break;
        }

        // Calculate delay with backoff
        const delay = this.calculateDelay(attempt, initialDelay);
        options?.onRetry?.(attempt, delay, this.buildRetryFeedback(attemptContext));

        this.logger.debug(`Waiting ${delay}ms before retry`, {
          stepId: step.id,
          attempt,
          nextAttempt: attempt + 1,
        });

        await this.delay(delay);
      }
    }

    // All retries exhausted
    return {
      success: false,
      error: lastError || 'Unknown error',
      attemptCount: attempts.length,
      attempts,
    };
  }

  /**
   * Execute with evaluation-based retry
   * Retries until evaluation passes or max retries exceeded
   */
  async executeWithEvaluation<T>(
    executor: StepExecutor<T>,
    evaluator: (result: T) => Promise<EvaluationResult>,
    context: Omit<RetryContext, 'attemptNumber' | 'previousAttempts'>,
    options?: {
      onAttemptStart?: (attempt: number) => void;
      onAttemptComplete?: (attempt: number, result: T, evaluation: EvaluationResult) => void;
      onRetry?: (attempt: number, delay: number, evaluation: EvaluationResult) => void;
      shouldRetry?: (evaluation: EvaluationResult) => boolean;
    }
  ): Promise<RetryResult<T> & { finalEvaluation?: EvaluationResult }> {
    const { step } = context;
    const maxRetries = step.maxRetries ?? this.config.maxRetries;
    const initialDelay = step.retryDelay ?? this.config.initialDelay;

    const attempts: AttemptRecord[] = [];
    let lastEvaluation: EvaluationResult | undefined;
    let lastResult: T | undefined;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const attemptContext: RetryContext = {
        ...context,
        attemptNumber: attempt,
        previousAttempts: attempts,
        lastEvaluation,
      };

      const attemptStart = new Date().toISOString();
      options?.onAttemptStart?.(attempt);

      try {
        // Build feedback from previous evaluation
        const feedback = lastEvaluation
          ? this.buildEvaluationFeedback(lastEvaluation)
          : undefined;

        // Execute the step
        const result = await executor(attemptContext, feedback);
        lastResult = result;

        // Evaluate the result
        const evaluation = await evaluator(result);
        lastEvaluation = evaluation;

        // Record attempt
        const attemptRecord: AttemptRecord = {
          attemptNumber: attempt,
          startedAt: attemptStart,
          completedAt: new Date().toISOString(),
          output: result,
          evaluation,
        };
        attempts.push(attemptRecord);

        options?.onAttemptComplete?.(attempt, result, evaluation);

        // Check if evaluation passed
        if (evaluation.verdict === 'PASS') {
          return {
            success: true,
            result,
            attemptCount: attempt,
            attempts,
            finalEvaluation: evaluation,
          };
        }

        // Check if we should retry based on evaluation
        const shouldRetry = options?.shouldRetry
          ? options.shouldRetry(evaluation)
          : evaluation.verdict === 'PARTIAL' || evaluation.score >= 30;

        if (!shouldRetry || attempt > maxRetries) {
          this.logger.info('Not retrying based on evaluation', {
            stepId: step.id,
            verdict: evaluation.verdict,
            score: evaluation.score,
          });
          break;
        }

        // Calculate delay and retry
        const delay = this.calculateDelay(attempt, initialDelay);
        options?.onRetry?.(attempt, delay, evaluation);

        await this.delay(delay);
      } catch (error) {
        // Execution error (not evaluation failure)
        const errorMessage = error instanceof Error ? error.message : String(error);

        const attemptRecord: AttemptRecord = {
          attemptNumber: attempt,
          startedAt: attemptStart,
          completedAt: new Date().toISOString(),
          error: errorMessage,
        };
        attempts.push(attemptRecord);

        if (attempt > maxRetries) break;

        const delay = this.calculateDelay(attempt, initialDelay);
        await this.delay(delay);
      }
    }

    // Return best result even if not passing
    return {
      success: false,
      result: lastResult,
      error: lastEvaluation
        ? `Evaluation failed: ${lastEvaluation.feedback || lastEvaluation.verdict}`
        : 'Max retries exceeded',
      attemptCount: attempts.length,
      attempts,
      finalEvaluation: lastEvaluation,
    };
  }

  /**
   * Build feedback message from retry context
   */
  buildRetryFeedback(context: RetryContext): string | undefined {
    const parts: string[] = [];

    if (context.lastEvaluation) {
      parts.push(this.buildEvaluationFeedback(context.lastEvaluation));
    }

    if (context.lastError) {
      parts.push(`Previous error: ${context.lastError}`);
    }

    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }

  /**
   * Build feedback from evaluation result
   */
  buildEvaluationFeedback(evaluation: EvaluationResult): string {
    const parts: string[] = [];

    parts.push(`Previous attempt result: ${evaluation.verdict} (score: ${evaluation.score}/100)`);

    if (evaluation.feedback) {
      parts.push(`Feedback: ${evaluation.feedback}`);
    }

    if (evaluation.suggestion) {
      parts.push(`Suggestion: ${evaluation.suggestion}`);
    }

    // Include specific criteria that failed
    const failedCriteria = evaluation.criteriaResults.filter((c) => !c.met);
    if (failedCriteria.length > 0) {
      parts.push('Failed criteria:');
      for (const criterion of failedCriteria) {
        parts.push(`- ${criterion.criterion}: ${criterion.explanation}`);
      }
    }

    return parts.join('\n');
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private calculateDelay(attempt: number, baseDelay: number): number {
    // Exponential backoff
    const exponentialDelay = baseDelay * Math.pow(this.config.backoffMultiplier, attempt - 1);

    // Cap at max delay
    let delay = Math.min(exponentialDelay, this.config.maxDelay);

    // Add jitter (±25%)
    if (this.config.jitter) {
      const jitterRange = delay * 0.25;
      delay += (Math.random() - 0.5) * 2 * jitterRange;
    }

    return Math.round(delay);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Custom Error for Evaluation Failures
// ============================================================================

export class EvaluationFailedError extends Error {
  public readonly evaluation: EvaluationResult;

  constructor(evaluation: EvaluationResult) {
    super(`Evaluation failed: ${evaluation.feedback || evaluation.verdict}`);
    this.name = 'EvaluationFailedError';
    this.evaluation = evaluation;
    Object.setPrototypeOf(this, EvaluationFailedError.prototype);
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultRetryLoop: RetryLoop | null = null;

export function getDefaultRetryLoop(): RetryLoop {
  if (!defaultRetryLoop) {
    defaultRetryLoop = new RetryLoop();
  }
  return defaultRetryLoop;
}

export function setDefaultRetryLoop(loop: RetryLoop): void {
  defaultRetryLoop = loop;
}

// ============================================================================
// Helper Functions
// ============================================================================

export async function executeWithRetry<T>(
  executor: StepExecutor<T>,
  context: Omit<RetryContext, 'attemptNumber' | 'previousAttempts'>,
  config?: Partial<RetryConfig>
): Promise<RetryResult<T>> {
  const loop = config ? new RetryLoop(config) : getDefaultRetryLoop();
  return loop.execute(executor, context);
}

export function createRetryFeedback(evaluation: EvaluationResult): string {
  return getDefaultRetryLoop().buildEvaluationFeedback(evaluation);
}
