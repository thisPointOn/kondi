/**
 * FlowForge Evaluator
 * LLM-based output evaluation against success criteria
 */

import { EvaluationResult, EvaluationVerdict, CriterionResult, Step } from '../core/types.js';
import { StepEvaluationError } from '../core/errors.js';
import { providerRegistry } from '../providers/registry.js';
import { Logger, createStepLogger } from '../utils/logger.js';

// ============================================================================
// Evaluator Types
// ============================================================================

export interface EvaluatorConfig {
  /** Default model for evaluation */
  defaultModel?: string;

  /** Default provider for evaluation */
  defaultProvider?: string;

  /** Temperature for evaluation (lower = more consistent) */
  temperature?: number;

  /** Maximum tokens for evaluation response */
  maxTokens?: number;

  /** Custom evaluation prompt template */
  customPromptTemplate?: string;
}

export interface EvaluationInput {
  /** The step being evaluated */
  step: Step;

  /** The actual output produced */
  output: unknown;

  /** Workflow inputs for context */
  workflowInputs?: Record<string, unknown>;

  /** Previous step outputs for context */
  previousOutputs?: Record<string, unknown>;
}

// ============================================================================
// Default Evaluation Prompt
// ============================================================================

const DEFAULT_EVALUATION_PROMPT = `You are evaluating whether an LLM's output meets the specified success criteria.

## Task Description
{description}

## Success Criteria
{successCriteria}

## Actual Output
{actualOutput}

## Context (if relevant)
Workflow Inputs: {workflowInputs}
Previous Step Outputs: {previousOutputs}

---

Evaluate the output against each success criterion. Be strict but fair.

Respond with a JSON object in this exact format:
{
  "verdict": "PASS" | "FAIL" | "PARTIAL",
  "score": <number from 0 to 100>,
  "criteriaResults": [
    {
      "criterion": "<criterion text>",
      "met": true | false,
      "explanation": "<brief explanation>"
    }
  ],
  "feedback": "<specific feedback if not PASS>",
  "suggestion": "<what to try differently on retry>"
}

Important:
- PASS: All criteria fully met (score 90-100)
- PARTIAL: Some criteria met, output is usable but could be better (score 50-89)
- FAIL: Critical criteria not met, output is not acceptable (score 0-49)
- Be specific in feedback and suggestions
- Consider the intent behind the criteria, not just literal matching`;

// ============================================================================
// Evaluator
// ============================================================================

export class Evaluator {
  private config: EvaluatorConfig;
  private logger: Logger;

  constructor(config?: EvaluatorConfig) {
    this.config = {
      defaultModel: 'claude-3-5-sonnet-latest',
      defaultProvider: 'anthropic',
      temperature: 0.1,
      maxTokens: 1024,
      ...config,
    };
    this.logger = createStepLogger('evaluator', 'global', 'evaluator');
  }

  /**
   * Evaluate step output against success criteria
   */
  async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
    const { step, output } = input;

    // If no success criteria, auto-pass
    if (!step.successCriteria) {
      return this.createPassResult('No success criteria specified - auto-passing');
    }

    // Determine model to use
    const model = step.evaluationModel || this.config.defaultModel!;
    const provider = this.config.defaultProvider!;

    this.logger.debug('Starting evaluation', {
      stepId: step.id,
      model,
      provider,
    });

    const startTime = Date.now();

