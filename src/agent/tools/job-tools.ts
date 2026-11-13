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

