import fs from 'fs';
import path from 'path';
import { Worker, Job as BullJob } from 'bullmq';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { redisConnection } from '../config/redis';
import { Job, Candidate } from '../models';
import { SOURCING_QUEUE_NAME, scoringQueue } from '../queues';
import { normalizeEmail, normalizeProfileUrl } from '../utils/normalizer';
import { publishConversationEvent } from '../services/event-bus.service';

export interface SourcingJobPayload {
  jobId: string;
  conversationId: string;
  targetCount: number;
  searchQueries: string[];
  actionId?: string;
}

interface RawCandidateProfile {
  fullName: string;
  email?: string | null;
  profileUrl?: string | null;
  currentTitle?: string;
  currentCompany?: string;
  skills?: string[];
  location?: string;
  summary?: string;
}

async function searchSerper(queries: string[], limit: number): Promise<RawCandidateProfile[]> {
  const results: RawCandidateProfile[] = [];
  const apiKey = env.SERPER_API_KEY;

  for (const q of queries) {
    if (results.length >= limit) break;
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q: `site:linkedin.com/in/ ${q}`, num: limit }),
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        for (const item of data.organic || []) {
          const titleParts = (item.title || '').split(' - ');
          const name = titleParts[0]?.trim() || 'Candidate';
          const role = titleParts[1]?.trim() || '';
          results.push({
            fullName: name,
            currentTitle: role,
            profileUrl: item.link,
            summary: item.snippet,
            skills: [],
          });
          if (results.length >= limit) break;
        }
      }
    } catch (e) {
      console.error('[SourcingWorker] Serper query failed:', e);
    }
  }

  return results;
}

function loadFixtures(job: any, targetCount: number): RawCandidateProfile[] {
  let fixturesPath = path.join(__dirname, '../data/candidate-fixtures.json');
  if (!fs.existsSync(fixturesPath)) {
    fixturesPath = path.join(__dirname, '../../src/data/candidate-fixtures.json');
  }
  if (!fs.existsSync(fixturesPath)) {
    fixturesPath = path.resolve(process.cwd(), 'src/data/candidate-fixtures.json');
  }
  if (!fs.existsSync(fixturesPath)) {
    return [];
  }

  const raw = fs.readFileSync(fixturesPath, 'utf-8');
  const fixtures: RawCandidateProfile[] = JSON.parse(raw);

  const jobTerms = [
    job.title,
    ...(job.mustHaveSkills || []),
    ...(job.niceToHaveSkills || []),
  ].map((t: string) => t.toLowerCase());

  // Rank fixtures by keyword overlap
  const scored = fixtures.map((c) => {
    let relevance = 0;
    const combined = `${c.fullName} ${c.currentTitle || ''} ${(c.skills || []).join(' ')} ${c.summary || ''}`.toLowerCase();
    for (const term of jobTerms) {
      if (combined.includes(term)) {
        relevance += 2;
      }
    }
    return { candidate: c, relevance };
  });

  scored.sort((a, b) => b.relevance - a.relevance);
  return scored.slice(0, targetCount).map((s) => s.candidate);
}

export async function processSourcingPayload(data: SourcingJobPayload): Promise<{ found: number; enqueued: number; sourceMode: string }> {
  const { jobId, conversationId, targetCount, searchQueries } = data;
  console.log(`[SourcingWorker] Processing sourcing request for job ${jobId} (target: ${targetCount})`);

  const dbJob = await Job.findById(jobId);
  if (!dbJob) {
    throw new Error(`Job not found: ${jobId}`);
  }

  let rawProfiles: RawCandidateProfile[] = [];
  let sourceMode: 'serper' | 'fixture' = 'fixture';

  if (env.SERPER_API_KEY && env.SERPER_API_KEY.trim()) {
    sourceMode = 'serper';
    rawProfiles = await searchSerper(searchQueries, targetCount);
  } else {
    sourceMode = 'fixture';
    rawProfiles = loadFixtures(dbJob, targetCount);
  }

  console.log(`[SourcingWorker] Discovered ${rawProfiles.length} candidate profiles in '${sourceMode}' mode.`);

  const candidateIdsToScore: string[] = [];
  const jobObjectId = new mongoose.Types.ObjectId(jobId);

  for (const profile of rawProfiles) {
    const normEmail = normalizeEmail(profile.email);
    const normUrl = normalizeProfileUrl(profile.profileUrl);

    // Deduplication check per ADR-0007 / Decision DEC-07
    const orConditions: any[] = [];
    if (normEmail) orConditions.push({ normalizedEmail: normEmail });
    if (normUrl) orConditions.push({ normalizedProfileUrl: normUrl });

    let existingCandidate = null;
    if (orConditions.length > 0) {
      existingCandidate = await Candidate.findOne({
        jobId: jobObjectId,
        $or: orConditions,
      });
    }

    if (existingCandidate) {
      console.log(`[SourcingWorker] Deduplicated: Candidate '${existingCandidate.fullName}' already exists for job.`);
      // Do not re-enqueue for scoring if already scored for this job
      if (existingCandidate.scoreStatus === 'pending') {
        candidateIdsToScore.push(existingCandidate._id.toString());
      }
      continue;
    }

    // Insert new candidate with explicit sourceMode & emailStatus
    const newCandidate = await Candidate.create({
      jobId: jobObjectId,
      fullName: profile.fullName,
      email: profile.email || undefined,
      normalizedEmail: normEmail,
      emailStatus: profile.email ? 'valid' : 'missing',
      profileUrl: profile.profileUrl || undefined,
      normalizedProfileUrl: normUrl,
      source: 'search',
      sourceMode,
      currentTitle: profile.currentTitle,
      currentCompany: profile.currentCompany,
      skills: profile.skills || [],
      score: null,
      scoreStatus: 'pending',
      scoreMissingInfo: [],
      missingInfo: [],
      status: 'Sourced',
      scoreReason: profile.summary,
    });

    candidateIdsToScore.push(newCandidate._id.toString());
  }

  // Enqueue candidates to scoring-queue
  for (const candidateId of candidateIdsToScore) {
    await scoringQueue.add('score_candidate', {
      jobId,
      candidateId,
      conversationId,
    });
  }

  const totalDiscovered = await Candidate.countDocuments({ jobId: jobObjectId });

  // Emit initial SOURCING_PROGRESS event
  await publishConversationEvent(conversationId, 'SOURCING_PROGRESS', {
    jobId,
    found: totalDiscovered,
    scored: 0,
    failed: 0,
    total: totalDiscovered,
  });

  console.log(`[SourcingWorker] Enqueued ${candidateIdsToScore.length} candidates for scoring.`);
  return { found: totalDiscovered, enqueued: candidateIdsToScore.length, sourceMode };
}

export function createSourcingWorker(): Worker {
  const workerConnection = redisConnection.duplicate();

  const worker = new Worker(
    SOURCING_QUEUE_NAME,
    async (job: BullJob<SourcingJobPayload>) => {
      return processSourcingPayload(job.data);
    },
    {
      connection: workerConnection,
      concurrency: 2,
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`[SourcingWorker] Job ${job?.id} failed:`, err);
  });

  return worker;
}

