/**
 * Council: Multi-Model Deliberation System
 * Main export file
 */

// Types
export * from './types';

// Validation
export * from './validation';

// Templates
export {
  strategicTemplates,
  technicalTemplates,
  creativeTemplates,
  domainTemplates,
  allTemplates,
  templatesByCategory,
  templateCategories,
  getTemplateByName,
  getTemplatesByCategory,
  createPersonaFromTemplate,
  suggestedCombinations,
} from './templates';

// Store
export {
  getAllCouncils,
  getCouncil,
  createCouncil,
  updateCouncil,
  deleteCouncil,
  addPersona,
  updatePersona,
  removePersona,
  setPersonaMuted,
  addMessage,
  getMessages,
  setCouncilStatus,
  setResolution,
  updateCost,
  searchCouncils,
  getCouncilsByStatus,
  getActiveCouncils,
  getRecentCouncils,
  exportCouncil,
  importCouncil,
  duplicateCouncil,
  councilStore,
  CouncilStore,
} from './store';

// Prompts
export {
  buildPersonaSystemPrompt,
  buildConversationContext,
  buildSynthesisPrompt,
  buildDebatePrompt,
  buildSteelmanPrompt,
  buildCommonGroundPrompt,
  buildAskPrompt,
  buildVotePrompt,
  extractOpenQuestions,
} from './prompts';

// Turn Strategies
export {
  selectNextSpeaker,
  isRoundComplete,
  getUnheardPersonas,
  selectDebateOpponents,
  calculateRoundOrder,
} from './turn-strategies';

// Synthesis
export {
  parseSynthesisResponse,
  calculateConsensus,
  extractKeyClaims,
  findAgreements,
  findTensions,
  summarizePositions,
  prepareSynthesisRequest,
  quickConsensusCheck,
  createRoundSummary,
} from './synthesis';

// Orchestrator
export {
  CouncilOrchestrator,
  createOrchestrator,
  estimateTurnCost,
  estimateRoundCost,
  type LLMProvider,
  type OrchestratorConfig,
} from './orchestrator';
