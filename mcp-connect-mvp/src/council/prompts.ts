/**
 * Council: Prompt Construction
 * System prompts and prompt templates for personas
 */

import type { Council, Persona, CouncilMessage, TurnContext, CouncilMode, LedgerEntry, ContextPatch } from './types';

/**
 * Get interaction instruction based on council mode and persona stance
 */
function getInteractionInstruction(mode: CouncilMode, persona: Persona): string {
  switch (mode) {
    case 'debate':
      return persona.predisposition.stance === 'advocate'
        ? 'Defend your position and counter opposing arguments.'
        : persona.predisposition.stance === 'critic'
        ? 'Challenge claims and identify weaknesses in arguments.'
        : 'Offer perspective that bridges competing views.';
    case 'build':
      return "Build on what others have said. Add value, don't repeat.";
    case 'review':
      return 'Provide constructive critique. Be specific about improvements.';
    case 'synthesis':
      return "Offer your unique perspective. The goal is diverse input, not agreement.";
    case 'socratic':
      return persona.predisposition.interactionStyle === 'question'
        ? 'Ask probing questions that reveal assumptions and deepen understanding.'
        : 'Defend your reasoning while remaining open to being wrong.';
    case 'freeform':
    default:
      return 'Engage naturally as your character would.';
  }
}

/**
 * Build the system prompt for a persona's turn
 */
export function buildPersonaSystemPrompt(
  persona: Persona,
  council: Council,
  turnContext: TurnContext
): string {
  const otherPersonas = council.personas
    .filter((p) => p.id !== persona.id && !p.muted)
    .map((p) => `${p.name} (${p.predisposition.stance})`)
    .join(', ');

  return `${persona.predisposition.systemPrompt}

## Your Identity
Name: ${persona.name}
Stance: ${persona.predisposition.stance}
${persona.predisposition.arguesFor ? `You argue for: ${persona.predisposition.arguesFor}` : ''}
${persona.predisposition.arguesAgainst ? `You argue against: ${persona.predisposition.arguesAgainst}` : ''}
Your style: ${persona.predisposition.interactionStyle}
Traits: ${persona.predisposition.traits.join(', ')}
${persona.predisposition.domain ? `Domain expertise: ${persona.predisposition.domain}` : ''}

## Council Context
Topic: ${council.topic}
Mode: ${council.orchestration.mode}
Other participants: ${otherPersonas || 'None yet'}

## Shared Context
${council.sharedContext.description}
${council.sharedContext.constraints?.length
  ? `\nConstraints:\n${council.sharedContext.constraints.map((c) => `- ${c}`).join('\n')}`
  : ''}

## Your Task
Respond as ${persona.name} would. Stay in character.
${getInteractionInstruction(council.orchestration.mode, persona)}

## Guidelines
- Be concise but substantive (2-4 paragraphs max unless thorough analysis is needed)
- Reference specific points from other participants when relevant
- If you agree with someone, say so briefly and add new value
- If you disagree, be direct but respectful
- Ask questions when genuinely uncertain
- Stay true to your predisposition, but engage authentically
${persona.verbosity === 'concise'
  ? '- Keep responses brief and focused (1-2 paragraphs)'
  : persona.verbosity === 'thorough'
  ? '- Provide thorough analysis when the topic warrants it'
  : ''}

${turnContext.speakerInstruction ? `## Specific Direction\n${turnContext.speakerInstruction}` : ''}`;
}

/**
 * Build the user message containing recent conversation context
 */
export function buildConversationContext(
  council: Council,
  turnContext: TurnContext,
  maxMessages = 10
): string {
  const recentMessages = turnContext.recentMessages.slice(-maxMessages);

  if (recentMessages.length === 0) {
    return `This is the start of the discussion. The topic is: "${council.topic}"\n\nPlease share your initial perspective.`;
  }

  const messageStrings = recentMessages.map((m) => {
    const speaker = getSpeakerName(m, council);
    return `[${speaker}]: ${m.content}`;
  });

  let context = `## Recent Discussion\n\n${messageStrings.join('\n\n')}`;

  if (turnContext.openQuestions.length > 0) {
    context += `\n\n## Open Questions\n${turnContext.openQuestions.map((q) => `- ${q}`).join('\n')}`;
  }

  context += '\n\n---\n\nPlease respond as your character, building on or responding to the discussion.';

  return context;
}

