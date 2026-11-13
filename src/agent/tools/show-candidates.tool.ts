import { z } from 'zod';
import mongoose from 'mongoose';
import { Candidate, Job } from '../../models';

export const showCandidatesInputSchema = z.object({
  jobId: z
    .string()
    .optional()
    .describe('Job ID to show candidates for. If omitted, uses the most recent active job.'),
  status: z
    .string()
    .optional()
    .describe('Filter by candidate pipeline status (e.g., Sourced, Accepted, Rejected)'),
  minScore: z.number().optional().describe('Filter candidates with score >= minScore'),
  limit: z.number().optional().describe('Maximum number of candidates to display (default: 20)'),
});

export async function executeShowCandidates(input: z.infer<typeof showCandidatesInputSchema>) {
  let targetJob = null;

  if (input.jobId && mongoose.Types.ObjectId.isValid(input.jobId)) {
    targetJob = await Job.findById(input.jobId).lean();
  }

  if (!targetJob) {
    targetJob = await Job.findOne().sort({ createdAt: -1 }).lean();
  }

  if (!targetJob) {
    return {
      success: false,
      error: 'No active job found to display candidates for.',
    };
  }

  const query: Record<string, unknown> = {
    jobId: targetJob._id,
  };

  if (input.status) {
    query.status = input.status;
  }

  if (typeof input.minScore === 'number') {
    query.score = { $gte: input.minScore };
  }

  const limit = input.limit && input.limit > 0 ? input.limit : 20;

  // Retrieve candidates sorted by score descending
  const candidateDocs = await Candidate.find(query)
    .sort({ score: -1, createdAt: -1 })
    .limit(limit)
    .lean();

  const candidates = candidateDocs.map((c) => ({
    candidateId: c._id.toString(),
    fullName: c.fullName,
    currentTitle: c.currentTitle,
    currentCompany: c.currentCompany,
    score: c.score,
    scoreStatus: c.scoreStatus || 'scored',
    scoreReason: c.scoreReason,
    profileUrl: c.profileUrl,
    status: c.status,
    sourceMode: c.sourceMode,
    email: c.email || null,
    emailStatus: c.emailStatus,
  }));

  return {
    success: true,
    count: candidates.length,
    card: {
      cardType: 'candidate_table',
      status: 'confirmed',
      payload: {
        jobId: targetJob._id.toString(),
        jobTitle: targetJob.title,
        candidates,
      },
    },
    candidates,
  };
}

