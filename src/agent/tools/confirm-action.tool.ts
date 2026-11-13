import { z } from 'zod';
import { PendingActionService } from '../../services/pending-action.service';
import { PendingAction } from '../../models';

export const confirmActionInputSchema = z.object({
  actionId: z
    .string()
    .optional()
    .describe('The ID of the PendingAction to confirm. If omitted, the most recent pending action is confirmed.'),
});

export async function executeConfirmAction(
  input: z.infer<typeof confirmActionInputSchema>,
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
          error: 'No active pending action found to confirm.',
        };
      }
      actionId = latestPending._id.toString();
    }

    const result = await PendingActionService.confirmAction(actionId, conversationId);
    return {
      success: true,
      actionId: result.actionId,
      status: result.status,
      result: result.result,
      message: `Action confirmed and successfully executed. Created record details: ${JSON.stringify(result.result)}`,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