/**
 * Get the display name for a message speaker
 */
function getSpeakerName(message: CouncilMessage, council: Council): string {
  if (message.speakerType === 'user') return 'User';
  if (message.speakerType === 'system') return 'System';
  const persona = council.personas.find((p) => p.id === message.speakerId);
  return persona?.name || 'Unknown';
}

/**
 * Build prompt for synthesis generation
 */
export function buildSynthesisPrompt(council: Council): string {
  const personaSummaries = council.personas
    .filter((p) => !p.muted)
    .map(
      (p) => `**${p.name}** (${p.predisposition.stance})
Argues for: ${p.predisposition.arguesFor || 'N/A'}`
    )
    .join('\n');

  const messageStrings = council.messages.map((m) => {
    const speaker = getSpeakerName(m, council);
    return `[${speaker}]: ${m.content}`;
  });

  return `You are synthesizing a multi-perspective discussion.

## Topic
${council.topic}

## Participants and Positions
${personaSummaries}

## Discussion So Far
${messageStrings.join('\n\n')}

## Your Task
Generate a synthesis that:
1. Summarizes the key positions and tensions
2. Identifies areas of agreement
3. Notes unresolved disagreements
4. Suggests a path forward or decision framework
5. Rates consensus level (0-100%)

Respond in JSON format:
{
  "summary": "2-3 paragraph summary of the discussion",
  "consensusLevel": 0.65,
  "agreements": ["Point 1 everyone agrees on", "Point 2..."],
  "tensions": ["Key tension 1", "Key tension 2..."],
  "keyDecisions": ["Decision or recommendation 1", "..."],
  "dissent": ["Unresolved disagreement 1", "..."],
  "nextSteps": ["Suggested next step 1", "..."]
}`;
}

/**
 * Build prompt for debate between two personas
 */
export function buildDebatePrompt(
  persona: Persona,
  opponent: Persona,
  topic: string,
  council: Council
): string {
  return `You are ${persona.name} in a focused debate with ${opponent.name}.

## Your Position
${persona.predisposition.systemPrompt}
You argue for: ${persona.predisposition.arguesFor}
You argue against: ${persona.predisposition.arguesAgainst}

## Your Opponent
${opponent.name} (${opponent.predisposition.stance})
They argue for: ${opponent.predisposition.arguesFor}
They argue against: ${opponent.predisposition.arguesAgainst}

## Debate Topic
${topic || council.topic}

## Instructions
Make your strongest argument for your position. Address ${opponent.name}'s likely counterarguments. Be direct and substantive.`;
}

/**
 * Build prompt for steelmanning another persona's position
 */
export function buildSteelmanPrompt(
  persona: Persona,
  targetPersona: Persona,
  council: Council
): string {
  // Get the target persona's recent messages
  const targetMessages = council.messages
    .filter((m) => m.speakerId === targetPersona.id)
    .slice(-3)
    .map((m) => m.content)
    .join('\n\n');

  return `You are ${persona.name}, but your task is special: you must steelman ${targetPersona.name}'s position.

## Context
${targetPersona.name} has been arguing:
${targetMessages || targetPersona.predisposition.arguesFor}

## Your Task
Present the STRONGEST possible version of ${targetPersona.name}'s argument. Even though you typically ${persona.predisposition.arguesFor}, now you must:

1. Articulate their position more clearly and compellingly than they might
2. Identify the best evidence and reasoning that supports their view
3. Explain why a reasonable person might hold this position
4. Present it genuinely, not as a strawman

This is an exercise in intellectual honesty and understanding opposing views.`;
}

/**
 * Build prompt for finding common ground
 */
export function buildCommonGroundPrompt(council: Council): string {
  const positions = council.personas
    .filter((p) => !p.muted)
    .map((p) => {
      const recentMessage = council.messages
        .filter((m) => m.speakerId === p.id)
        .slice(-1)[0];
      return `${p.name}: ${recentMessage?.content || p.predisposition.arguesFor || 'No position stated yet'}`;
    })
    .join('\n\n');

  return `## Discussion Positions
${positions}

## Your Task
Identify what these participants AGREE on, even if they disagree on many things. Look for:
- Shared values or goals
- Common concerns
- Areas of potential compromise
- Underlying assumptions they share

Be specific and constructive. The goal is to find a foundation for moving forward.`;
}

