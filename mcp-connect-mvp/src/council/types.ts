/**
 * Council: Multi-Model Deliberation System
 * Core type definitions
 */

// ============================================================================
// Persona Types
// ============================================================================

export interface Predisposition {
  /** Core identity prompt defining the persona's role and behavior */
  systemPrompt: string;

  /** The fundamental stance this persona takes */
  stance: 'advocate' | 'critic' | 'neutral' | 'wildcard';

  /** What this persona champions and argues for */
  arguesFor?: string;

  /** What this persona pushes back on */
  arguesAgainst?: string;

  /** Personality traits that guide behavior */
  traits: string[];

  /** How this persona engages with others */
  interactionStyle: 'debate' | 'build' | 'question' | 'synthesize' | 'review';

  /** Optional domain expertise */
  domain?: string;
}

export interface Persona {
  id: string;
  name: string;

  /** Which LLM provider powers this persona */
  provider: string;

  /** Model ID (e.g., "claude-opus-4", "gpt-4o") */
  model: string;

  /** The attitude/predisposition defining behavior */
  predisposition: Predisposition;

  /** Visual identity - URL or emoji */
  avatar?: string;

  /** Hex color for UI theming */
  color: string;

  /** Temperature 0-1, higher = more creative/random */
  temperature?: number;

  /** Response length preference */
  verbosity: 'concise' | 'balanced' | 'thorough';

  /** Whether this persona is currently muted */
  muted?: boolean;
}

export interface PresetPersona {
  name: string;
  defaultProvider: string;
  defaultModel: string;
  color: string;
  avatar?: string;
  temperature?: number;
  verbosity?: 'concise' | 'balanced' | 'thorough';
  predisposition: Predisposition;
}

// ============================================================================
// Council Types
// ============================================================================

export interface Document {
  id: string;
  name: string;
  type: 'text' | 'pdf' | 'image' | 'data';
  content: string;
}

export interface SharedContext {
  /** Text description of the situation being discussed */
  description: string;

  /** Attached files/documents all personas can see */
  documents: Document[];

  /** Structured data available to all personas */
  data?: Record<string, unknown>;

  /** Constraints or requirements to consider */
  constraints?: string[];
}

export type CouncilMode =
  | 'debate'      // Personas argue opposing positions
  | 'build'       // Personas collaborate, adding to each other
  | 'review'      // One presents, others critique
  | 'synthesis'   // Each offers perspective, then combine
  | 'socratic'    // One questions, others defend
  | 'freeform';   // No structure, natural conversation

export type TurnStrategy =
  | 'round-robin'   // Each speaks in fixed order
  | 'react'         // Respond to previous speaker
  | 'popcorn'       // Speaker chooses next speaker
  | 'volunteer'     // Personas decide if they have something to add
  | 'moderator'     // User directs who speaks
  | 'parallel'      // All respond simultaneously
  | 'relevance';    // System picks most relevant voice

export interface OrchestrationConfig {
  /** Primary interaction pattern */
  mode: CouncilMode;

  /** How turns are allocated */
  turnStrategy: TurnStrategy;

  /** Max turns before synthesis/checkpoint */
  maxTurnsPerRound: number;

  /** Hard stop for total turns */
  maxTotalTurns?: number;

  /** Generate synthesis after each round */
  autoSynthesize: boolean;

  /** Which persona synthesizes (or "system") */
  synthesizerId?: string;

  /** Natural language criteria for convergence */
  convergenceCriteria?: string;

  /** Must end with clear decision/output */
  requiresResolution: boolean;
}

export interface Council {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;

  /** What's being discussed */
  topic: string;

  /** Shared context for all personas */
  sharedContext: SharedContext;

  /** Participating personas */
  personas: Persona[];

  /** How personas interact */
  orchestration: OrchestrationConfig;

  /** The conversation */
  messages: CouncilMessage[];

  /** Current state */
  status: 'active' | 'paused' | 'resolved';

  /** Final resolution if resolved */
  resolution?: Resolution;

  /** Usage metrics */
  totalTokensUsed: number;
  estimatedCost: number;
}

// ============================================================================
// Message Types
// ============================================================================

export interface Claim {
  id: string;
  text: string;
  type: 'assertion' | 'question' | 'proposal' | 'objection';
  supportedBy?: string[];
  opposedBy?: string[];
}

