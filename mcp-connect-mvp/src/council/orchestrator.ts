/**
 * Council: Orchestrator
 * Main orchestration logic for multi-model deliberation
 */

import type {
  Council,
  Persona,
  CouncilMessage,
  CouncilEvent,
  TurnContext,
  CostEstimate,
  RoundCostEstimate,
  Resolution,
} from './types';
import {
  buildPersonaSystemPrompt,
  buildConversationContext,
  buildDebatePrompt,
  buildSteelmanPrompt,
  buildCommonGroundPrompt,
  buildAskPrompt,
  buildVotePrompt,
  extractOpenQuestions,
} from './prompts';
import { selectNextSpeaker, isRoundComplete, getUnheardPersonas, selectDebateOpponents } from './turn-strategies';
import { prepareSynthesisRequest, parseSynthesisResponse, createRoundSummary, quickConsensusCheck } from './synthesis';
import { councilStore } from './store';
import { getModelCostRates } from '../config/models';

// ============================================================================
// Types
// ============================================================================

export interface LLMProvider {
  complete(params: {
    model: string;
    provider: string;
    systemPrompt: string;
    userMessage: string;
    temperature?: number;
    availableTools?: Map<string, { serverId: string; tools: import('../types/mcp').MCPTool[] }>;
  }): Promise<{
    content: string;
    tokensUsed: number;
    latencyMs: number;
  }>;
}

export interface OrchestratorConfig {
  llmProvider: LLMProvider;
  onEvent?: (event: CouncilEvent) => void;
}

// ============================================================================
// Cost Estimation
// ============================================================================

function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4);
}

function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates = getModelCostRates(model);
  return (inputTokens / 1000) * rates.input + (outputTokens / 1000) * rates.output;
}

export function estimateTurnCost(council: Council, persona: Persona): CostEstimate {
  const systemPrompt = buildPersonaSystemPrompt(persona, council, {
    recentMessages: council.messages.slice(-10),
    currentTopic: council.topic,
    openQuestions: [],
  });

  const context = buildConversationContext(council, {
    recentMessages: council.messages.slice(-10),
    currentTopic: council.topic,
    openQuestions: [],
  });

  const inputTokens = estimateTokens(systemPrompt + context);
  const outputTokens =
    persona.verbosity === 'concise' ? 200 : persona.verbosity === 'thorough' ? 800 : 400;

  return {
    inputTokens,
    outputTokens,
    estimatedCost: calculateCost(persona.model, inputTokens, outputTokens),
    model: persona.model,
  };
}

export function estimateRoundCost(council: Council): RoundCostEstimate {
  const activePersonas = council.personas.filter((p) => !p.muted);
  const estimates = activePersonas.map((persona) => ({
    personaId: persona.id,
    personaName: persona.name,
    estimate: estimateTurnCost(council, persona),
  }));

  // Synthesis cost if auto-synthesize is on
  let synthesis: CostEstimate | undefined;
  if (council.orchestration.autoSynthesize) {
    const synthRequest = prepareSynthesisRequest(council);
    const inputTokens = estimateTokens(synthRequest.prompt);
    synthesis = {
      inputTokens,
      outputTokens: 500,
      estimatedCost: calculateCost(synthRequest.model, inputTokens, 500),
      model: synthRequest.model,
    };
  }

  const total =
    estimates.reduce((sum, e) => sum + e.estimate.estimatedCost, 0) +
    (synthesis?.estimatedCost || 0);

  return { personas: estimates, synthesis, total };
}

// ============================================================================
// Orchestrator Class
// ============================================================================

export class CouncilOrchestrator {
  private llmProvider: LLMProvider;
  private onEvent?: (event: CouncilEvent) => void;
  private roundNumber = 1;

  constructor(config: OrchestratorConfig) {
    this.llmProvider = config.llmProvider;
    this.onEvent = config.onEvent;
  }

  private emit(event: CouncilEvent): void {
    this.onEvent?.(event);
  }

