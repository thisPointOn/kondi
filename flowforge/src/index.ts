/**
 * FlowForge - Self-Healing LLM Workflow Orchestration
 *
 * Main entry point exporting all public APIs
 */

// ============================================================================
// Core Types & Errors
// ============================================================================

export * from './core/types.js';
export * from './core/errors.js';
export {
  validateWorkflowSpec,
  validateStep,
  workflowSpecSchema,
  stepSchema,
} from './core/schema.js';

// ============================================================================
// Providers
// ============================================================================

export {
  LLMProvider,
  CompletionParams,
  CompletionResult,
  StreamChunk,
  Model,
  ProviderConfig,
} from './providers/interface.js';

export {
  providerRegistry,
  ProviderRegistry,
  ProviderUsageStats,
  RegistryConfig,
  getProvider,
  selectBestProvider,
  completeWithFailover,
} from './providers/registry.js';

export {
  authBridge,
  getDefaultAuthBridge,
} from './providers/auth-bridge.js';

// Provider Adapters
export { AnthropicAdapter, getAnthropicAdapter } from './providers/anthropic-adapter.js';
export { OpenAIAdapter, getOpenAIAdapter } from './providers/openai-adapter.js';
export { OpenAIOAuthAdapter, getOpenAIOAuthAdapter } from './providers/openai-oauth-adapter.js';
export { GeminiAdapter, getGeminiAdapter, GeminiConfig } from './providers/gemini-adapter.js';
export { OllamaAdapter, getOllamaAdapter } from './providers/ollama-adapter.js';
export { BedrockAdapter, getBedrockAdapter, BedrockConfig } from './providers/bedrock-adapter.js';
export { CopilotAdapter, getCopilotAdapter, CopilotConfig } from './providers/copilot-adapter.js';
export {
  OpenAICompatibleAdapter,
  OpenAICompatibleConfig,
  createOpenRouterAdapter,
  createGroqAdapter,
  createMoonshotAdapter,
  createVeniceAdapter,
  createTogetherAdapter,
  createDeepSeekAdapter,
  createXiaoMiAdapter,
} from './providers/openai-compatible-adapter.js';

// ============================================================================
// State Management
// ============================================================================

export {
  WorkflowStore,
  getDefaultWorkflowStore,
} from './state/store.js';

export {
  StateManager,
  getDefaultStateManager,
} from './state/manager.js';

export {
  CheckpointManager,
  getDefaultCheckpointManager,
} from './state/checkpoint.js';

export {
  HistoryManager,
  getDefaultHistoryManager,
} from './state/history.js';

// ============================================================================
// Executor
// ============================================================================

export {
  Executor,
  getDefaultExecutor,
  executeWorkflow,
  abortExecution,
  approveStep,
  ExecutorConfig,
  ExecutionOptions,
  ExecutionResult,
} from './executor/executor.js';

export {
  StepRunner,
  getDefaultStepRunner,
  StepExecutionContext,
  StepResult,
} from './executor/step-runner.js';

export {
  Evaluator,
  getDefaultEvaluator,
} from './executor/evaluator.js';

export {
  RetryLoop,
} from './executor/retry-loop.js';

export {
  ToolBridge,
  getDefaultToolBridge,
} from './executor/tool-bridge.js';

export {
  ParallelDetector,
  getDefaultParallelDetector,
  analyzeWorkflowParallelism,
  findParallelizableSteps,
  suggestParallelization,
} from './executor/parallel-detector.js';

export {
  ParallelCoordinator,
  getDefaultParallelCoordinator,
  executeParallelGroup,
  executeParallelStep,
  ParallelCoordinatorConfig,
  ParallelExecutionResult,
} from './executor/parallel.js';

// ============================================================================
// Kondi Integration
// ============================================================================

export {
  KondiAdapter,
  getDefaultKondiAdapter,
  executeParallel,
  getAgentStatus,
  abortParallelExecution,
} from './integrations/kondi/adapter.js';

export {
  KondiConfig,
  KondiHandoff,
  KondiResult,
  KondiEvent,
  KondiAgent,
  AgentResult,
  AgentStatus,
  SharedContext,
  ParallelGroup,
  ParallelAnalysis,
  MergeStrategies,
} from './integrations/kondi/types.js';

// ============================================================================
// Planner
// ============================================================================

export {
  Planner,
  getDefaultPlanner,
  startPlanningSession,
  sendPlannerMessage,
  getPlannerSpec,
  completePlannerSession,
  PlannerConfig,
  PlannerResponse,
} from './planner/planner.js';

export {
  SessionManager,
  getDefaultSessionManager,
} from './planner/session.js';

export {
  parseWorkflowSpec,
  parseStep,
  parseValidationResponse,
  diffSpecs,
  ParseResult,
  StepParseResult,
  ValidationResult,
} from './planner/parser.js';

// ============================================================================
// API
// ============================================================================

export {
  createFlowForgeRoutes,
  RouteConfig,
} from './api/routes.js';

export {
  EventBroadcaster,
  getDefaultBroadcaster,
  broadcastExecutorEvent,
  createEventHandler,
} from './api/events.js';

export {
  WorkflowController,
  getWorkflowController,
} from './api/workflow.controller.js';

export {
  ExecutionController,
  getExecutionController,
} from './api/execution.controller.js';

export {
  PlannerController,
  getPlannerController,
} from './api/planner.controller.js';

// ============================================================================
// Utilities
// ============================================================================

export {
  Logger,
  createLogger,
  createExecutionLogger,
} from './utils/logger.js';

export {
  enqueueWorkflowStep,
  setWorkflowConcurrency,
  clearWorkflowQueue,
} from './utils/queue.js';
