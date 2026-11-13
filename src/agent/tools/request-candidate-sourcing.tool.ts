import mongoose from 'mongoose';
import { z } from 'zod';
import { Job } from '../../models';
import { PendingActionService } from '../../services/pending-action.service';

export const requestCandidateSourcingInputSchema = z.object({
  jobId: z
    .string()
    .describe('The MongoDB ObjectId of the job to source candidates for'),
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
  // 1. Validate jobId format
  if (!mongoose.Types.ObjectId.isValid(input.jobId)) {
    return {
      success: false,
      error: `Invalid jobId format: '${input.jobId}'. Must be a valid 24-character hexadecimal ObjectId.`,
    };
  }

  // 2. Validate job exists
  const job = await Job.findById(input.jobId);
  if (!job) {
    return {
      success: false,
      error: `Job with ID '${input.jobId}' was not found. Please verify the job exists.`,
    };
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

