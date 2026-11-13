import { z } from 'zod';
import { JobService } from '../../services/job.service';

export const listJobsInputSchema = z.object({
  status: z.enum(['OPEN', 'SOURCING', 'PAUSED', 'CLOSED']).optional().describe('Filter by job status'),
});

export async function executeListJobs(input: z.infer<typeof listJobsInputSchema>) {
  const jobs = await JobService.listJobs(input.status);
  return {
    success: true,
    count: jobs.length,
    jobs: jobs.map((j) => ({
      id: j._id.toString(),
      title: j.title,
      seniority: j.seniority,
      location: j.location,
      status: j.status,
      candidateCounts: j.candidateCounts,
    })),
  };
}

export const getJobInputSchema = z.object({
  jobId: z.string().describe('The ID of the job to retrieve'),
});

export async function executeGetJob(input: z.infer<typeof getJobInputSchema>) {
  const job = await JobService.getJobById(input.jobId);
  if (!job) {
    return {
      success: false,
      error: 'Job not found',
    };
  }
  return {
    success: true,
    job,
  };
}

export const getJobStatsInputSchema = z.object({
  jobId: z.string().describe('The ID of the job to get pipeline statistics for'),
});

export async function executeGetJobStats(input: z.infer<typeof getJobStatsInputSchema>) {
  const job = await JobService.getJobById(input.jobId);
  if (!job) {
    return {
      success: false,
      error: 'Job not found',
    };
  }
  return {
    success: true,
    jobId: job._id.toString(),
    title: job.title,
    candidateCounts: job.candidateCounts,
  };
}

export const findCandidatesInputSchema = z.object({
  jobId: z.string().optional().describe('Filter by job ID'),
  status: z.string().optional().describe('Filter by candidate status (e.g. Sourced, Accepted, Rejected)'),
  name: z.string().optional().describe('Filter by candidate name substring'),
  minScore: z.number().optional().describe('Filter candidates with score >= minScore'),
  limit: z.number().optional().describe('Maximum candidates to return (default: 20)'),
});

export async function executeFindCandidates(input: z.infer<typeof findCandidatesInputSchema>) {
  const { Candidate } = await import('../../models');
  const query: Record<string, unknown> = {};
  if (input.jobId) query.jobId = input.jobId;
  if (input.status) query.status = input.status;
  if (input.name) query.fullName = { $regex: input.name, $options: 'i' };
  if (typeof input.minScore === 'number') {
    query.score = { $gte: input.minScore };
  }

  const limit = input.limit || 20;
  const candidates = await Candidate.find(query).sort({ score: -1 }).limit(limit).lean();
  return {
    success: true,
    count: candidates.length,
    candidates: candidates.map((c) => ({
      id: c._id.toString(),
      candidateId: c._id.toString(),
      fullName: c.fullName,
      email: c.email || null,
      emailStatus: c.emailStatus,
      status: c.status,
      score: c.score,
      scoreReason: c.scoreReason,
      sourceMode: c.sourceMode,
      profileUrl: c.profileUrl,
      currentTitle: c.currentTitle,
      currentCompany: c.currentCompany,
      skills: c.skills,
    })),
  };
}

export const getCampaignInputSchema = z.object({
  jobId: z.string().optional().describe('The job ID of the campaign'),
  campaignId: z.string().optional().describe('The campaign ID'),
});

export async function executeGetCampaign(input: z.infer<typeof getCampaignInputSchema>) {
  const { Campaign } = await import('../../models');
  const query: Record<string, unknown> = {};
  if (input.campaignId) query._id = input.campaignId;
  if (input.jobId) query.jobId = input.jobId;

  const campaign = await Campaign.findOne(query).lean();
  if (!campaign) {
    return {
      success: false,
      error: 'Campaign not found',
    };
  }
  return {
    success: true,
    campaign: {
      id: campaign._id.toString(),
      jobId: campaign.jobId.toString(),
      name: campaign.name,
      status: campaign.status,
      dailySendLimit: campaign.dailySendLimit,
    },
  };
}

