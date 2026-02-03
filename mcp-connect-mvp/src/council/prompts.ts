/**
 * Council: Prompt Construction
 * System prompts and prompt templates for personas
 */

import type { Council, Persona, CouncilMessage, TurnContext, CouncilMode } from './types';

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