  /**
   * Generate a single persona's turn
   */
  async generateTurn(
    council: Council,
    persona: Persona,
    instruction?: string
  ): Promise<CouncilMessage> {
    this.emit({ type: 'turn-started', personaId: persona.id });

    const turnContext: TurnContext = {
      recentMessages: council.messages.slice(-10),
      currentTopic: council.topic,
      openQuestions: extractOpenQuestions(council.messages),
      speakerInstruction: instruction,
    };

    const systemPrompt = buildPersonaSystemPrompt(persona, council, turnContext);
    const userMessage = buildConversationContext(council, turnContext);

    const startTime = Date.now();

    try {
      const response = await this.llmProvider.complete({
        model: persona.model,
        provider: persona.provider,
        systemPrompt,
        userMessage,
        temperature: persona.temperature,
      });

      const message: CouncilMessage = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        speakerId: persona.id,
        speakerType: 'persona',
        content: response.content,
        tokensUsed: response.tokensUsed,
        latencyMs: response.latencyMs || Date.now() - startTime,
      };

      // Add message to store
      councilStore.addMessage(council.id, message);

      this.emit({ type: 'turn-completed', message });

      return message;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.emit({ type: 'error', error: errorMessage });
      throw error;
    }
  }

  /**
   * Generate the next turn based on turn strategy
   */
  async generateNextTurn(council: Council, instruction?: string): Promise<CouncilMessage | null> {
    const nextSpeaker = selectNextSpeaker(council);

    if (!nextSpeaker || Array.isArray(nextSpeaker)) {
      // Parallel or moderator mode - caller should handle
      return null;
    }

    return this.generateTurn(council, nextSpeaker, instruction);
  }

  /**
   * Generate a full round (all active personas speak once)
   */
  async generateRound(council: Council): Promise<CouncilMessage[]> {
    const messages: CouncilMessage[] = [];
    const activePersonas = council.personas.filter((p) => !p.muted);

    for (const persona of activePersonas) {
      const message = await this.generateTurn(council, persona);
      messages.push(message);

      // Update council reference with new message
      const updatedCouncil = councilStore.get(council.id);
      if (updatedCouncil) {
        council = updatedCouncil;
      }
    }

    // Add round summary if auto-synthesize is on
    if (council.orchestration.autoSynthesize) {
      const summary = createRoundSummary(council, this.roundNumber);
      councilStore.addMessage(council.id, summary);
      messages.push(summary);
    }

    this.roundNumber++;

    return messages;
  }

  /**
   * Generate parallel responses (all personas respond simultaneously)
   */
  async generateParallel(council: Council): Promise<CouncilMessage[]> {
    const activePersonas = council.personas.filter((p) => !p.muted);

    const promises = activePersonas.map((persona) =>
      this.generateTurn(council, persona).catch((error) => {
        console.error(`[Council] Failed to generate turn for ${persona.name}:`, error);
        return null;
      })
    );

    const results = await Promise.all(promises);
    return results.filter((m): m is CouncilMessage => m !== null);
  }

  /**
   * Generate synthesis/resolution
   */
  async generateSynthesis(council: Council): Promise<Resolution | null> {
    const synthesizer = council.orchestration.synthesizerId
      ? council.personas.find((p) => p.id === council.orchestration.synthesizerId)
      : undefined;

    this.emit({
      type: 'synthesis-started',
      synthesizerId: synthesizer?.id || 'system',
    });

    const request = prepareSynthesisRequest(council, {
      synthesizer: synthesizer || 'system',
    });

    try {
      const response = await this.llmProvider.complete({
        model: request.model,
        provider: request.provider,
        systemPrompt: 'You are an impartial synthesizer analyzing a multi-perspective discussion.',
        userMessage: request.prompt,
        temperature: 0.3, // Lower temperature for synthesis
      });

      const resolution = parseSynthesisResponse(response.content);

      if (resolution) {
        resolution.generatedBy = request.synthesizerId;
        this.emit({ type: 'synthesis-generated', resolution });
        this.emit({ type: 'consensus-updated', level: resolution.consensusLevel });
      }

      return resolution;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.emit({ type: 'error', error: `Synthesis failed: ${errorMessage}` });
      return null;
    }
  }

  /**
   * Resolve the council with a final decision
   */
  async resolve(council: Council): Promise<Resolution | null> {
    const resolution = await this.generateSynthesis(council);

    if (resolution) {
      councilStore.resolve(council.id, resolution);
      this.emit({ type: 'council-resolved', resolution });
    }

    return resolution;
  }

  /**
   * Ask a specific persona a question
   */
  async askPersona(
    council: Council,
    personaId: string,
    question: string
  ): Promise<CouncilMessage | null> {
    const persona = council.personas.find((p) => p.id === personaId);
    if (!persona) return null;

    return this.generateTurn(council, persona, question);
  }

  /**
   * Generate a debate between two personas
   */
  async debate(
    council: Council,
    personaIds?: [string, string],
    topic?: string
  ): Promise<[CouncilMessage, CouncilMessage] | null> {
    let personas: [Persona, Persona] | null;

    if (personaIds) {
      const p1 = council.personas.find((p) => p.id === personaIds[0]);
      const p2 = council.personas.find((p) => p.id === personaIds[1]);
      if (!p1 || !p2) return null;
      personas = [p1, p2];
    } else {
      personas = selectDebateOpponents(council);
    }

    if (!personas) return null;

    const [persona1, persona2] = personas;

    // Generate first persona's argument
    const prompt1 = buildDebatePrompt(persona1, persona2, topic || council.topic, council);
    const message1 = await this.generateTurn(council, persona1, prompt1);

    // Update council and generate response
    const updatedCouncil = councilStore.get(council.id);
    if (!updatedCouncil) return [message1, message1]; // Shouldn't happen

    const prompt2 = buildDebatePrompt(persona2, persona1, topic || council.topic, updatedCouncil);
    const message2 = await this.generateTurn(updatedCouncil, persona2, prompt2);

    return [message1, message2];
  }

  /**
   * Ask one persona to steelman another's position
   */
  async steelman(
    council: Council,
    askingPersonaId: string,
    targetPersonaId: string
  ): Promise<CouncilMessage | null> {
    const askingPersona = council.personas.find((p) => p.id === askingPersonaId);
    const targetPersona = council.personas.find((p) => p.id === targetPersonaId);

    if (!askingPersona || !targetPersona) return null;

    const prompt = buildSteelmanPrompt(askingPersona, targetPersona, council);
    return this.generateTurn(council, askingPersona, prompt);
  }

  /**
   * Ask all personas to find common ground
   */
  async findCommonGround(council: Council): Promise<CouncilMessage | null> {
    const prompt = buildCommonGroundPrompt(council);

    // Use the synthesizer or first neutral persona
    const synthesizer =
      council.personas.find((p) => p.id === council.orchestration.synthesizerId) ||
      council.personas.find((p) => p.predisposition.stance === 'neutral') ||
      council.personas[0];

    if (!synthesizer) return null;

    return this.generateTurn(council, synthesizer, prompt);
  }

  /**
   * Call for votes from all personas
   */
  async callVote(council: Council): Promise<CouncilMessage[]> {
    const activePersonas = council.personas.filter((p) => !p.muted);
    const messages: CouncilMessage[] = [];

    for (const persona of activePersonas) {
      const prompt = buildVotePrompt(persona, council);
      const message = await this.generateTurn(council, persona, prompt);
      messages.push(message);

      // Update council reference
      const updatedCouncil = councilStore.get(council.id);
      if (updatedCouncil) {
        council = updatedCouncil;
      }
    }

    return messages;
  }

  /**
   * Add user message to council
   */
  addUserMessage(council: Council, content: string, replyingTo?: string): CouncilMessage {
    const message: CouncilMessage = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      speakerId: 'user',
      speakerType: 'user',
      content,
      replyingTo,
      tokensUsed: 0,
      latencyMs: 0,
    };

    councilStore.addMessage(council.id, message);
    return message;
  }

  /**
   * Check if council should auto-synthesize
   */
  shouldSynthesize(council: Council): boolean {
    if (!council.orchestration.autoSynthesize) return false;
    return isRoundComplete(council);
  }

  /**
   * Get quick consensus status
   */
  getConsensusStatus(council: Council) {
    return quickConsensusCheck(council);
  }

  /**
   * Pause the council
   */
  pause(council: Council): void {
    councilStore.setStatus(council.id, 'paused');
    this.emit({ type: 'council-paused' });
  }

  /**
   * Resume the council
   */
  resume(council: Council): void {
    councilStore.setStatus(council.id, 'active');
    this.emit({ type: 'council-resumed' });
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createOrchestrator(config: OrchestratorConfig): CouncilOrchestrator {
  return new CouncilOrchestrator(config);
}