/**
 * Build prompt for asking a specific persona a question
 */
export function buildAskPrompt(
  persona: Persona,
  question: string,
  council: Council
): string {
  return `${buildPersonaSystemPrompt(persona, council, {
    recentMessages: council.messages.slice(-5),
    currentTopic: council.topic,
    openQuestions: [question],
    speakerInstruction: `The user has directed this question specifically to you: "${question}"\n\nProvide a thoughtful response that reflects your unique perspective as ${persona.name}.`,
  })}`;
}

/**
 * Build prompt for voting/final position
 */
export function buildVotePrompt(persona: Persona, council: Council): string {
  return `You are ${persona.name}. After the discussion so far, state your FINAL position.

## Your Identity
${persona.predisposition.systemPrompt}

## Discussion Summary
Topic: ${council.topic}
Messages exchanged: ${council.messages.length}
Other participants: ${council.personas.filter((p) => p.id !== persona.id).map((p) => p.name).join(', ')}

## Your Task
State your final position in 1-2 sentences. Then rate your confidence (0-100%). Be clear and decisive.

Format:
POSITION: [Your final position]
CONFIDENCE: [0-100]%
RATIONALE: [Brief explanation]`;
}

/**
 * Extract open questions from recent messages
 */
export function extractOpenQuestions(messages: CouncilMessage[]): string[] {
  const questions: string[] = [];

  for (const message of messages.slice(-10)) {
    // Simple heuristic: find sentences ending with ?
    const sentences = message.content.split(/[.!?]+/);
    for (const sentence of sentences) {
      if (message.content.includes(sentence + '?')) {
        const trimmed = sentence.trim();
        if (trimmed.length > 10 && trimmed.length < 200) {
          questions.push(trimmed + '?');
        }
      }
    }
  }

  // Return unique questions, most recent first
  return [...new Set(questions.reverse())].slice(0, 5);
}

// ============================================================================
// Deliberation Prompts - Structured Multi-Agent Workflow
// ============================================================================

/**
 * Minimal worker system prompt when persona is suppressed
 */
export function getMinimalWorkerSystemPrompt(): string {
  return `You are the Worker agent. Your job is to execute the directive precisely.

IMPORTANT: You are a text-generation agent. You do NOT have access to a file system,
terminal, or any external tools. All of your output must be produced directly as text
in your response. If the directive asks you to create files, write code, or produce
documents, include them in your response using clearly labeled code blocks or sections.

For example, if asked to write a file, output it like:
\`\`\`filename: path/to/file.ts
// file contents here
\`\`\`

Rules:
- Follow the directive exactly as written
- Produce ALL output directly in your response text — do not attempt to write files or run commands
- If anything is unclear, flag it explicitly in your output — do not guess
- If something seems incorrect or impossible, say so — do not silently deviate
- Do not add features, optimizations, or changes not specified in the directive`;
}

// ============================================================================
// Manager Prompts
// ============================================================================

/**
 * Manager frames the problem - Section 9.1
 */
export function buildManagerFramingPrompt(rawProblem: string): string {
  return `You are framing a problem for a team of consultants who will analyze it
from different perspectives, then debate approaches.

Write a structured problem statement that includes:
- CONTEXT: What background does the team need?
- PROBLEM: What specific question must be answered?
- CONSTRAINTS: What are the non-negotiable requirements?
- DESIRED OUTCOME: What does a good solution look like?
- SCOPE: What is and isn't in scope?

RAW PROBLEM:
${rawProblem}`;
}

/**
 * Manager evaluates the round - Section 9.4
 */
