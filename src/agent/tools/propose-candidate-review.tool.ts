import mongoose from 'mongoose';
import { z } from 'zod';
import { Candidate, Job } from '../../models';
import { PendingActionService } from '../../services/pending-action.service';

export const proposeCandidateReviewInputSchema = z.object({
  jobId: z.string().describe('The job ID to review candidates for'),
  candidateIds: z
    .array(z.string())
    .optional()
    .describe('Array of candidate ObjectIds or full names to review. If omitted, topRemainingCount is used.'),
  topRemainingCount: z
    .number()
    .optional()
    .describe('Number of top remaining sourced candidates to review (e.g. 3, 5)'),
  decision: z.enum(['accept', 'reject']).describe('The proposed decision: accept or reject'),
  reason: z.string().optional().describe('Filter or selection reason, e.g. "top 3 remaining candidates"'),
});

export async function executeProposeCandidateReview(
  input: z.infer<typeof proposeCandidateReviewInputSchema>,
  conversationId: string
) {
  if (!mongoose.Types.ObjectId.isValid(input.jobId)) {
    return {
      success: false,
      error: 'Invalid jobId format',
    };
  }

  const dbJob = await Job.findById(input.jobId).lean();
  if (!dbJob) {
    return {
      success: false,
      error: 'Job not found',
    };
  }

  const rawList = input.candidateIds || [];
  const objectIds: mongoose.Types.ObjectId[] = [];
  const names: string[] = [];

  for (const item of rawList) {
    if (mongoose.Types.ObjectId.isValid(item)) {
      objectIds.push(new mongoose.Types.ObjectId(item));
    } else if (item && item.trim()) {
      names.push(item.trim());
    }
  }

  const orClauses: any[] = [];
  if (objectIds.length > 0) {
    orClauses.push({ _id: { $in: objectIds } });
  }
  if (names.length > 0) {
    orClauses.push({
      fullName: { $in: names.map((n) => new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')) },
    });
  }

  let candidates: any[] = [];
  if (orClauses.length > 0) {
    candidates = await Candidate.find({
      jobId: input.jobId,
      $or: orClauses,
    }).lean();
  }

  // Fallback: If no specific candidates resolved or topRemainingCount requested, pick top Sourced candidates
  if (candidates.length === 0) {
    const count = input.topRemainingCount || (rawList.length > 0 ? rawList.length : 3);
    candidates = await Candidate.find({
      jobId: input.jobId,
      status: 'Sourced',
    })
      .sort({ score: -1 })
      .limit(count)
      .lean();
  }

  if (candidates.length === 0) {
    return {
      success: false,
      error: 'No matching candidates found in database for review',
    };
  }

  // Map candidates preserving score, status, sourceMode, profileUrl, and emailStatus
  const mappedCandidates = candidates.map((c) => ({
    candidateId: c._id.toString(),
    fullName: c.fullName,
    currentTitle: c.currentTitle || 'Not provided',
    currentCompany: c.currentCompany || 'Not provided',
    score: c.score,
    scoreStatus: c.scoreStatus,
    scoreReason: c.scoreReason || 'Evaluated against job requirements',
    profileUrl: c.profileUrl || null,
    status: c.status,
    sourceMode: c.sourceMode,
    email: c.email || null,
    emailStatus: c.emailStatus,
  }));

  const targetStatus = input.decision === 'accept' ? 'Accepted' : 'Rejected';
  const candidateNames = candidates.map((c) => c.fullName).join(', ');
  const actionDescription =
    input.reason ||
    `Bulk ${input.decision} of ${candidates.length} candidate(s) (${candidateNames}) for ${dbJob.title}`;

  const pendingAction = await PendingActionService.createAction({
    conversationId,
    jobId: input.jobId,
    actionType: 'BULK_REVIEW',
    payload: {
      jobId: input.jobId,
      jobTitle: dbJob.title,
      decision: input.decision,
      targetStatus,
      candidateIds: candidates.map((c) => c._id.toString()),
      reason: actionDescription,
      candidates: mappedCandidates,
    },
    description: actionDescription,
  });

  return {
    success: true,
    message: `I prepared bulk review to ${input.decision} ${candidates.length} candidate(s) (${candidateNames}) for '${dbJob.title}'. Please review and confirm.`,
    card: {
      cardType: 'candidate_table',
      actionId: pendingAction._id.toString(),
      status: 'pending',
      payload: {
        jobId: input.jobId,
        jobTitle: dbJob.title,
        decision: input.decision,
        targetStatus,
        candidateIds: candidates.map((c) => c._id.toString()),
        reason: actionDescription,
        candidates: mappedCandidates,
      },
    },
  };
}
