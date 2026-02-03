/**
 * FlowForge Planner Controller
 * Handles interactive workflow planning conversations
 */

import { Request, Response, NextFunction } from 'express';
import {
  Planner,
  getDefaultPlanner,
  PlannerConfig,
} from '../planner/planner.js';
import { SessionManager, getDefaultSessionManager } from '../planner/session.js';
import { WorkflowStore, getDefaultWorkflowStore } from '../state/store.js';
import {
  PlanningSessionNotFoundError,
  PlanningSessionClosedError,
} from '../core/errors.js';
import { WorkflowSpec } from '../core/types.js';

// ============================================================================
// Types
// ============================================================================

export interface PlannerControllerConfig {
  planner?: Planner;
  sessionManager?: SessionManager;
  workflowStore?: WorkflowStore;
}

// ============================================================================
// Controller
// ============================================================================

export class PlannerController {
  private planner: Planner;
  private sessionManager: SessionManager;
  private workflowStore: WorkflowStore;

  constructor(config?: PlannerControllerConfig) {
    this.planner = config?.planner || getDefaultPlanner();
    this.sessionManager = config?.sessionManager || getDefaultSessionManager();
    this.workflowStore = config?.workflowStore || getDefaultWorkflowStore();
  }

  /**
   * Start a new planning session
   * POST /api/planner/start
   */
  start = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { availableTools } = req.body;

      // Set available tools if provided
      if (availableTools && Array.isArray(availableTools)) {
        this.planner.setAvailableTools(availableTools);
      }

      const { session, greeting } = await this.planner.startSession();