export function buildManagerEvaluationPrompt(
  ledgerContext: string,
  pendingPatches: ContextPatch[],
  expectedOutput?: string
): string {
  const patchesSection = pendingPatches.length > 0
    ? `\n---\n\nPENDING CONTEXT PROPOSALS:\n${pendingPatches.map((p) =>
        `Patch ${p.id} by ${p.authorPersonaId}:\nWhat: ${p.diff}\nRationale: ${p.rationale}`
      ).join('\n\n')}\n\nFor each patch, decide: ACCEPT or REJECT with reason.`
    : '';

  const expectedOutputSection = expectedOutput
    ? `\n---\n\nEXPECTED OUTPUT (the final deliverable must satisfy this):\n${expectedOutput}`
    : '';

  return `${ledgerContext}
${patchesSection}
${expectedOutputSection}

---

Evaluate this round of deliberation.

YOUR RESPONSIBILITIES AS MANAGER:
1. Keep the conversation focused on the task and expected output
2. If the discussion is getting derailed or fixated on irrelevant topics, use REDIRECT
3. Ensure progress is being made toward a solution that meets the expected output
4. Move the conversation forward productively

Decide:
1. CONTINUE — positions are still evolving, run another round
   Include a question to focus and advance the discussion.
2. DECIDE — enough clarity exists to make a decision that will meet the expected output
3. REDIRECT — consultants are off-track, unfocused, or fixated on irrelevant details.
   Use this to get the conversation back on track with a specific refocusing question.

Respond as JSON:
{
  "patchDecisions": [
    { "patchId": "...", "accepted": true/false, "reason": "..." }
  ],
  "action": "continue" | "decide" | "redirect",
  "reasoning": "...",
  "question": "required for continue or redirect - use this to guide the discussion",
  "confidence": 0.0-1.0,
  "missingInformation": ["optional list"]
}`;
}

/**
 * Manager makes decision - Section 9.5
 */
export function buildManagerDecisionPrompt(
  ledgerContext: string,
  decisionCriteria?: string[],
  expectedOutput?: string
): string {
  const criteriaBlock = decisionCriteria?.length
    ? `\n---\n\nDECISION CRITERIA (evaluate against these):\n${decisionCriteria.map((c) => `- ${c}`).join('\n')}`
    : '';

  const expectedOutputBlock = expectedOutput
    ? `\n---\n\nEXPECTED OUTPUT (the final deliverable MUST satisfy this):\n${expectedOutput}`
    : '';

  return `${ledgerContext}
${criteriaBlock}
${expectedOutputBlock}

---

The deliberation is complete. Make your decision.

IMPORTANT: Your decision must lead to a deliverable that matches the expected output exactly.

Write:
- SUMMARY: Key positions and arguments from the consultants
- DECISION: What approach will we take?
- RATIONALE: Why this approach? Which arguments were most persuasive?
- REJECTED: Alternatives considered and why they were rejected
- RISKS: Known risks we are accepting
- ACCEPTANCE CRITERIA: How will we know the work output is correct?

You are not bound by majority opinion. Choose the approach with
the strongest reasoning.`;
}

/**
 * Manager forced decision (early termination) - Section 9.9
 */
export function buildManagerForcedDecisionPrompt(ledgerContext: string): string {
  return `${ledgerContext}

---

NOTE: This deliberation was ended early by the user.
You must make a decision now with the information available.
Acknowledge what is incomplete or uncertain.

Write:
- SUMMARY: What was discussed so far
- DECISION: Best approach given available information
- RATIONALE: Why, and what you're uncertain about
- RISKS: Higher than normal due to incomplete deliberation
- ACCEPTANCE CRITERIA: How to verify the output`;
}

/**
 * Manager creates execution plan
 */
export function buildManagerPlanPrompt(decision: string): string {
  return `Based on your decision, create an execution plan.

YOUR DECISION:
${decision}

Write a plan that:
- Breaks down the work into clear steps
- Identifies dependencies between steps
- Specifies what each step should produce
- Notes any prerequisites or setup needed

Keep the plan concrete and actionable.`;
}

/**
 * Manager issues work directive - Section 9.6
 */
export function buildWorkDirectivePrompt(decision: string, plan?: string): string {
  const planSection = plan ? `\nPLAN:\n${plan}\n` : '';

  return `Based on your decision, write a concrete work directive.

YOUR DECISION:
${decision}
${planSection}
The directive must be:
- SPECIFIC: Exactly what to do
- CONSTRAINED: Rules and limitations
- MEASURABLE: What does "done" look like?
- SELF-CONTAINED: The worker can execute from this alone

Do not include deliberation history, rejected alternatives,
or consultant arguments. The worker will not see any of that.
Give a clear, unambiguous task.`;
}

/**
 * Manager reviews output - Section 9.8
 */
