import { Request, Response } from 'express';
import { PendingActionService, ActionError } from '../services/pending-action.service';

export class ActionController {
  public static async confirm(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { modifiedPayload } = req.body || {};

      const result = await PendingActionService.confirmAction(id, undefined, modifiedPayload);

      res.status(200).json({
        success: true,
        actionId: result.actionId,
        status: result.status,
        result: result.result,
      });
    } catch (error) {
      if (error instanceof ActionError) {
        res.status(error.statusCode).json({
          success: false,
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        });
        return;
      }

      console.error('[ActionController.confirm]', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to confirm action',
        },
      });
    }
  }

  public static async cancel(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { reason } = req.body || {};

      const result = await PendingActionService.cancelAction(id, undefined, reason);

      res.status(200).json({
        success: true,
        actionId: result.actionId,
        status: result.status,
      });
    } catch (error) {
      if (error instanceof ActionError) {
        res.status(error.statusCode).json({
          success: false,
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        });
        return;
      }

      console.error('[ActionController.cancel]', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to cancel action',
        },
      });
    }
  }

  public static async updatePayload(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { editedPayload } = req.body || {};

      if (!editedPayload || typeof editedPayload !== 'object') {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Missing or invalid editedPayload object',
          },
        });
        return;
      }

      const action = await PendingActionService.updatePayload(id, editedPayload);

      res.status(200).json({
        success: true,
        actionId: action._id.toString(),
        status: action.status,
      });
    } catch (error) {
      if (error instanceof ActionError) {
        res.status(error.statusCode).json({
          success: false,
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        });
        return;
      }

      console.error('[ActionController.updatePayload]', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to update action payload',
        },
      });
    }
  }
}