      res.status(201).json({
        success: true,
        data: {
          sessionId: session.id,
          greeting,
          status: session.status,
          createdAt: session.createdAt,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Send a message to the planner
   * POST /api/planner/:sessionId/message
   */
  sendMessage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sessionId } = req.params;
      const { message } = req.body;

      if (!message || typeof message !== 'string') {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_MESSAGE',
            message: 'Message is required and must be a string',
          },
        });
        return;
      }

      const response = await this.planner.sendMessage(sessionId, message);

      res.json({
        success: true,
        data: {
          message: response.message,
          specUpdate: response.specUpdate,
          isComplete: response.isComplete,
          validation: response.validation,
        },
      });
    } catch (error) {
      if (error instanceof PlanningSessionNotFoundError) {
        res.status(404).json({
          success: false,
          error: {
            code: 'SESSION_NOT_FOUND',
            message: error.message,
          },
        });
        return;
      }
      if (error instanceof PlanningSessionClosedError) {
        res.status(400).json({
          success: false,
          error: {
            code: 'SESSION_CLOSED',
            message: error.message,
          },
        });
        return;
      }
      next(error);
    }
  };

  /**
   * Get the current proposed spec
   * GET /api/planner/:sessionId/spec
   */
  getSpec = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sessionId } = req.params;

      const spec = await this.planner.getSpec(sessionId);

      res.json({
        success: true,
        data: spec || null,
      });
    } catch (error) {
      if (error instanceof PlanningSessionNotFoundError) {
        res.status(404).json({
          success: false,
          error: {
            code: 'SESSION_NOT_FOUND',
            message: error.message,
          },
        });
        return;
      }
      next(error);
    }
  };

  /**
   * Apply a direct edit to the spec
   * PATCH /api/planner/:sessionId/spec
   */
  editSpec = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sessionId } = req.params;
      const specEdit = req.body;

      const response = await this.planner.applyEdit(sessionId, specEdit);

      res.json({
        success: true,
        data: {
          message: response.message,
          spec: response.specUpdate,
          isComplete: response.isComplete,
        },
      });
    } catch (error) {
      if (error instanceof PlanningSessionNotFoundError) {
        res.status(404).json({
          success: false,
          error: {
            code: 'SESSION_NOT_FOUND',
            message: error.message,
          },
        });
        return;
      }
      if (error instanceof PlanningSessionClosedError) {
        res.status(400).json({
          success: false,
          error: {
            code: 'SESSION_CLOSED',
            message: error.message,
          },
        });
        return;
      }
      next(error);
    }
  };

  /**
   * Validate the current spec
   * POST /api/planner/:sessionId/validate
   */
  validate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sessionId } = req.params;

      const validation = await this.planner.validateSpec(sessionId);

      res.json({
        success: true,
        data: validation,
      });
    } catch (error) {
      if (error instanceof PlanningSessionNotFoundError) {
        res.status(404).json({
          success: false,
          error: {
            code: 'SESSION_NOT_FOUND',
            message: error.message,
          },
        });
        return;
      }
      next(error);
    }
  };

  /**
   * Generate a step from task description
   * POST /api/planner/:sessionId/generate-step
   */
  generateStep = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sessionId } = req.params;
      const { task } = req.body;

      if (!task || typeof task !== 'string') {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_TASK',
            message: 'Task description is required',
          },
        });
        return;
      }

      const result = await this.planner.generateStep(sessionId, task);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      if (error instanceof PlanningSessionNotFoundError) {
        res.status(404).json({
          success: false,
          error: {
            code: 'SESSION_NOT_FOUND',
            message: error.message,
          },
        });
        return;
      }
      next(error);
    }
  };

  /**
   * Get conversation history
   * GET /api/planner/:sessionId/history
   */
  getHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sessionId } = req.params;

      const history = await this.planner.getHistory(sessionId);

      res.json({
        success: true,
        data: history,
      });
    } catch (error) {
      if (error instanceof PlanningSessionNotFoundError) {
        res.status(404).json({
          success: false,
          error: {
            code: 'SESSION_NOT_FOUND',
            message: error.message,
          },
        });
        return;
      }
      next(error);
    }
  };

  /**
   * Complete the session and save the workflow
   * POST /api/planner/:sessionId/complete
   */
  complete = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sessionId } = req.params;
      const { saveAsReady } = req.body;

      // Complete the planning session
      const { session, spec } = await this.planner.completeSession(sessionId);

      if (!spec || !spec.name) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INCOMPLETE_SPEC',
            message: 'Cannot complete session without a valid workflow spec',
          },
        });
        return;
      }

      // Set status based on user preference
      const workflowSpec: Partial<WorkflowSpec> = {
        ...spec,
        status: saveAsReady ? 'ready' : 'draft',
      };

      // Save the workflow
      const savedWorkflow = await this.workflowStore.createWorkflow(workflowSpec as WorkflowSpec);

      res.json({
        success: true,
        data: {
          sessionId: session.id,
          workflowId: savedWorkflow.id,
          workflow: savedWorkflow,
          message: `Workflow "${savedWorkflow.name}" saved as ${savedWorkflow.status}`,
        },
      });
    } catch (error) {
      if (error instanceof PlanningSessionNotFoundError) {
        res.status(404).json({
          success: false,
          error: {
            code: 'SESSION_NOT_FOUND',
            message: error.message,
          },
        });
        return;
      }
      next(error);
    }
  };

  /**
   * Abandon the planning session
   * POST /api/planner/:sessionId/abandon
   */
  abandon = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sessionId } = req.params;

      await this.planner.abandonSession(sessionId);

      res.json({
        success: true,
        message: 'Planning session abandoned',
      });
    } catch (error) {
      if (error instanceof PlanningSessionNotFoundError) {
        res.status(404).json({
          success: false,
          error: {
            code: 'SESSION_NOT_FOUND',
            message: error.message,
          },
        });
        return;
      }
      next(error);
    }
  };

  /**
   * List active planning sessions
   * GET /api/planner/sessions
   */
  listSessions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { status } = req.query;

      const sessions = await this.sessionManager.listSessions(
        status as 'active' | 'completed' | 'abandoned' | undefined
      );

      res.json({
        success: true,
        data: sessions.map((s) => ({
          id: s.id,
          status: s.status,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: s.messages.length,
          hasSpec: !!s.currentSpec,
        })),
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get session details
   * GET /api/planner/:sessionId
   */
  getSession = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sessionId } = req.params;

      const session = await this.sessionManager.getSession(sessionId);

      res.json({
        success: true,
        data: {
          id: session.id,
          status: session.status,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: session.messages.length,
          currentSpec: session.currentSpec,
        },
      });
    } catch (error) {
      if (error instanceof PlanningSessionNotFoundError) {
        res.status(404).json({
          success: false,
          error: {
            code: 'SESSION_NOT_FOUND',
            message: error.message,
          },
        });
        return;
      }
      next(error);
    }
  };
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultController: PlannerController | null = null;

export function getPlannerController(): PlannerController {
  if (!defaultController) {
    defaultController = new PlannerController();
  }
  return defaultController;
}
