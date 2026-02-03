/**
 * FlowForge API Routes
 * Express route definitions for workflow, execution, and planner endpoints
 */

import { Router, Request, Response, NextFunction } from 'express';
import { getWorkflowController, WorkflowController } from './workflow.controller.js';
import { getExecutionController, ExecutionController } from './execution.controller.js';
import { getPlannerController, PlannerController } from './planner.controller.js';

// ============================================================================
// Types
// ============================================================================

export interface RouteConfig {
  workflowController?: WorkflowController;
  executionController?: ExecutionController;
  plannerController?: PlannerController;
  /** Optional auth middleware */
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void;
}

// ============================================================================
// Error Handler Middleware
// ============================================================================

function errorHandler(err: Error, req: Request, res: Response, next: NextFunction): void {
  console.error('FlowForge API Error:', err);

  // Default error response
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production'
        ? 'An internal error occurred'
        : err.message,
    },
  });
}

// ============================================================================
// Route Factory
// ============================================================================

export function createFlowForgeRoutes(config?: RouteConfig): Router {
  const router = Router();

  // Get controllers
  const workflowController = config?.workflowController || getWorkflowController();
  const executionController = config?.executionController || getExecutionController();
  const plannerController = config?.plannerController || getPlannerController();

  // Apply auth middleware if provided
  if (config?.authMiddleware) {
    router.use(config.authMiddleware);
  }

  // ============================================================================
  // Workflow Routes
  // ============================================================================

  /**
   * @route POST /api/workflows/validate
   * @description Validate a workflow spec without saving
   */
  router.post('/workflows/validate', workflowController.validate);

  /**
   * @route GET /api/workflows
   * @description List all workflows
   * @query status - Filter by status (draft, ready, archived)
   * @query tags - Filter by tags
   * @query search - Search in name and description
   * @query limit - Pagination limit
   * @query offset - Pagination offset
   */
  router.get('/workflows', workflowController.list);

  /**
   * @route POST /api/workflows
   * @description Create a new workflow
   * @body WorkflowSpec - The workflow specification
   */
  router.post('/workflows', workflowController.create);

  /**
   * @route GET /api/workflows/:id
   * @description Get a workflow by ID
   */
  router.get('/workflows/:id', workflowController.get);

  /**
   * @route PUT /api/workflows/:id
   * @description Update a workflow
   * @body Partial<WorkflowSpec> - Fields to update
   */
  router.put('/workflows/:id', workflowController.update);

  /**
   * @route DELETE /api/workflows/:id
   * @description Delete a workflow
   */
  router.delete('/workflows/:id', workflowController.delete);

  /**
   * @route POST /api/workflows/:id/duplicate
   * @description Duplicate a workflow
   * @body name - Optional new name for the duplicate
   */
  router.post('/workflows/:id/duplicate', workflowController.duplicate);

  /**
   * @route PATCH /api/workflows/:id/status
   * @description Update workflow status
   * @body status - New status (draft, ready, archived)
   */
  router.patch('/workflows/:id/status', workflowController.updateStatus);

  /**
   * @route POST /api/workflows/:id/execute
   * @description Start a workflow execution
   * @body inputs - Input values for the workflow
   * @body metadata - Optional execution metadata
   */
  router.post('/workflows/:id/execute', executionController.execute);

  // ============================================================================
  // Execution Routes
  // ============================================================================

  /**
   * @route GET /api/executions
   * @description List executions
   * @query workflowId - Filter by workflow
   * @query status - Filter by status
   * @query limit - Pagination limit
   * @query offset - Pagination offset
   */
  router.get('/executions', executionController.list);

  /**
   * @route GET /api/executions/:id
   * @description Get execution state
   */
  router.get('/executions/:id', executionController.get);

  /**
   * @route POST /api/executions/:id/resume
   * @description Resume execution from checkpoint
   * @body checkpointId - Optional specific checkpoint to resume from
   */
  router.post('/executions/:id/resume', executionController.resume);

  /**
   * @route POST /api/executions/:id/abort
   * @description Abort an execution
   * @body reason - Optional abort reason
   */
  router.post('/executions/:id/abort', executionController.abort);

  /**
   * @route GET /api/executions/:id/checkpoints
   * @description Get execution checkpoints
   */
  router.get('/executions/:id/checkpoints', executionController.getCheckpoints);

  /**
   * @route GET /api/executions/:id/history
   * @description Get execution history/events
   */
  router.get('/executions/:id/history', executionController.getHistory);

  /**
   * @route GET /api/executions/:id/events
   * @description SSE event stream for execution
   */
  router.get('/executions/:id/events', executionController.events);

  /**
   * @route GET /api/executions/:id/steps/:stepId
   * @description Get step details
   */
  router.get('/executions/:id/steps/:stepId', executionController.getStep);

  /**
   * @route POST /api/executions/:id/steps/:stepId/approve
   * @description Approve or reject a step
   * @body approved - Boolean indicating approval
   * @body approvedBy - Optional approver identifier
   */
  router.post('/executions/:id/steps/:stepId/approve', executionController.approveStep);

  // ============================================================================
  // Planner Routes
  // ============================================================================

  /**
   * @route GET /api/planner/sessions
   * @description List planning sessions
   * @query status - Filter by status (active, completed, abandoned)
   */
  router.get('/planner/sessions', plannerController.listSessions);

  /**
   * @route POST /api/planner/start
   * @description Start a new planning session
   * @body availableTools - Optional list of available MCP tools
   */
  router.post('/planner/start', plannerController.start);

  /**
   * @route GET /api/planner/:sessionId
   * @description Get planning session details
   */
  router.get('/planner/:sessionId', plannerController.getSession);

  /**
   * @route POST /api/planner/:sessionId/message
   * @description Send a message to the planner
   * @body message - The user's message
   */
  router.post('/planner/:sessionId/message', plannerController.sendMessage);

  /**
   * @route GET /api/planner/:sessionId/spec
   * @description Get the current proposed workflow spec
   */
  router.get('/planner/:sessionId/spec', plannerController.getSpec);

  /**
   * @route PATCH /api/planner/:sessionId/spec
   * @description Apply a direct edit to the spec
   * @body Partial<WorkflowSpec> - Fields to update
   */
  router.patch('/planner/:sessionId/spec', plannerController.editSpec);

  /**
   * @route POST /api/planner/:sessionId/validate
   * @description Validate the current spec
   */
  router.post('/planner/:sessionId/validate', plannerController.validate);

  /**
   * @route POST /api/planner/:sessionId/generate-step
   * @description Generate a workflow step from a task description
   * @body task - Description of what the step should do
   */
  router.post('/planner/:sessionId/generate-step', plannerController.generateStep);

  /**
   * @route GET /api/planner/:sessionId/history
   * @description Get conversation history
   */
  router.get('/planner/:sessionId/history', plannerController.getHistory);

  /**
   * @route POST /api/planner/:sessionId/complete
   * @description Complete the session and save the workflow
   * @body saveAsReady - If true, save as ready; otherwise save as draft
   */
  router.post('/planner/:sessionId/complete', plannerController.complete);

  /**
   * @route POST /api/planner/:sessionId/abandon
   * @description Abandon the planning session
   */
  router.post('/planner/:sessionId/abandon', plannerController.abandon);

  // ============================================================================
  // Error Handler
  // ============================================================================

  router.use(errorHandler);

  return router;
}

// ============================================================================
// Default Export
// ============================================================================

export default createFlowForgeRoutes;