export function buildManagerReviewPrompt(
  workOutput: string,
  directive: string,
  acceptanceCriteria?: string,
  expectedOutput?: string
): string {
  const criteriaSection = acceptanceCriteria
    ? `\nACCEPTANCE CRITERIA (from your decision):\n${acceptanceCriteria}\n`
    : '';

  const expectedOutputSection = expectedOutput
    ? `\nEXPECTED OUTPUT (the deliverable MUST match this):\n${expectedOutput}\n`
    : '';

  return `WORK DIRECTIVE:
${directive}
${criteriaSection}${expectedOutputSection}
WORKER OUTPUT:
${workOutput}

---

Review the worker's output against the directive, acceptance criteria, and expected output.

CRITICAL: The output MUST match what was specified in the expected output. If it doesn't,
use REVISE with specific instructions to correct it, or RE-DELIBERATE if the approach
needs to be reconsidered by the consultants.

Decide:
- ACCEPT: Output meets the directive, acceptance criteria, AND expected output. Explain briefly.
- REVISE: Output needs changes to meet the expected output. Provide specific, actionable feedback.
- RE-DELIBERATE: The approach taken doesn't satisfy the expected output and requires the
  consultants to reconsider. Explain what needs to change.

Respond as JSON:
{
  "verdict": "accept" | "revise" | "re_deliberate",
  "reasoning": "...",
  "feedback": "specific revision instructions (if revise)",
  "newInformation": "what changed (if re_deliberate)"
}`;
}

/**
 * Manager writes round summary - Section 9.10
 */
export function buildManagerRoundSummaryPrompt(roundEntries: LedgerEntry[]): string {
  const entriesText = roundEntries
    .filter((e) => ['analysis', 'response', 'proposal'].includes(e.entryType))
    .map((e) => `[${e.authorPersonaId}, ${e.entryType}]:\n${e.content}`)
    .join('\n\n');

  return `Summarize this round of deliberation for the next round's consultants.
Capture:
- Each consultant's key position
- Points of agreement
- Points of disagreement
- Unresolved questions

Keep it concise. The consultants will use this summary instead of
reading the full round.

ROUND ENTRIES:
${entriesText}`;
}

// ============================================================================
// Consultant Prompts
// ============================================================================

/**
 * Consultant independent analysis (Round 1) - Section 9.2
 */
export function buildIndependentAnalysisPrompt(
  persona: Persona,
  focusArea: string,
  contextContent: string
): string {
  return `${contextContent}

---

Analyze this problem from your area of expertise (${focusArea}).

Provide:
- Your assessment of the key challenges
- Your recommended approach
- Risks and concerns from your perspective
- Tradeoffs to consider

If you believe the shared context is missing something important,
you may propose a CONTEXT CHANGE by clearly marking it:

PROPOSED CONTEXT CHANGE:
What: {description of what to add/modify}
Why: {rationale}

Other consultants are analyzing this independently. You will see
their perspectives and can respond in the next round.`;
}

/**
 * Consultant deliberation response (Round 2+) - Section 9.3
 */
export function buildDeliberationResponsePrompt(
  persona: Persona,
  focusArea: string,
  fullContext: string
): string {
  return `${fullContext}

---

You have seen the other consultants' analyses. Provide your updated perspective:

- Where do you AGREE with other consultants and why?
- Where do you DISAGREE and what is your counter-argument?
- What important considerations have been MISSED?
- Has your position CHANGED? If so, how and why?
- What is your REFINED recommendation?

Do not restate your previous position unchanged.
Engage substantively with the other perspectives.

You may propose a CONTEXT CHANGE if you believe the shared context
should be updated:

PROPOSED CONTEXT CHANGE:
What: {description}
Why: {rationale}`;
}

// ============================================================================
// Worker Prompts
// ============================================================================

/**
 * Worker execution - Section 9.7
 */
export function buildWorkerExecutionPrompt(directive: string): string {
  return `DIRECTIVE:
${directive}

---
Remember: Produce all output directly in your response. Use labeled code blocks for any files or code.
Do not attempt to access a file system or run commands — you are a text-only agent.`;
}

/**
 * Worker revision - Section 9.7.1
 */
export function buildWorkerRevisionPrompt(
  directive: string,
  previousOutput: string,
  feedback: string
): string {
  return `DIRECTIVE:
${directive}

YOUR PREVIOUS OUTPUT:
${previousOutput}

REVISION FEEDBACK:
${feedback}

Revise your output to address the feedback. Follow the original
directive. Only change what the feedback asks you to change.

Remember: Produce all output directly in your response. Use labeled code blocks for any files or code.
Do not attempt to access a file system or run commands — you are a text-only agent.`;
}
