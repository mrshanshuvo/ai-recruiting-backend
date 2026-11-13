import { z } from 'zod';
import { PendingActionService } from '../../services/pending-action.service';
import { PendingAction } from '../../models';

export const cancelActionInputSchema = z.object({
  actionId: z
    .string()
    .optional()
    .describe('The ID of the PendingAction to cancel. If omitted, the most recent pending action is cancelled.'),
  reason: z.string().optional().describe('Optional reason for cancellation'),
});

export async function executeCancelAction(
  input: z.infer<typeof cancelActionInputSchema>,
  conversationId: string
) {
  try {
    let actionId = input.actionId;
    if (!actionId) {
      const latestPending = await PendingAction.findOne({
        conversationId,
        status: 'PENDING',
      }).sort({ createdAt: -1 });

      if (!latestPending) {
        return {
          success: false,
          error: 'No active pending action found to cancel.',
        };
      }
      actionId = latestPending._id.toString();
    }

    const result = await PendingActionService.cancelAction(actionId, conversationId, input.reason);
    return {
      success: true,
      actionId: result.actionId,
      status: result.status,
      message: `Action ${actionId} was cancelled.`,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

