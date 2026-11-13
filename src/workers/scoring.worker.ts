import { Worker, Job as BullJob } from 'bullmq';
import mongoose from 'mongoose';
import pLimit from 'p-limit';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateObject } from 'ai';
import { z } from 'zod';
import { env } from '../config/env';
import { redisConnection } from '../config/redis';
import { Job, Candidate, TokenUsage, Message } from '../models';
import { SCORING_QUEUE_NAME } from '../queues';
import { publishConversationEvent } from '../services/event-bus.service';

export interface ScoringJobPayload {
  jobId: string;
  candidateId: string;
  conversationId: string;
}

const scoringSchema = z.object({
  score: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe('Match score from 0 to 100 based on fit for job criteria'),
  reason: z
    .string()
    .describe('2-3 sentences explaining the score, citing concrete matches or gaps in skills/seniority'),
  missingInfo: z
    .array(z.string())
    .default([])
    .describe('Things the profile does not state, e.g. "years of Go", "salary expectations"'),
});

// Shared worker LLM concurrency limiter per ADR-0013 and Decision DEC-11
const llmLimiter = pLimit(env.WORKER_LLM_MAX_CONCURRENCY);

async function scoreCandidateWithLLM(
  jobData: {
    title: string;
    mustHaveSkills?: string[];
    niceToHaveSkills?: string[];
    seniority?: string;
    location?: string;
    remotePolicy?: string;
  },
  candidateData: {
    fullName: string;
    currentTitle?: string;
    currentCompany?: string;
    skills?: string[];
    summary?: string;
  },
  conversationId?: string
) {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured in environment.');
  }

  const google = createGoogleGenerativeAI({
    apiKey: env.GEMINI_API_KEY,
  });

  const prompt = `You are a strict, objective recruitment evaluation engine at Aironauts Technologies.
Compare the following candidate profile against the job criteria.

<job_criteria>
Title: ${jobData.title}
Must-Have Skills: ${(jobData.mustHaveSkills || []).join(', ') || 'None specified'}
Nice-To-Have Skills: ${(jobData.niceToHaveSkills || []).join(', ') || 'None specified'}
Seniority: ${jobData.seniority || 'Not specified'}
Location: ${jobData.location || 'Not specified'}
Work Policy: ${jobData.remotePolicy || 'Not specified'}
</job_criteria>

<candidate_profile>
Name: ${candidateData.fullName}
Current Title: ${candidateData.currentTitle || 'Not specified'}
Current Company: ${candidateData.currentCompany || 'Not specified'}
Skills: ${(candidateData.skills || []).join(', ') || 'None specified'}
Summary: ${candidateData.summary || 'None provided'}
</candidate_profile>

RULES:
1. Score from 0 to 100 based on genuine skill, domain, and seniority fit.
2. Zero Hallucination: Do NOT assume or invent skills, years of experience, or qualifications.
3. List any missing critical info in 'missingInfo'.
4. In 'reason', provide 2-3 concise sentences citing concrete matches or gaps.`;

  // Wrap in exponential retry on 429/503 (max 3 tries)
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await llmLimiter(async () => {
        const result = await generateObject({
          model: google(env.LLM_MODEL),
          schema: scoringSchema,
          prompt,
        });

        // Record token usage per B4 & ADR-0015
        if (result.usage) {
          const usageAny = result.usage as any;
          const promptTokens = usageAny.inputTokens ?? usageAny.promptTokens ?? 0;
          const completionTokens = usageAny.outputTokens ?? usageAny.completionTokens ?? 0;
          const totalTokens = usageAny.totalTokens ?? promptTokens + completionTokens;
          const cost = (promptTokens * 0.075 + completionTokens * 0.3) / 1000000;

          await TokenUsage.create({
            conversationId: conversationId ? new mongoose.Types.ObjectId(conversationId) : undefined,
            caller: 'worker:scoring',
            model: env.LLM_MODEL,
            promptTokens,
            completionTokens,
            totalTokens,
            estimatedCostUsd: Number(cost.toFixed(6)),
            timestamp: new Date(),
          });
        }

        return result.object;
      });
    } catch (err: any) {
      lastError = err;
      const isRetryable =
        err?.status === 429 ||
        err?.status === 503 ||
        err?.statusCode === 429 ||
        err?.statusCode === 503 ||
        (err?.message && (err.message.includes('429') || err.message.includes('503') || err.message.includes('quota')));

      if (attempt < 3 && isRetryable) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        console.warn(`[ScoringWorker] LLM rate-limit hit. Retrying in ${backoffMs}ms (attempt ${attempt}/3)...`);
        await new Promise((r) => setTimeout(r, backoffMs));
      } else {
        break;
      }
    }
  }

  throw lastError;
}

export type ScoringFn = (
  jobData: {
    title: string;
    mustHaveSkills?: string[];
    niceToHaveSkills?: string[];
    seniority?: string;
    location?: string;
    remotePolicy?: string;
  },
  candidateData: {
    fullName: string;
    currentTitle?: string;
    currentCompany?: string;
    skills?: string[];
    summary?: string;
  },
  conversationId?: string
) => Promise<{ score: number; reason: string; missingInfo: string[] }>;

