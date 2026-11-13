import { z } from 'zod';
import { PendingActionService } from '../../services/pending-action.service';

export const confirmActionInputSchema = z.object({
  actionId: z
    .string()
    .optional()
    .describe('The ID of the PendingAction to confirm. If omitted, the single active pending action in this conversation will be used.'),
});

function formatFieldDiff(original: Record<string, any> = {}, effective: Record<string, any> = {}): string[] {
  const changes: string[] = [];

  if (effective.title && effective.title !== original.title) {
    changes.push(`title is now "${effective.title}"`);
  }
  if (effective.location !== undefined && effective.location !== original.location) {
    changes.push(`location is now ${effective.location || 'not provided'}`);
  }
  if (effective.seniority !== undefined && effective.seniority !== original.seniority) {
    changes.push(`seniority is now ${effective.seniority || 'not provided'}`);
  }
  if (effective.remotePolicy && effective.remotePolicy !== original.remotePolicy) {
    changes.push(`remote policy is now ${effective.remotePolicy}`);
  }
  if (effective.salaryRange) {
    const origSal = original.salaryRange || {};
    const newSal = effective.salaryRange || {};
    if (newSal.min !== origSal.min || newSal.max !== origSal.max || newSal.currency !== origSal.currency) {
      if (newSal.min && newSal.max) {
        changes.push(`salary $${Number(newSal.min).toLocaleString()}-$${Number(newSal.max).toLocaleString()} ${newSal.currency || 'USD'}`);
      } else if (newSal.min) {
        changes.push(`salary from $${Number(newSal.min).toLocaleString()} ${newSal.currency || 'USD'}`);
      } else if (newSal.max) {
        changes.push(`salary up to $${Number(newSal.max).toLocaleString()} ${newSal.currency || 'USD'}`);
      }
    }
  }
  if (
    effective.mustHaveSkills &&
    JSON.stringify(effective.mustHaveSkills) !== JSON.stringify(original.mustHaveSkills)
  ) {
    changes.push(`must-have skills: ${effective.mustHaveSkills.join(', ')}`);
  }
  if (
    effective.niceToHaveSkills &&
    JSON.stringify(effective.niceToHaveSkills) !== JSON.stringify(original.niceToHaveSkills)
  ) {
    changes.push(`nice-to-have skills: ${effective.niceToHaveSkills.join(', ')}`);
  }

  return changes;
}

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
    let message = '';
    if (result.result?.bullJobId || (result.effectivePayload as any)?.searchQueries) {
      const jobTitle = (result.result?.jobTitle as string) || 'the role';
      const count = result.result?.targetCount || (result.effectivePayload as any)?.targetCount || 10;
      message = `Started candidate sourcing for '${jobTitle}'. Sourcing up to ${count} candidate profiles.`;
    } else if (result.result?.campaignId && result.result?.recipientCount !== undefined) {
      const title = (result.result?.jobTitle as string) || (result.effectivePayload as any)?.jobTitle || 'the role';
      const count = result.result?.recipientCount ?? (result.effectivePayload as any)?.recipientCount ?? 0;
      message = `Launched outreach campaign for '${title}' (${count} candidate(s)). Initial emails (Step 0) dispatched.`;
    } else if (result.result?.status === 'PAUSED') {
      message = `Paused outreach campaign. Scheduled follow-ups are suspended.`;
    } else if (result.result?.status === 'ACTIVE' && result.result?.campaignId) {
      message = `Resumed outreach campaign. Scheduled follow-ups are now active.`;
    } else if (result.result?.decision || (result.effectivePayload as any)?.candidateIds) {
      const decision = (result.result?.decision as string) || 'accept';
      const count = result.result?.updatedCount ?? (result.effectivePayload as any)?.candidateIds?.length ?? 0;
      message = `Confirmed bulk review: ${count} candidate(s) marked as ${decision === 'reject' ? 'Rejected' : 'Accepted'}.`;
    } else {
      const title = (result.result?.title as string) || (result.effectivePayload as any)?.title || 'Job Proposal';
      const diffs = formatFieldDiff(result.originalPayload, result.effectivePayload);
      message = `Created the job '${title}'.`;
      if (diffs.length > 0) {
        message = `Created the job '${title}'. I used your edits: ${diffs.join(', ')}.`;
      }
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

