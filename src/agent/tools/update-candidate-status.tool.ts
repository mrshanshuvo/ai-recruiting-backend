import mongoose from 'mongoose';
import { z } from 'zod';
import { Candidate, CandidateStatus, Job } from '../../models';
import { PendingActionService } from '../../services/pending-action.service';
import { ALLOWED_TRANSITIONS } from '../../services/candidate-status.service';

export const updateCandidateStatusInputSchema = z.object({
  candidateId: z.string().optional().describe('Candidate ID to update'),
  candidateName: z.string().optional().describe('Candidate name to match if candidateId is omitted'),
  newStatus: z
    .enum([
      'Sourced',
      'Accepted',
      'Rejected',
      'Contacted',
      'Replied',
      'Interested',
      'Not interested',
      'Meeting booked',
      'Interviewed',
      'Shortlisted',
      'Hired',
      'Unsubscribed',
    ])
    .describe('New pipeline status for the candidate'),
  reason: z.string().optional().describe('Recruiter rationale for the status transition'),
});

export async function executeUpdateCandidateStatus(
  input: z.infer<typeof updateCandidateStatusInputSchema>,
  conversationId: string
) {
  let candidate = null;

  if (input.candidateId && mongoose.Types.ObjectId.isValid(input.candidateId)) {
    candidate = await Candidate.findById(input.candidateId);
  }

  if (!candidate && input.candidateName) {
    candidate = await Candidate.findOne({
      fullName: { $regex: new RegExp(`^${input.candidateName.trim()}$`, 'i') },
    });
    if (!candidate) {
      const partialMatches = await Candidate.find({
        fullName: { $regex: new RegExp(input.candidateName.trim(), 'i') },
      });
      if (partialMatches.length === 1) {
        candidate = partialMatches[0];
      } else if (partialMatches.length > 1) {
        return {
          success: false,
          error: `Multiple candidates found matching "${input.candidateName}": ${partialMatches.map((c) => c.fullName).join(', ')}. Please specify the exact full name or candidate ID.`,
        };
      }
    }
  }

  if (!candidate) {
    return {
      success: false,
      error: `Candidate "${input.candidateName || input.candidateId}" not found.`,
    };
  }

  const currentStatus = candidate.status;
  const newStatus = input.newStatus as CandidateStatus;

  // Validate state machine
  const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(newStatus) && newStatus !== currentStatus) {
    return {
      success: false,
      error: `Invalid transition: cannot advance candidate from '${currentStatus}' to '${newStatus}'. Allowed transitions from '${currentStatus}': ${allowed.join(', ')}.`,
    };
  }

  const job = await Job.findById(candidate.jobId).lean();
  const jobTitle = job?.title || 'Engineering Role';

  const pendingAction = await PendingActionService.createAction({
    conversationId,
    actionType: 'UPDATE_STATUS',
    payload: {
      candidateId: candidate._id.toString(),
      candidateName: candidate.fullName,
      jobId: candidate.jobId.toString(),
      jobTitle,
      previousStatus: currentStatus,
      newStatus,
      reason: input.reason || `Status update from ${currentStatus} to ${newStatus}`,
    },
  });

  return {
    success: true,
    message: `I prepared this, please confirm. I created a proposal to advance ${candidate.fullName} from "${currentStatus}" to "${newStatus}".`,
    card: {
      cardType: 'status_update',
      actionId: pendingAction._id.toString(),
      status: 'pending',
      payload: {
        candidateId: candidate._id.toString(),
        candidateName: candidate.fullName,
        jobId: candidate.jobId.toString(),
        jobTitle,
        previousStatus: currentStatus,
        newStatus,
        reason: input.reason || `Status update from ${currentStatus} to ${newStatus}`,
      },
    },
  };
}
