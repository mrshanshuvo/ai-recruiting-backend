import { z } from 'zod';
import { PendingActionService } from '../../services/pending-action.service';

export const confirmActionInputSchema = z.object({
  actionId: z
    .string()
    .optional()
    .describe('The ID of the PendingAction to confirm. If omitted, the single active pending action in this conversation will be used.'),
});

export async function executeConfirmAction(
  input: z.infer<typeof confirmActionInputSchema>,
  conversationId: string
) {
  try {
    const { resolvedId, error } = await PendingActionService.resolveActionId(
      conversationId,
      input.actionId,
      'confirm'
    );

    if (error || !resolvedId) {
      return {
        success: false,
        error: error || 'Could not resolve pending action to confirm.',
      };
    }

    const result = await PendingActionService.confirmAction(resolvedId, conversationId);
    const appliedEdits = result.result?.appliedEdits as Record<string, unknown> | undefined;
    let message = `Confirmed and created job "${result.result?.title}" (${result.result?.jobId}).`;
    if (appliedEdits && Object.keys(appliedEdits).length > 0) {
      const editDetails = Object.entries(appliedEdits)
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(', ');
      message += ` Applied edited values: ${editDetails}.`;
    }

    return {
      success: true,
      actionId: result.actionId,
      status: result.status,
      result: result.result,
      message,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

