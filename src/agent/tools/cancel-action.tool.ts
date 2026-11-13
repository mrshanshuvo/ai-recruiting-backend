import { z } from 'zod';
import { PendingActionService } from '../../services/pending-action.service';

export const cancelActionInputSchema = z.object({
  actionId: z
    .string()
    .optional()
    .describe('The ID of the PendingAction to cancel. If omitted, the single active pending action in this conversation will be used.'),
  reason: z.string().optional().describe('Optional reason for cancellation'),
});

export async function executeCancelAction(
  input: z.infer<typeof cancelActionInputSchema>,
  conversationId: string
) {
  try {
    const { resolvedId, error } = await PendingActionService.resolveActionId(
      conversationId,
      input.actionId,
      'cancel'
    );

    if (error || !resolvedId) {
      return {
        success: false,
        error: error || 'Could not resolve pending action to cancel.',
      };
    }

    const result = await PendingActionService.cancelAction(resolvedId, conversationId, input.reason);
    return {
      success: true,
      actionId: result.actionId,
      status: result.status,
      message: `Action ${result.actionId} was cancelled.`,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