    try {
      // Build evaluation prompt
      const prompt = this.buildPrompt(input);

      // Call LLM for evaluation
      const result = await providerRegistry.complete(
        {
          model,
          messages: [{ role: 'user', content: prompt }],
          systemPrompt: 'You are an expert evaluator. Always respond with valid JSON.',
          temperature: this.config.temperature,
          maxTokens: this.config.maxTokens,
        },
        { preferredProvider: provider, context: 'evaluation' }
      );

      // Parse evaluation result
      const evaluation = this.parseEvaluationResponse(result.content, step.successCriteria);

      this.logger.info('Evaluation completed', {
        stepId: step.id,
        verdict: evaluation.verdict,
        score: evaluation.score,
        duration: Date.now() - startTime,
      });

      return evaluation;
    } catch (error) {
      this.logger.error('Evaluation failed', error, { stepId: step.id });

      // On evaluation failure, return a PARTIAL result with error info
      return {
        verdict: 'PARTIAL',
        score: 50,
        criteriaResults: [
          {
            criterion: 'Evaluation process',
            met: false,
            explanation: `Evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        feedback: 'Unable to fully evaluate output due to evaluation error',
        suggestion: 'Review output manually',
        evaluatedAt: new Date().toISOString(),
        evaluationModel: model,
      };
    }
  }

  /**
   * Quick check if output likely meets criteria (faster, less accurate)
   */
  async quickCheck(input: EvaluationInput): Promise<{ likely: boolean; confidence: number }> {
    const { step, output } = input;

    if (!step.successCriteria) {
      return { likely: true, confidence: 1.0 };
    }

    // Simple heuristic checks
    const outputStr = this.formatOutput(output);

    // Check output isn't empty
    if (!outputStr || outputStr.trim().length === 0) {
      return { likely: false, confidence: 0.9 };
    }

    // Check output isn't an error message
    const errorPatterns = ['error', 'failed', 'unable to', 'cannot', 'exception'];
    const hasErrorPattern = errorPatterns.some((p) =>
      outputStr.toLowerCase().includes(p)
    );

    if (hasErrorPattern && outputStr.length < 200) {
      return { likely: false, confidence: 0.7 };
    }

    // Check output has reasonable length
    if (outputStr.length < 10) {
      return { likely: false, confidence: 0.6 };
    }

    // Default: probably okay but uncertain
    return { likely: true, confidence: 0.5 };
  }

  /**
   * Create a passing evaluation result
   */
  createPassResult(reason: string): EvaluationResult {
    return {
      verdict: 'PASS',
      score: 100,
      criteriaResults: [
        {
          criterion: 'Auto-pass',
          met: true,
          explanation: reason,
        },
      ],
      evaluatedAt: new Date().toISOString(),
      evaluationModel: 'none',
    };
  }

  /**
   * Create a failing evaluation result
   */
  createFailResult(reason: string, suggestion?: string): EvaluationResult {
    return {
      verdict: 'FAIL',
      score: 0,
      criteriaResults: [
        {
          criterion: 'Evaluation',
          met: false,
          explanation: reason,
        },
      ],
      feedback: reason,
      suggestion,
      evaluatedAt: new Date().toISOString(),
      evaluationModel: 'none',
    };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private buildPrompt(input: EvaluationInput): string {
    const { step, output, workflowInputs, previousOutputs } = input;

    const template = this.config.customPromptTemplate || DEFAULT_EVALUATION_PROMPT;

    return template
      .replace('{description}', step.description || step.name)
      .replace('{successCriteria}', step.successCriteria || 'No criteria specified')
      .replace('{actualOutput}', this.formatOutput(output))
      .replace('{workflowInputs}', this.formatContext(workflowInputs))
      .replace('{previousOutputs}', this.formatContext(previousOutputs));
  }

  private formatOutput(output: unknown): string {
    if (output === null || output === undefined) {
      return '[No output]';
    }

    if (typeof output === 'string') {
      // Truncate very long outputs
      return output.length > 5000 ? output.slice(0, 5000) + '...[truncated]' : output;
    }

    const json = JSON.stringify(output, null, 2);
    return json.length > 5000 ? json.slice(0, 5000) + '...[truncated]' : json;
  }

  private formatContext(context?: Record<string, unknown>): string {
    if (!context || Object.keys(context).length === 0) {
      return '[None]';
    }

    const json = JSON.stringify(context, null, 2);
    return json.length > 1000 ? json.slice(0, 1000) + '...[truncated]' : json;
  }

  private parseEvaluationResponse(
    response: string,
    successCriteria: string
  ): EvaluationResult {
    const now = new Date().toISOString();

    try {
      // Extract JSON from response (handle markdown code blocks)
      let jsonStr = response;
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }

      // Try to find JSON object
      const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        jsonStr = objectMatch[0];
      }

      const parsed = JSON.parse(jsonStr);

      // Validate and normalize verdict
      const verdict = this.normalizeVerdict(parsed.verdict);
      const score = this.normalizeScore(parsed.score, verdict);

      // Normalize criteria results
      const criteriaResults: CriterionResult[] = Array.isArray(parsed.criteriaResults)
        ? parsed.criteriaResults.map((cr: unknown) => this.normalizeCriterionResult(cr))
        : this.createDefaultCriteriaResults(successCriteria, verdict);

      return {
        verdict,
        score,
        criteriaResults,
        feedback: typeof parsed.feedback === 'string' ? parsed.feedback : undefined,
        suggestion: typeof parsed.suggestion === 'string' ? parsed.suggestion : undefined,
        evaluatedAt: now,
        evaluationModel: this.config.defaultModel!,
      };
    } catch (error) {
      this.logger.warn('Failed to parse evaluation response', { error, response });

      // Fall back to heuristic evaluation
      return this.heuristicEvaluation(response, successCriteria);
    }
  }

  private normalizeVerdict(verdict: unknown): EvaluationVerdict {
    if (typeof verdict === 'string') {
      const upper = verdict.toUpperCase();
      if (upper === 'PASS' || upper === 'FAIL' || upper === 'PARTIAL') {
        return upper as EvaluationVerdict;
      }
    }
    return 'PARTIAL';
  }

  private normalizeScore(score: unknown, verdict: EvaluationVerdict): number {
    if (typeof score === 'number' && score >= 0 && score <= 100) {
      return Math.round(score);
    }

    // Default scores based on verdict
    switch (verdict) {
      case 'PASS':
        return 95;
      case 'PARTIAL':
        return 60;
      case 'FAIL':
        return 20;
    }
  }

  private normalizeCriterionResult(result: unknown): CriterionResult {
    if (typeof result !== 'object' || result === null) {
      return {
        criterion: 'Unknown',
        met: false,
        explanation: 'Invalid criterion result',
      };
    }

    const obj = result as Record<string, unknown>;

    return {
      criterion: typeof obj.criterion === 'string' ? obj.criterion : 'Unknown',
      met: obj.met === true,
      explanation: typeof obj.explanation === 'string' ? obj.explanation : 'No explanation',
    };
  }

  private createDefaultCriteriaResults(
    successCriteria: string,
    verdict: EvaluationVerdict
  ): CriterionResult[] {
    // Split criteria by newlines or bullet points
    const criteria = successCriteria
      .split(/\n|•|•|-/)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    if (criteria.length === 0) {
      return [
        {
          criterion: successCriteria,
          met: verdict === 'PASS',
          explanation: `Overall verdict: ${verdict}`,
        },
      ];
    }

    return criteria.map((criterion) => ({
      criterion,
      met: verdict === 'PASS',
      explanation: `Based on overall evaluation`,
    }));
  }

  private heuristicEvaluation(
    response: string,
    successCriteria: string
  ): EvaluationResult {
    const lower = response.toLowerCase();
    let verdict: EvaluationVerdict = 'PARTIAL';
    let score = 50;

    // Simple keyword analysis
    if (lower.includes('pass') && !lower.includes('fail')) {
      verdict = 'PASS';
      score = 90;
    } else if (lower.includes('fail') && !lower.includes('pass')) {
      verdict = 'FAIL';
      score = 25;
    }

    return {
      verdict,
      score,
      criteriaResults: [
        {
          criterion: successCriteria,
          met: verdict === 'PASS',
          explanation: 'Determined from heuristic analysis of evaluation response',
        },
      ],
      feedback: verdict !== 'PASS' ? 'Review output manually for detailed feedback' : undefined,
      evaluatedAt: new Date().toISOString(),
      evaluationModel: this.config.defaultModel!,
    };
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultEvaluator: Evaluator | null = null;

export function getDefaultEvaluator(): Evaluator {
  if (!defaultEvaluator) {
    defaultEvaluator = new Evaluator();
  }
  return defaultEvaluator;
}

export function setDefaultEvaluator(evaluator: Evaluator): void {
  defaultEvaluator = evaluator;
}

// ============================================================================
// Helper Functions
// ============================================================================

export async function evaluateStepOutput(input: EvaluationInput): Promise<EvaluationResult> {
  return getDefaultEvaluator().evaluate(input);
}

export function isPassingResult(result: EvaluationResult): boolean {
  return result.verdict === 'PASS';
}

export function isRetryableResult(result: EvaluationResult): boolean {
  return result.verdict !== 'PASS' && (result.verdict === 'PARTIAL' || result.score >= 30);
}

export function getImprovementSuggestion(result: EvaluationResult): string | undefined {
  return result.suggestion || result.feedback;
}