export async function processScoringJob(
  payload: ScoringJobPayload,
  scorer: ScoringFn = scoreCandidateWithLLM
): Promise<void> {
  const { jobId, candidateId, conversationId } = payload;
  console.log(`[ScoringWorker] Scoring candidate ${candidateId} for job ${jobId}`);

  const [dbJob, candidate] = await Promise.all([
    Job.findById(jobId),
    Candidate.findById(candidateId),
  ]);

  if (!dbJob || !candidate) {
    console.warn(`[ScoringWorker] Missing job (${jobId}) or candidate (${candidateId}). Skipping.`);
    return;
  }

  try {
    const scoreResult = await scorer(
      {
        title: dbJob.title,
        mustHaveSkills: dbJob.mustHaveSkills,
        niceToHaveSkills: dbJob.niceToHaveSkills,
        seniority: dbJob.seniority,
        location: dbJob.location,
        remotePolicy: dbJob.remotePolicy,
      },
      {
        fullName: candidate.fullName,
        currentTitle: candidate.currentTitle,
        currentCompany: candidate.currentCompany,
        skills: candidate.skills,
        summary: candidate.scoreReason,
      },
      conversationId
    );

    candidate.score = scoreResult.score;
    candidate.scoreReason = scoreResult.reason;
    candidate.scoreMissingInfo = scoreResult.missingInfo;
    candidate.missingInfo = scoreResult.missingInfo;
    candidate.scoreStatus = 'scored';
    await candidate.save();

    console.log(`[ScoringWorker] Scored candidate '${candidate.fullName}': ${scoreResult.score}/100`);
  } catch (err: any) {
    console.error(`[ScoringWorker] Scoring failed for candidate '${candidate.fullName}':`, err?.message || err);
    // Resilient failure handling per B4
    candidate.scoreStatus = 'failed';
    candidate.score = null;
    candidate.scoreReason = `could not score: ${err instanceof Error ? err.message : String(err)}`;
    candidate.scoreMissingInfo = ['scoring failed due to external provider error'];
    candidate.missingInfo = ['scoring failed due to external provider error'];
    await candidate.save();
  }

  // Check batch progress
  const jobObjectId = new mongoose.Types.ObjectId(jobId);
  const allCandidates = await Candidate.find({ jobId: jobObjectId });

  const total = allCandidates.length;
  const scored = allCandidates.filter((c) => c.scoreStatus === 'scored').length;
  const failed = allCandidates.filter((c) => c.scoreStatus === 'failed').length;
  const found = total;

  // Emit SOURCING_PROGRESS event via Redis Pub/Sub to SSE
  if (conversationId) {
    await publishConversationEvent(conversationId, 'SOURCING_PROGRESS', {
      jobId,
      found,
      scored,
      failed,
      total,
    });
  }

  // If all candidates in batch are evaluated, post the final assistant summary message
  if (scored + failed >= total && total > 0 && conversationId) {
    const finalCandidates = await Candidate.find({ jobId: jobObjectId });
    const strongMatches = finalCandidates.filter((c) => (c.score ?? 0) >= 80).length;
    const moderateMatches = finalCandidates.filter((c) => (c.score ?? 0) >= 60 && (c.score ?? 0) < 80).length;
    const weakMatches = finalCandidates.filter((c) => c.scoreStatus === 'failed' || (c.score ?? 0) < 60).length;

    const strongLabel = strongMatches === 1 ? '1 strong match' : `${strongMatches} strong matches`;
    const moderateLabel = moderateMatches === 1 ? '1 moderate match' : `${moderateMatches} moderate matches`;
    const weakLabel = weakMatches === 1 ? '1 weak match' : `${weakMatches} weak matches`;

    const summaryText = `Found and scored ${total} candidates for ${dbJob.title}: ${strongLabel} (score >= 80), ${moderateLabel} (60-79), ${weakLabel} (< 60). You can review them in the Candidates tab or ask me to show them here.`;

    // Atomic lock in Redis to avoid concurrent workers posting duplicate summary
    const lockKey = `summary_posted:${jobId}:${total}`;
    const acquired = await redisConnection.set(lockKey, '1', 'EX', 300, 'NX');
    if (!acquired) {
      return;
    }

    // Double check DB to ensure idempotent posting
    const existingSummary = await Message.findOne({
      conversationId: new mongoose.Types.ObjectId(conversationId),
      role: 'assistant',
      'parts.text': { $regex: new RegExp(`Found and scored ${total} candidates for ${dbJob.title}`) },
    });

    if (!existingSummary) {
      const summaryMsg = await Message.create({
        conversationId: new mongoose.Types.ObjectId(conversationId),
        role: 'assistant',
        parts: [{ type: 'text', text: summaryText }],
      });

      await publishConversationEvent(conversationId, 'CHAT_PART', {
        messageId: summaryMsg._id.toString(),
        partIndex: 0,
        part: { type: 'text', text: summaryText },
      });

      console.log(`[ScoringWorker] Posted sourcing summary to conversation ${conversationId}`);
    }
  }
}

export function createScoringWorker(): Worker {
  const workerConnection = redisConnection.duplicate();

  const worker = new Worker(
    SCORING_QUEUE_NAME,
    async (job: BullJob<ScoringJobPayload>) => {
      await processScoringJob(job.data, scoreCandidateWithLLM);
    },
    {
      connection: workerConnection,
      concurrency: env.WORKER_LLM_MAX_CONCURRENCY,
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`[ScoringWorker] Job ${job?.id} failed:`, err);
  });

  return worker;
}
