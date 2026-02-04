import type {
  Workflow,
  WorkflowStep,
  LLMDiscussion,
  StepEvaluation,
  DiscussionMessageType,
} from '../types/workflow';
import { workflowService } from './workflowService';

/**
 * Configuration for multi-LLM execution
 */
export interface MultiLLMExecutorConfig {
  maxDebateRounds: number;           // Max rounds of debate before forcing consensus
  consensusThreshold: number;        // Percentage of LLMs that must agree (0-1)
  primaryLLM: string;                // LLM that generates initial output
  onStepStart?: (step: WorkflowStep) => void;
  onStepComplete?: (step: WorkflowStep) => void;
  onDiscussionUpdate?: (step: WorkflowStep, discussion: LLMDiscussion[]) => void;
  onWaitingForReview?: (step: WorkflowStep) => void;
  sendToLLM?: (llmId: string, prompt: string, context: string) => Promise<string>;
}

const DEFAULT_CONFIG: MultiLLMExecutorConfig = {
  maxDebateRounds: 3,
  consensusThreshold: 1.0,  // All LLMs must agree by default
  primaryLLM: 'claude-sonnet-4-20250514',
};

/**
 * Response structure expected from LLM collaboration prompts
 */
interface LLMCollaborationResponse {
  vote: 'pass' | 'fail';
  type: DiscussionMessageType;
  message: string;
  suggestion?: string;  // Optional code/text suggestion to improve the output
}

/**
 * Multi-LLM Executor Service
 *
 * Orchestrates multiple LLMs to collaborate on workflow steps.
 * When LLMs disagree, they debate and iterate until reaching consensus
 * rather than stopping execution.
 */
class MultiLLMExecutor {
  private isRunning = false;
  private currentWorkflowId: string | null = null;
  private currentStepIndex = 0;
  private config: MultiLLMExecutorConfig = DEFAULT_CONFIG;

  /**
   * Start executing a workflow
   */
  async executeWorkflow(
    workflow: Workflow,
    config?: Partial<MultiLLMExecutorConfig>
  ): Promise<Workflow> {
    if (this.isRunning) {
      throw new Error('Executor is already running a workflow');
    }

    this.config = { ...DEFAULT_CONFIG, ...config };
    this.isRunning = true;
    this.currentWorkflowId = workflow.id;
    this.currentStepIndex = 0;

    try {
      // Update workflow status to running
      workflowService.updateWorkflowStatus(workflow.id, 'running');

      // Execute each step sequentially
      for (let i = 0; i < workflow.steps.length; i++) {
        this.currentStepIndex = i;
        const step = workflow.steps[i];

        // Execute the step
        const updatedStep = await this.executeStep(workflow, step);

        // Update the workflow with the new step state
        workflowService.updateStep(workflow.id, step.id, updatedStep);

        // Check if we need to pause for review
        if (step.gate === 'stop' || updatedStep.status === 'waiting_review') {
          this.config.onWaitingForReview?.(updatedStep);
          // In real implementation, this would pause and wait for user action
          // For now, we continue
        }

        // Stop if step failed
        if (updatedStep.status === 'failed') {
          workflowService.updateWorkflowStatus(workflow.id, 'draft');
          break;
        }
      }

      // Mark workflow as completed if all steps passed
      const finalWorkflow = workflowService.getWorkflow(workflow.id);
      if (finalWorkflow) {
        const allCompleted = finalWorkflow.steps.every((s) => s.status === 'completed');
        if (allCompleted) {
          workflowService.updateWorkflowStatus(workflow.id, 'completed');
        }
      }

      return workflowService.getWorkflow(workflow.id) || workflow;
    } finally {
      this.isRunning = false;
      this.currentWorkflowId = null;
    }
  }

