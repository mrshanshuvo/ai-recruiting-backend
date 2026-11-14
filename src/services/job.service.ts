import mongoose from 'mongoose';
import { z } from 'zod';
import { Job, Conversation, ActivityLog, IJob } from '../models';

export const jobPayloadSchema = z.object({
  title: z.string().min(1, 'Job title is required'),
  rawDescription: z.string().optional(),
  mustHaveSkills: z.array(z.string()).default([]),
  niceToHaveSkills: z.array(z.string()).default([]),
  seniority: z.string().optional(),
  location: z.string().optional(),
  salaryRange: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      currency: z.string().default('USD'),
    })
    .optional(),
  remotePolicy: z.enum(['Remote', 'Hybrid', 'On-site']).optional(),
});

export type JobPayload = z.infer<typeof jobPayloadSchema>;

export class JobService {
  public static async createConfirmedJob(
    payload: Record<string, unknown>,
    conversationId?: mongoose.Types.ObjectId
  ): Promise<IJob> {
    const validated = jobPayloadSchema.parse(payload);

    const job = await Job.create({
      title: validated.title,
      rawDescription: validated.rawDescription,
      mustHaveSkills: validated.mustHaveSkills,
      niceToHaveSkills: validated.niceToHaveSkills,
      seniority: validated.seniority,
      location: validated.location,
      salaryRange: validated.salaryRange,
      remotePolicy: validated.remotePolicy,
      status: 'OPEN',
    });

    // Link job to conversation if conversationId is provided
    if (conversationId) {
      await Conversation.findByIdAndUpdate(conversationId, { jobId: job._id });
    }

    // Append to immutable ActivityLog
    await ActivityLog.create({
      jobId: job._id,
      actor: 'recruiter',
      action: 'job_created',
      details: {
        title: job.title,
        remotePolicy: job.remotePolicy,
      },
      timestamp: new Date(),
    });

    return job;
  }

  public static async listJobs(status?: string): Promise<IJob[]> {
    const query = status ? { status } : {};
    return Job.find(query).sort({ createdAt: -1 });
  }

  public static async getJobById(jobId: string): Promise<IJob | null> {
    if (!mongoose.Types.ObjectId.isValid(jobId)) return null;
    return Job.findById(jobId);
  }
}
