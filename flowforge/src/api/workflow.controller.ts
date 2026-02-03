/**
 * FlowForge Workflow Controller
 * Handles workflow CRUD operations
 */

import { Request, Response, NextFunction } from 'express';
import { WorkflowStore, getDefaultWorkflowStore } from '../state/store.js';
import { validateWorkflowSpec } from '../core/schema.js';
import { WorkflowSpec } from '../core/types.js';
import { WorkflowNotFoundError } from '../core/errors.js';

// ============================================================================
// Types
// ============================================================================

export interface WorkflowControllerConfig {
  store?: WorkflowStore;
}

// ============================================================================
// Controller
// ============================================================================

export class WorkflowController {
  private store: WorkflowStore;

  constructor(config?: WorkflowControllerConfig) {
    this.store = config?.store || getDefaultWorkflowStore();
  }

  /**
   * List all workflows
   * GET /api/workflows
   */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { status, tags, search, limit, offset } = req.query;

      const workflows = await this.store.listWorkflows({
        status: status as WorkflowSpec['status'],
        tags: tags ? (Array.isArray(tags) ? tags as string[] : [tags as string]) : undefined,
        search: search as string,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
      });

      res.json({
        success: true,
        data: workflows,
        meta: {
          total: workflows.length,
          limit: limit ? parseInt(limit as string, 10) : undefined,
          offset: offset ? parseInt(offset as string, 10) : 0,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get a workflow by ID
   * GET /api/workflows/:id
   */
  get = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const workflow = await this.store.getWorkflow(id);

      res.json({
        success: true,
        data: workflow,
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
   * Create a new workflow
   * POST /api/workflows
   */
  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const specData = req.body;

      // Validate the spec
      const validation = validateWorkflowSpec(specData);
      if (!validation.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid workflow specification',
            details: validation.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
        });
        return;
      }

      const workflow = await this.store.createWorkflow(validation.data);

      res.status(201).json({
        success: true,
        data: workflow,
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Update a workflow
   * PUT /api/workflows/:id
   */
  update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const updates = req.body;

      // Partial validation - only validate provided fields
      const workflow = await this.store.updateWorkflow(id, updates);

      res.json({
        success: true,
        data: workflow,
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
   * Delete a workflow
   * DELETE /api/workflows/:id
   */
  delete = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;

      await this.store.deleteWorkflow(id);

      res.json({
        success: true,
        message: 'Workflow deleted successfully',
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
   * Duplicate a workflow
   * POST /api/workflows/:id/duplicate
   */
  duplicate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const { name } = req.body;

      const workflow = await this.store.duplicateWorkflow(id, name);

      res.status(201).json({
        success: true,
        data: workflow,
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
   * Update workflow status
   * PATCH /api/workflows/:id/status
   */
  updateStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const validStatuses = ['draft', 'ready', 'archived'];
      if (!validStatuses.includes(status)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_STATUS',
            message: `Status must be one of: ${validStatuses.join(', ')}`,
          },
        });
        return;
      }

      const workflow = await this.store.updateWorkflow(id, { status });

      res.json({
        success: true,
        data: workflow,
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
   * Validate a workflow spec without saving
   * POST /api/workflows/validate
   */
  validate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const specData = req.body;

      const validation = validateWorkflowSpec(specData);

      if (validation.success) {
        res.json({
          success: true,
          data: {
            valid: true,
            spec: validation.data,
          },
        });
      } else {
        res.json({
          success: true,
          data: {
            valid: false,
            errors: validation.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
        });
      }
    } catch (error) {
      next(error);
    }
  };
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultController: WorkflowController | null = null;

export function getWorkflowController(): WorkflowController {
  if (!defaultController) {
    defaultController = new WorkflowController();
  }
  return defaultController;
}
