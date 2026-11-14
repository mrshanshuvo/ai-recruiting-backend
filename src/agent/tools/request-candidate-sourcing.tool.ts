import mongoose from 'mongoose';
import { z } from 'zod';
import { Job, Conversation } from '../../models';
import { PendingActionService } from '../../services/pending-action.service';

export const requestCandidateSourcingInputSchema = z.object({
  jobId: z
    .string()
    .optional()
    .describe('The MongoDB ObjectId of the job to source candidates for. If omitted, resolved safely from the active conversation context.'),
  targetCount: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Number of candidate profiles to source (default 10, max 50)'),
  searchQueries: z
    .array(z.string())
    .optional()
    .describe('Optional search queries. If omitted, Boolean queries are automatically generated from job requirements.'),
});

export function generateBooleanSearchQueries(job: {
  title: string;
  mustHaveSkills?: string[];
  location?: string;
  remotePolicy?: string;
}): string[] {
  const title = job.title.trim();
  const skills = job.mustHaveSkills || [];
  const loc = job.location || (job.remotePolicy === 'Remote' ? 'Remote' : '');

  const queries: string[] = [];

  // Query 1: Exact title + must-have skills OR combination
  if (skills.length > 0) {
    const skillsOr = skills.slice(0, 3).map((s) => `"${s}"`).join(' OR ');
    let q1 = `"${title}" AND (${skillsOr})`;
    if (loc) q1 += ` AND "${loc}"`;
    queries.push(q1);
  } else {
    queries.push(loc ? `"${title}" AND "${loc}"` : `"${title}"`);
  }

  // Query 2: Title + top skills AND combination
  if (skills.length >= 2) {
    const skillsAnd = skills.slice(0, 2).map((s) => `"${s}"`).join(' AND ');
    queries.push(`"${title}" AND ${skillsAnd}`);
  } else if (skills.length === 1) {
    queries.push(`"${title}" AND "${skills[0]}"`);
  } else {
    queries.push(`"${title}" AND "experience"`);
  }

  // Query 3: Broader role search with seniority and key skill
  if (skills.length > 0) {
    queries.push(`"${title}" AND ("${skills[0]}" OR "tech lead" OR "engineer")`);
  } else {
    queries.push(`"${title}" AND ("lead" OR "senior" OR "staff")`);
  }

  return queries.slice(0, 3);
}

export async function executeRequestCandidateSourcing(
  input: z.infer<typeof requestCandidateSourcingInputSchema>,
  conversationId: string
) {
  let job: any = null;

  // 1. Explicit jobId if provided
  if (input.jobId && mongoose.Types.ObjectId.isValid(input.jobId)) {
    job = await Job.findById(input.jobId);
  }

  // 2. Safe resolution from conversation context
  if (!job && conversationId) {
    if (mongoose.Types.ObjectId.isValid(conversationId)) {
      const conv = await Conversation.findById(conversationId).lean();
      if (conv?.jobId) {
        job = await Job.findById(conv.jobId);
      }
    }
    if (!job) {
      job = await Job.findOne({ conversationId });
    }
  }

  // 3. Fallback: only pick if unambiguous (exactly 1 job exists)
  if (!job) {
    const openJobs = await Job.find({ status: 'OPEN' }).lean();
    if (openJobs.length === 1) {
      job = openJobs[0];
    } else if (openJobs.length > 1) {
      const titles = openJobs.map((j) => `"${j.title}" (ID: ${j._id})`).join(', ');
      return {
        success: false,
        error: `There are multiple active jobs (${titles}). Which job would you like to source candidates for? Please specify the job title or ID.`,
      };
    } else {
      const allJobs = await Job.find().lean();
      if (allJobs.length === 1) {
        job = allJobs[0];
      } else if (allJobs.length > 1) {
        const titles = allJobs.map((j) => `"${j.title}" (ID: ${j._id})`).join(', ');
        return {
          success: false,
          error: `There are multiple jobs (${titles}). Which job would you like to source candidates for? Please specify the job title or ID.`,
        };
      }
    }
  }

  if (!job) {
    return {
      success: false,
      error: `No job found. Please create or specify a job before sourcing candidates.`,
    };
  }

  // Associate conversation with this job if not already set
  if (conversationId && mongoose.Types.ObjectId.isValid(conversationId)) {
    await Conversation.findByIdAndUpdate(conversationId, { jobId: job._id });
  }

  const targetCount = input.targetCount || 10;

  // 3. Generate or use provided search queries
  let searchQueries = input.searchQueries;
  if (!searchQueries || searchQueries.length === 0) {
    searchQueries = generateBooleanSearchQueries({
      title: job.title,
      mustHaveSkills: job.mustHaveSkills,
      location: job.location,
      remotePolicy: job.remotePolicy,
    });
  }

  const payload = {
    jobId: job._id.toString(),
    jobTitle: job.title,
    targetCount,
    searchQueries,
  };

  // 4. Create PendingAction for Confirmation Gate per ADR-0004
  const pendingAction = await PendingActionService.createAction({
    conversationId,
    actionType: 'START_SOURCING',
    payload,
    description: `Start Sourcing: ${job.title} (${targetCount} candidates)`,
  });

  return {
    success: true,
    message: `I prepared candidate sourcing for '${job.title}'. Please review the search queries and confirm.`,
    card: {
      cardType: 'sourcing_confirmation',
      actionId: pendingAction._id.toString(),
      status: 'pending',
      payload,
    },
  };
}

