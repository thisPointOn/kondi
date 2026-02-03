/**
 * FlowForge Execution Controller
 * Handles workflow execution operations
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { WorkflowStore, getDefaultWorkflowStore } from '../state/store.js';
import { StateManager, getDefaultStateManager } from '../state/manager.js';
import { CheckpointManager, getDefaultCheckpointManager } from '../state/checkpoint.js';
import { HistoryManager, getDefaultHistoryManager } from '../state/history.js';
import { Executor, getDefaultExecutor } from '../executor/executor.js';
import { EventBroadcaster, getDefaultBroadcaster } from './events.js';
import {
  WorkflowNotFoundError,
  ExecutionNotFoundError,
  CheckpointNotFoundError,
} from '../core/errors.js';

// ============================================================================
// Types
// ============================================================================

export interface ExecutionControllerConfig {
  store?: WorkflowStore;
  stateManager?: StateManager;
  checkpointManager?: CheckpointManager;
  historyManager?: HistoryManager;
  executor?: Executor;
  broadcaster?: EventBroadcaster;
}

// ============================================================================
// Controller
// ============================================================================

export class ExecutionController {
  private store: WorkflowStore;
  private stateManager: StateManager;
  private checkpointManager: CheckpointManager;
  private historyManager: HistoryManager;
  private executor: Executor;
  private broadcaster: EventBroadcaster;

  constructor(config?: ExecutionControllerConfig) {
    this.store = config?.store || getDefaultWorkflowStore();
    this.stateManager = config?.stateManager || getDefaultStateManager();
    this.checkpointManager = config?.checkpointManager || getDefaultCheckpointManager();
    this.historyManager = config?.historyManager || getDefaultHistoryManager();
    this.executor = config?.executor || getDefaultExecutor();
    this.broadcaster = config?.broadcaster || getDefaultBroadcaster();
  }

  /**
   * Start a new workflow execution
   * POST /api/workflows/:id/execute
   */
  execute = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const { inputs = {}, metadata = {} } = req.body;

      // Get the workflow
      const workflow = await this.store.getWorkflow(id);

      // Validate inputs against workflow input definitions
      const missingInputs = workflow.inputs
        .filter((input) => input.required && inputs[input.name] === undefined)
        .map((input) => input.name);

      if (missingInputs.length > 0) {
        res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_INPUTS',
            message: `Missing required inputs: ${missingInputs.join(', ')}`,
            missingInputs,
          },
        });
        return;
      }

      // Start execution (non-blocking)
      const result = await this.executor.execute(workflow, {
        inputs,
        metadata: {
          ...metadata,
          triggeredBy: (req as any).user?.id || 'anonymous',
          triggerType: 'api',
        },
      });

      res.status(202).json({
        success: true,
        data: {
          executionId: result.executionId,
          workflowId: workflow.id,
          status: result.status,
          message: 'Execution started',
        },
      });
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        res.status(404).json({
          success: false,
          error: {
            code: 'WORKFLOW_NOT_FOUND',
            message: error.message,
          },
        });
        return;
      }
      next(error);
    }
  };

  /**
   * Get execution state
   * GET /api/executions/:id
   */
  get = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;

      const state = await this.stateManager.getExecution(id);

      res.json({
        success: true,
        data: state,
      });
    } catch (error) {
      if (error instanceof ExecutionNotFoundError) {
        res.status(404).json({
          success: false,
          error: {
            code: 'EXECUTION_NOT_FOUND',
            message: error.message,
          },
        });
        return;
      }
      next(error);
    }
  };

  /**
   * List executions
   * GET /api/executions
   */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { workflowId, status, limit, offset } = req.query;

      const executions = await this.stateManager.listExecutions({
        workflowId: workflowId as string,
        status: status as any,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
      });

      res.json({
        success: true,
        data: executions,
        meta: {
          total: executions.length,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Resume execution from checkpoint
   * POST /api/executions/:id/resume
   */
  resume = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const { checkpointId } = req.body;

      // Get the original execution state
      const originalState = await this.stateManager.getExecution(id);

      // Get the workflow
      const workflow = await this.store.getWorkflow(originalState.workflowId);

      // Restore from checkpoint
      const checkpoint = checkpointId || (await this.checkpointManager.getLatestCheckpoint(id));
      if (!checkpoint) {
        res.status(400).json({
          success: false,
          error: {
            code: 'NO_CHECKPOINT',
            message: 'No checkpoint available to resume from',
          },
        });
        return;
      }

      // Start resumed execution
      const result = await this.executor.execute(workflow, {
        inputs: originalState.inputs,
        checkpointId: typeof checkpoint === 'string' ? checkpoint : checkpoint.id,
        metadata: {
          ...originalState.metadata,
          resumedFrom: id,
        },
      });

      res.status(202).json({
        success: true,
        data: {
          executionId: result.executionId,
          workflowId: workflow.id,
          status: result.status,
          resumedFrom: id,
          message: 'Execution resumed',
        },
      });
    } catch (error) {
      if (error instanceof ExecutionNotFoundError) {
        res.status(404).json({
          success: false,
          error: {
            code: 'EXECUTION_NOT_FOUND',
            message: error.message,
          },
        });
        return;
      }
      if (error instanceof CheckpointNotFoundError) {
        res.status(404).json({
          success: false,
          error: {
            code: 'CHECKPOINT_NOT_FOUND',
            message: error.message,
          },
        });
        return;
      }
      next(error);
    }
  };

  /**
   * Abort execution
   * POST /api/executions/:id/abort
   */
  abort = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      await this.executor.abort(id, reason);

      res.json({
        success: true,
        message: 'Execution aborted',
      });
    } catch (error) {
      if (error instanceof ExecutionNotFoundError) {
        res.status(404).json({
          success: false,
          error: {
            code: 'EXECUTION_NOT_FOUND',
            message: error.message,
          },
        });
        return;
      }
      next(error);
    }
  };

  /**
   * Approve a step
   * POST /api/executions/:id/steps/:stepId/approve
   */
  approveStep = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id, stepId } = req.params;
      const { approved, approvedBy } = req.body;

      if (approved === undefined) {
        res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_APPROVAL',
            message: 'The "approved" field is required',
          },
        });
        return;
      }

      await this.executor.approveStep(
        id,
        stepId,
        approved,
        approvedBy || (req as any).user?.id || 'anonymous'
      );

      res.json({
        success: true,
        message: approved ? 'Step approved' : 'Step rejected',
      });
    } catch (error) {
      if (error instanceof ExecutionNotFoundError) {
        res.status(404).json({
          success: false,
          error: {
            code: 'EXECUTION_NOT_FOUND',
            message: error.message,
          },
        });
        return;
      }
      next(error);
    }
  };

  /**
   * Get step details
   * GET /api/executions/:id/steps/:stepId
   */
  getStep = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id, stepId } = req.params;

      const stepState = await this.stateManager.getStepState(id, stepId);

      res.json({
        success: true,
        data: stepState,
      });
    } catch (error) {
      if (error instanceof ExecutionNotFoundError) {
        res.status(404).json({
          success: false,
          error: {
            code: 'EXECUTION_NOT_FOUND',
            message: error.message,
          },
        });
        return;
      }
      next(error);
    }
  };

  /**
   * Get execution checkpoints
   * GET /api/executions/:id/checkpoints
   */
  getCheckpoints = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;

      const checkpoints = await this.checkpointManager.listCheckpoints(id);

      res.json({
        success: true,
        data: checkpoints,
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get execution history
   * GET /api/executions/:id/history
   */
  getHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;

      const history = await this.historyManager.getExecutionEvents(id);

      res.json({
        success: true,
        data: history,
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * SSE event stream for execution
   * GET /api/executions/:id/events
   */
  events = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;

      // Verify execution exists
      await this.stateManager.getExecution(id);

      // Register SSE client
      const clientId = uuidv4();
      this.broadcaster.addClient(clientId, id, res);

      // Note: Response will be kept open until client disconnects
      // The broadcaster handles sending events and cleanup
    } catch (error) {
      if (error instanceof ExecutionNotFoundError) {
        res.status(404).json({
          success: false,
          error: {
            code: 'EXECUTION_NOT_FOUND',
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

let defaultController: ExecutionController | null = null;

export function getExecutionController(): ExecutionController {
  if (!defaultController) {
    defaultController = new ExecutionController();
  }
  return defaultController;
}