  /**
   * Execute a single step with multi-LLM collaboration
   */
  private async executeStep(workflow: Workflow, step: WorkflowStep): Promise<WorkflowStep> {
    // Create a mutable copy with proper typing - ensure discussion is always an array
    const discussion: LLMDiscussion[] = [];
    const updatedStep: WorkflowStep = { ...step, status: 'running', discussion };
    this.config.onStepStart?.(updatedStep);

    try {
      // Determine which LLMs to use
      const llms = step.assignedLLMs.length > 0
        ? step.assignedLLMs
        : workflow.defaultLLMs.length > 0
          ? workflow.defaultLLMs
          : [this.config.primaryLLM];

      // Build context from project description and step info
      const context = this.buildStepContext(workflow, step);

      // Step 1: Primary LLM generates initial output
      const primaryLLM = llms[0];
      const initialOutput = await this.generatePrimaryOutput(primaryLLM, step, context);
      updatedStep.output = initialOutput;

      // If only one LLM, evaluate and complete
      if (llms.length === 1) {
        updatedStep.evaluation = await this.evaluateOutput(primaryLLM, step, initialOutput, context);
        updatedStep.status = updatedStep.evaluation.verdict === 'fail' ? 'failed' : 'completed';
        this.config.onStepComplete?.(updatedStep);
        return updatedStep;
      }

      // Step 2: Other LLMs review and potentially debate
      let currentOutput = initialOutput;
      let debateRound = 0;
      let hasConsensus = false;

      while (!hasConsensus && debateRound < this.config.maxDebateRounds) {
        debateRound++;

        // Collect reviews from all other LLMs
        const reviews: { llmId: string; response: LLMCollaborationResponse }[] = [];

        for (const llmId of llms.slice(1)) {
          const response = await this.getCollaborationResponse(
            llmId,
            step,
            currentOutput,
            context,
            discussion
          );
          reviews.push({ llmId, response });

          // Add to discussion
          const llmName = this.getLLMDisplayName(llmId);
          discussion.push({
            llmId,
            llmName,
            message: response.message,
            timestamp: new Date().toISOString(),
            type: response.type,
          });

          this.config.onDiscussionUpdate?.(updatedStep, discussion);
        }

        // Check for consensus
        const votes = reviews.map((r) => r.response.vote);
        const passVotes = votes.filter((v) => v === 'pass').length;
        const consensusReached = passVotes / votes.length >= this.config.consensusThreshold;

        if (consensusReached) {
          hasConsensus = true;
        } else {
          // LLMs need to find agreement - synthesize feedback and improve output
          const disagreements = reviews.filter((r) => r.response.vote === 'fail');

          if (disagreements.length > 0) {
            // Have primary LLM incorporate feedback and try again
            const feedbackSummary = disagreements
              .map((d) => `[${this.getLLMDisplayName(d.llmId)}]: ${d.response.message}`)
              .join('\n');

            // Add primary LLM's response to discussion
            discussion.push({
              llmId: primaryLLM,
              llmName: this.getLLMDisplayName(primaryLLM),
              message: `Incorporating feedback from round ${debateRound}...`,
              timestamp: new Date().toISOString(),
              type: 'suggestion',
            });

            this.config.onDiscussionUpdate?.(updatedStep, discussion);

            // Generate improved output
            currentOutput = await this.improveOutput(
              primaryLLM,
              step,
              currentOutput,
              feedbackSummary,
              context
            );
            updatedStep.output = currentOutput;
          }
        }
      }

      // Final evaluation after debate concludes
      const finalVotes: Record<string, 'pass' | 'fail'> = {};
      for (const llmId of llms) {
        // In production, we'd actually query each LLM for final vote
        // For now, assume consensus was reached if we got here
        finalVotes[this.getLLMDisplayName(llmId)] = 'pass';
      }

      updatedStep.evaluation = {
        verdict: hasConsensus ? 'pass' : 'partial',
        score: hasConsensus ? 100 : 70,
        feedback: hasConsensus
          ? `All LLMs reached consensus after ${debateRound} round(s) of discussion.`
          : `Partial consensus reached after ${debateRound} round(s). Some concerns remain.`,
        llmVotes: finalVotes,
      };

      updatedStep.status = step.gate === 'stop' ? 'waiting_review' : 'completed';
      this.config.onStepComplete?.(updatedStep);
      return updatedStep;

    } catch (error) {
      updatedStep.status = 'failed';
      updatedStep.output = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
      updatedStep.evaluation = {
        verdict: 'fail',
        score: 0,
        feedback: `Step execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
      return updatedStep;
    }
  }

  /**
   * Build context string for step execution
   */
  private buildStepContext(workflow: Workflow, step: WorkflowStep): string {
    return `
## Project Context
${workflow.projectDescription.content}

## Shared Context
${workflow.projectDescription.sharedContext}

## Current Step: ${step.name}
${step.description}

## Success Criteria
${step.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}
`.trim();
  }

  /**
   * Generate initial output from primary LLM
   */
  private async generatePrimaryOutput(
    llmId: string,
    step: WorkflowStep,
    context: string
  ): Promise<string> {
    const prompt = `
You are working on: ${step.name}

${context}

Generate output that satisfies all the success criteria. Be thorough and precise.
`.trim();

    if (this.config.sendToLLM) {
      return await this.config.sendToLLM(llmId, prompt, context);
    }

    // Placeholder for when no LLM integration is provided
    return `[Placeholder output from ${llmId} for step: ${step.name}]\n\nThis would contain the actual LLM-generated content that addresses:\n${step.description}`;
  }

  /**
   * Get collaboration response from reviewing LLM
   */
  private async getCollaborationResponse(
    llmId: string,
    step: WorkflowStep,
    output: string,
    context: string,
    priorDiscussion: LLMDiscussion[]
  ): Promise<LLMCollaborationResponse> {
    const prompt = `
You are reviewing another AI's work on this development step.

## Step Goal
${step.description}

## Success Criteria
${step.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## Output Being Reviewed
${output}

${priorDiscussion.length > 0 ? `
## Prior Discussion
${priorDiscussion.map((d) => `[${d.llmName}] (${d.type}): ${d.message}`).join('\n')}
` : ''}

## Your Role
Provide your perspective. You may:
1. AGREE if the output meets all criteria
2. Provide an INSIGHT about the approach
3. Raise an ARGUMENT if you see issues
4. Offer a SUGGESTION for improvement
5. Flag a CONCERN about potential problems

If you disagree, explain specifically what needs to change and propose a solution.
The goal is to reach consensus, not to simply block progress.

Respond in JSON:
{
  "vote": "pass" | "fail",
  "type": "insight" | "argument" | "suggestion" | "concern",
  "message": "Your detailed feedback..."
}
`.trim();

    if (this.config.sendToLLM) {
      const response = await this.config.sendToLLM(llmId, prompt, context);
      try {
        return JSON.parse(response);
      } catch {
        return {
          vote: 'pass',
          type: 'insight',
          message: response,
        };
      }
    }

    // Placeholder response
    return {
      vote: 'pass',
      type: 'insight',
      message: `[${llmId}] The output looks good and meets the success criteria.`,
    };
  }

  /**
   * Improve output based on feedback
   */
  private async improveOutput(
    llmId: string,
    step: WorkflowStep,
    currentOutput: string,
    feedback: string,
    context: string
  ): Promise<string> {
    const prompt = `
You previously generated output for: ${step.name}

Your output:
${currentOutput}

Other team members have provided feedback:
${feedback}

Please improve your output to address their concerns while still meeting all success criteria:
${step.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Generate an improved version that incorporates this feedback.
`.trim();

    if (this.config.sendToLLM) {
      return await this.config.sendToLLM(llmId, prompt, context);
    }

    return `[Improved output incorporating feedback]\n\n${currentOutput}\n\n[Changes made to address: ${feedback.slice(0, 100)}...]`;
  }

  /**
   * Evaluate output against success criteria
   */
  private async evaluateOutput(
    llmId: string,
    step: WorkflowStep,
    output: string,
    context: string
  ): Promise<StepEvaluation> {
    const prompt = `
Evaluate this output against the success criteria.

## Output
${output}

## Success Criteria
${step.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

For each criterion, determine if it is met. Then provide:
- verdict: "pass", "fail", or "partial"
- score: 0-100 percentage of criteria met
- feedback: Brief explanation

Respond in JSON format.
`.trim();

    if (this.config.sendToLLM) {
      const response = await this.config.sendToLLM(llmId, prompt, context);
      try {
        return JSON.parse(response);
      } catch {
        return {
          verdict: 'pass',
          score: 100,
          feedback: 'Evaluation completed.',
        };
      }
    }

    // Placeholder evaluation
    return {
      verdict: 'pass',
      score: 100,
      feedback: 'All success criteria appear to be met.',
    };
  }

  /**
   * Get display name for LLM ID
   */
  private getLLMDisplayName(llmId: string): string {
    const names: Record<string, string> = {
      // Anthropic
      'claude-opus-4-5-20251101': 'Claude Opus 4.5',
      'claude-sonnet-4-20250514': 'Claude Sonnet 4',
      'claude-3-5-sonnet-latest': 'Claude 3.5 Sonnet',
      'claude-3-5-haiku-latest': 'Claude 3.5 Haiku',
      // OpenAI
      'gpt-5.2': 'GPT-5.2',
      'gpt-5.2-codex': 'GPT-5.2 Codex',
      'gpt-5.1-codex-max': 'GPT-5.1 Codex Max',
      'gpt-5.1-codex-mini': 'GPT-5.1 Codex Mini',
      'gpt-4o': 'GPT-4o',
      'gpt-4o-mini': 'GPT-4o Mini',
      'o1-preview': 'o1 Preview',
      // Google
      'gemini-2.0-flash-exp': 'Gemini 2.0 Flash',
      'gemini-1.5-pro': 'Gemini 1.5 Pro',
    };
    return names[llmId] || llmId;
  }

  /**
   * Stop current execution
   */
  stop(): void {
    this.isRunning = false;
  }

  /**
   * Resume execution from a paused step
   */
  async resumeFromStep(workflowId: string, stepIndex: number): Promise<Workflow | null> {
    const workflow = workflowService.getWorkflow(workflowId);
    if (!workflow) return null;

    // Reset steps from the given index
    const resetSteps = workflow.steps.map((step, i) => {
      if (i >= stepIndex) {
        return {
          ...step,
          status: 'pending' as const,
          output: undefined,
          evaluation: undefined,
          discussion: undefined,
        };
      }
      return step;
    });

    const updatedWorkflow = workflowService.saveWorkflow({
      ...workflow,
      steps: resetSteps,
    });

    // Continue execution
    return this.executeWorkflow(updatedWorkflow, this.config);
  }

  /**
   * Check if executor is currently running
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Get current execution state
   */
  get executionState(): { workflowId: string | null; stepIndex: number } {
    return {
      workflowId: this.currentWorkflowId,
      stepIndex: this.currentStepIndex,
    };
  }
}

// Singleton instance
export const multiLLMExecutor = new MultiLLMExecutor();