export interface CouncilMessage {
  id: string;
  timestamp: string;

  /** Who said it - Persona ID, "user", or "system" */
  speakerId: string;
  speakerType: 'persona' | 'user' | 'system';

  /** Message content */
  content: string;

  /** Message being responded to */
  replyingTo?: string;

  /** For branched conversations */
  threadId?: string;

  /** Semantic metadata (can be LLM-generated) */
  sentiment?: 'agree' | 'disagree' | 'partial' | 'neutral' | 'question';

  /** Brief summary of position taken */
  stance?: string;

  /** How strongly held (0-1) */
  confidence?: number;

  /** Claims made in this message */
  claims?: Claim[];

  /** Token usage for this message */
  tokensUsed: number;

  /** Response latency */
  latencyMs: number;
}

export interface Resolution {
  /** Summary of the deliberation */
  summary: string;

  /** Consensus level 0-1 */
  consensusLevel: number;

  /** Key decisions reached */
  keyDecisions: string[];

  /** Areas of agreement */
  agreements?: string[];

  /** Key tensions identified */
  tensions?: string[];

  /** Unresolved disagreements */
  dissent?: string[];

  /** Recommended next steps */
  nextSteps?: string[];

  /** Who generated this resolution */
  generatedBy: string;
}

// ============================================================================
// Event Types
// ============================================================================

export type CouncilEvent =
  | { type: 'persona-added'; persona: Persona }
  | { type: 'persona-removed'; personaId: string }
  | { type: 'persona-muted'; personaId: string }
  | { type: 'persona-unmuted'; personaId: string }
  | { type: 'turn-started'; personaId: string }
  | { type: 'turn-chunk'; personaId: string; content: string }
  | { type: 'turn-completed'; message: CouncilMessage }
  | { type: 'synthesis-started'; synthesizerId: string }
  | { type: 'synthesis-generated'; resolution: Resolution }
  | { type: 'consensus-updated'; level: number }
  | { type: 'council-resolved'; resolution: Resolution }
  | { type: 'council-paused' }
  | { type: 'council-resumed' }
  | { type: 'error'; error: string };

// ============================================================================
// Cost Estimation Types
// ============================================================================

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  model: string;
}

export interface RoundCostEstimate {
  personas: Array<{
    personaId: string;
    personaName: string;
    estimate: CostEstimate;
  }>;
  synthesis?: CostEstimate;
  total: number;
}

// ============================================================================
// Turn Context Types
// ============================================================================

export interface TurnContext {
  /** Recent messages for context */
  recentMessages: CouncilMessage[];

  /** Current topic being discussed */
  currentTopic: string;

  /** Unanswered questions */
  openQuestions: string[];

  /** User's direction for this turn */
  speakerInstruction?: string;

  /** Previous speaker (for react strategy) */
  previousSpeaker?: Persona;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface CreateCouncilRequest {
  name: string;
  topic: string;
  sharedContext?: Partial<SharedContext>;
  personas?: Array<Partial<Persona> & { templateId?: string }>;
  orchestration?: Partial<OrchestrationConfig>;
}

export interface AddPersonaRequest {
  templateId?: string;
  persona?: Partial<Persona>;
}

export interface SendMessageRequest {
  content: string;
  replyingTo?: string;
}

export interface AskPersonaRequest {
  personaId: string;
  question: string;
}

export interface DebateRequest {
  personaIds: [string, string];
  topic?: string;
}

export interface SteelmanRequest {
  askingPersonaId: string;
  targetPersonaId: string;
}

// ============================================================================
// UI State Types
// ============================================================================

export interface CouncilViewState {
  selectedPersonaId: string | null;
  isAddingPersona: boolean;
  isGeneratingTurn: boolean;
  isGeneratingSynthesis: boolean;
  showArgumentMap: boolean;
  showPositionSpectrum: boolean;
  streamingContent: Map<string, string>;
}

export interface PersonaPosition {
  personaId: string;
  position: number; // -1 to 1 on spectrum
  label: string;
  confidence: number;
}

export interface ArgumentNode {
  id: string;
  claimId: string;
  text: string;
  type: 'for' | 'against' | 'modify';
  personaId: string;
  children: ArgumentNode[];
}

export interface ArgumentMap {
  rootClaim: string;
  nodes: ArgumentNode[];
}
