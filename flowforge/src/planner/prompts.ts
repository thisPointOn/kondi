/**
 * FlowForge Planner Prompts
 * System prompts for workflow planning conversations
 */

// ============================================================================
// Main Planning System Prompt
// ============================================================================

export const PLANNING_SYSTEM_PROMPT = `You are a workflow planning assistant helping users create automated workflows.

Your job is to:
1. Understand the user's goal
2. Ask clarifying questions (ONE at a time, don't overwhelm)
3. Propose a workflow with clear steps
4. Refine based on feedback until the user is satisfied

Guidelines:
- Keep steps atomic and clear
- Write success criteria that are specific and testable
- Identify where human approval might be needed
- Consider what could go wrong and how to handle it
- Ask about inputs the workflow will need

When proposing a workflow, output it in the following JSON format wrapped in \`\`\`json code blocks:

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
- "tool": Executes an MCP tool (requires serverId and toolName)
- "human": Requires human input or approval
- "conditional": Branches based on conditions
- "parallel": Runs multiple steps in parallel

Always explain your reasoning when proposing workflows.
Ask the user if they want to make any changes before finalizing.`;

// ============================================================================
// Validation Prompt
// ============================================================================

export const VALIDATION_PROMPT = `Review this workflow specification for completeness and correctness:

## Workflow Spec
{spec}

Check for:
1. All required fields present
2. Step dependencies are valid (blockedBy references exist)
3. Input/output mappings are correct
4. Success criteria are specific and testable
5. Appropriate error handling (maxRetries, timeouts)
6. Human approval steps where sensitive operations occur

Respond with:
{
  "valid": true/false,
  "issues": ["list of issues found"],
  "suggestions": ["list of improvements"],
  "missingFields": ["fields that are required but missing"]
}`;

// ============================================================================
// Step Generation Prompt
// ============================================================================

export const STEP_GENERATION_PROMPT = `Generate a workflow step for the following task:

## Task Description
{task}

## Available Tools
{tools}

## Previous Steps in Workflow
{previousSteps}

Generate a step configuration that:
1. Accomplishes the task
2. Has clear success criteria
3. Handles potential errors
4. Uses appropriate inputs from previous steps

Output the step as JSON:
\`\`\`json
{
  "id": "unique_step_id",
  "name": "Step Name",
  "type": "llm|tool|human|conditional",
  "description": "What this step does",
  "config": { ... },
  "successCriteria": "How to verify success",
  "inputs": [{ "name": "...", "source": { "type": "...", ... } }],
  "outputs": [{ "name": "...", "path": "..." }],
  "maxRetries": 2,
  "blockedBy": ["step_ids_this_depends_on"]
}
\`\`\``;

// ============================================================================
// Refinement Prompt
// ============================================================================

export const REFINEMENT_PROMPT = `The user wants to modify the workflow. Here's the current workflow and their request:

## Current Workflow
{currentSpec}

## User's Request
{request}

Make the requested changes and output the updated workflow spec.
Explain what changes you made and why.

If the request is unclear, ask for clarification.`;

// ============================================================================
// Success Criteria Generation Prompt
// ============================================================================

export const SUCCESS_CRITERIA_PROMPT = `Generate specific, testable success criteria for this step:

## Step Details
Name: {stepName}
Description: {stepDescription}
Type: {stepType}
Expected Output: {expectedOutput}

Good success criteria should be:
1. Specific - What exactly should the output contain?
2. Measurable - How can we verify it programmatically?
3. Relevant - Does it actually validate the step's purpose?
4. Clear - No ambiguity about pass/fail conditions

Generate 2-4 success criteria statements that can be evaluated by an LLM.

Example format:
- The output should contain a valid JSON object with fields X, Y, Z
- The response should address all points mentioned in the input
- The generated text should be between 100-500 words
- No sensitive information should be included in the output`;

// ============================================================================
// Tool Selection Prompt
// ============================================================================

export const TOOL_SELECTION_PROMPT = `Given this task, select the most appropriate tool:

## Task
{task}

## Available Tools
{tools}

Consider:
1. Which tool's purpose best matches the task?
2. What inputs does the tool need?
3. What output will it produce?

Respond with:
{
  "selectedTool": {
    "serverId": "...",
    "toolName": "..."
  },
  "reasoning": "Why this tool is the best choice",
  "argumentMapping": {
    "toolArg1": "how to get this value",
    "toolArg2": "how to get this value"
  }
}

If no tool is appropriate, respond with:
{
  "selectedTool": null,
  "reasoning": "Why no tool fits",
  "alternative": "Suggested alternative approach"
}`;

// ============================================================================
// Conversation Prompts
// ============================================================================

export const GREETING_PROMPT = `Hello! I'm your workflow planning assistant. I'll help you create automated workflows that can execute multi-step tasks.

To get started, tell me:
1. What would you like to automate?
2. What's the goal or end result you're looking for?

I'll ask clarifying questions and then propose a workflow for you to review and refine.`;

export const CLARIFICATION_PROMPT = `I need a bit more information to create the best workflow for you.

{question}

Please provide more details so I can design the workflow accurately.`;

export const COMPLETION_PROMPT = `Great! The workflow looks complete. Here's a summary:

## Workflow: {name}
{description}

**Inputs:** {inputCount} defined
**Steps:** {stepCount} steps
**Outputs:** {outputCount} defined

The workflow is ready to be saved. Would you like to:
1. Save it as a draft (can still edit later)
2. Mark it as ready (can be executed)
3. Make additional changes

Just let me know!`;

// ============================================================================
// Helper Functions
// ============================================================================

export function buildPlanningPrompt(context: {
  userGoal: string;
  availableTools?: Array<{ name: string; description: string }>;
  constraints?: string[];
}): string {
  let prompt = `Help me create a workflow for the following goal:\n\n${context.userGoal}`;

  if (context.availableTools && context.availableTools.length > 0) {
    prompt += '\n\nAvailable tools:\n';
    for (const tool of context.availableTools) {
      prompt += `- ${tool.name}: ${tool.description}\n`;
    }
  }

  if (context.constraints && context.constraints.length > 0) {
    prompt += '\n\nConstraints:\n';
    for (const constraint of context.constraints) {
      prompt += `- ${constraint}\n`;
    }
  }

  return prompt;
}

export function buildRefinementPrompt(
  currentSpec: string,
  userRequest: string
): string {
  return REFINEMENT_PROMPT
    .replace('{currentSpec}', currentSpec)
    .replace('{request}', userRequest);
}

export function buildValidationPrompt(spec: string): string {
  return VALIDATION_PROMPT.replace('{spec}', spec);
}

export function buildStepGenerationPrompt(
  task: string,
  tools: Array<{ name: string; description: string }>,
  previousSteps: Array<{ id: string; name: string }>
): string {
  const toolsStr = tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  const stepsStr =
    previousSteps.length > 0
      ? previousSteps.map((s) => `- ${s.id}: ${s.name}`).join('\n')
      : 'None';

  return STEP_GENERATION_PROMPT
    .replace('{task}', task)
    .replace('{tools}', toolsStr || 'No tools available')
    .replace('{previousSteps}', stepsStr);
}

export function buildSuccessCriteriaPrompt(step: {
  name: string;
  description: string;
  type: string;
  expectedOutput?: string;
}): string {
  return SUCCESS_CRITERIA_PROMPT
    .replace('{stepName}', step.name)
    .replace('{stepDescription}', step.description)
    .replace('{stepType}', step.type)
    .replace('{expectedOutput}', step.expectedOutput || 'Not specified');
}
