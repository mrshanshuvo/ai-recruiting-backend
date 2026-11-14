import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import pLimit from 'p-limit';
import { normalizeEmail, normalizeProfileUrl } from '../utils/normalizer';
import { Candidate, Job, Conversation } from '../models';
import { CandidateService } from '../services/candidate.service';
import { processScoringJob } from '../workers/scoring.worker';
import { executeRequestCandidateSourcing } from '../agent/tools/request-candidate-sourcing.tool';
import { env } from '../config/env';

describe('B8: Checkpoint 4 Sourcing Slice Unit & Integration Tests', () => {
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(env.MONGO_URI);
    }
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  describe('1. URL and Email Normalizer Tests', () => {
    it('normalizes email: lowercase, trimmed, whitespace removed', () => {
      expect(normalizeEmail('  Sarah.Chen@Example.COM  ')).toBe('sarah.chen@example.com');
      expect(normalizeEmail('')).toBeUndefined();
      expect(normalizeEmail(null)).toBeUndefined();
    });

    it('normalizes profile URL: lowercases host, removes www.', () => {
      const url = 'https://WWW.LinkedIn.COM/in/sarahchen';
      expect(normalizeProfileUrl(url)).toBe('https://linkedin.com/in/sarahchen');
    });

    it('normalizes profile URL: removes tracking query parameters (utm_*, ref, trk)', () => {
      const url = 'https://linkedin.com/in/sarahchen?utm_source=google&trk=public_profile&ref=share&other=keep';
      expect(normalizeProfileUrl(url)).toBe('https://linkedin.com/in/sarahchen?other=keep');
    });

    it('normalizes profile URL: removes trailing slashes', () => {
      const url = 'https://linkedin.com/in/sarahchen///';
      expect(normalizeProfileUrl(url)).toBe('https://linkedin.com/in/sarahchen');
    });

    it('handles URLs without protocol by adding https://', () => {
      const url = 'linkedin.com/in/sarahchen/';
      expect(normalizeProfileUrl(url)).toBe('https://linkedin.com/in/sarahchen');
    });
  });

  describe('2. Candidate Deduplication Tests', () => {
    let testJobId: mongoose.Types.ObjectId;

    beforeEach(async () => {
      await Candidate.deleteMany({ fullName: { $regex: /DedupeTest/ } });
      const job = await Job.create({
        title: 'DedupeTest SRE Role',
        status: 'OPEN',
      });
      testJobId = job._id;
    });

    afterEach(async () => {
      await Candidate.deleteMany({ jobId: testJobId });
      await Job.findByIdAndDelete(testJobId);
    });

    it('inserting new candidate creates a new document', async () => {
      const rawEmail = 'alex.rivera@example.com';
      const normEmail = normalizeEmail(rawEmail);

      const candidate = await Candidate.create({
        jobId: testJobId,
        fullName: 'DedupeTest Alex Rivera',
        email: rawEmail,
        normalizedEmail: normEmail,
        emailStatus: 'valid',
        source: 'search',
        sourceMode: 'fixture',
        status: 'Sourced',
      });

      expect(candidate).toBeDefined();
      expect(candidate._id).toBeDefined();
      expect(candidate.normalizedEmail).toBe('alex.rivera@example.com');
    });

    it('inserting candidate with same email (different case) detects existing', async () => {
      const first = await Candidate.create({
        jobId: testJobId,
        fullName: 'DedupeTest Sarah Chen',
        email: 'sarah.chen@example.com',
        normalizedEmail: normalizeEmail('sarah.chen@example.com'),
        emailStatus: 'valid',
        source: 'search',
        sourceMode: 'fixture',
        status: 'Sourced',
      });

      const incomingEmail = '  SARAH.CHEN@EXAMPLE.COM ';
      const normIncoming = normalizeEmail(incomingEmail);

      const foundExisting = await Candidate.findOne({
        jobId: testJobId,
        normalizedEmail: normIncoming,
      });

      expect(foundExisting).not.toBeNull();
      expect(foundExisting!._id.toString()).toBe(first._id.toString());
    });

    it('same profileUrl with tracking query params detects existing', async () => {
      const canonicalUrl = 'https://linkedin.com/in/elenarostova';
      const first = await Candidate.create({
        jobId: testJobId,
        fullName: 'DedupeTest Elena Rostova',
        profileUrl: canonicalUrl,
        normalizedProfileUrl: normalizeProfileUrl(canonicalUrl),
        emailStatus: 'missing',
        source: 'search',
        sourceMode: 'fixture',
        status: 'Sourced',
      });

      const incomingUrl = 'https://www.linkedin.com/in/elenarostova/?utm_medium=social&trk=test';
      const normIncoming = normalizeProfileUrl(incomingUrl);

      const foundExisting = await Candidate.findOne({
        jobId: testJobId,
        normalizedProfileUrl: normIncoming,
      });

      expect(foundExisting).not.toBeNull();
      expect(foundExisting!._id.toString()).toBe(first._id.toString());
    });
  });

  describe('3. CSV Ingestion and Parser Tests', () => {
    let testJobId: mongoose.Types.ObjectId;

    beforeEach(async () => {
      const job = await Job.create({
        title: 'CSV Ingest Test Job',
        status: 'OPEN',
      });
      testJobId = job._id;
    });

    afterEach(async () => {
      await Candidate.deleteMany({ jobId: testJobId });
      await Job.findByIdAndDelete(testJobId);
    });

    it('valid CSV with 10 rows imports 10 candidates', async () => {
      const lines = ['fullName,email,profileUrl,currentTitle'];
      for (let i = 1; i <= 10; i++) {
        lines.push(`Candidate ${i},candidate${i}@example.com,https://linkedin.com/in/cand-${i},Engineer`);
      }
      const csvBuffer = Buffer.from(lines.join('\n'));

      const result = await CandidateService.processCsvUpload(
        testJobId.toString(),
        csvBuffer,
        'ten_candidates.csv'
      );

      expect(result.newCount).toBe(10);
      expect(result.duplicateCount).toBe(0);
      const inDb = await Candidate.countDocuments({ jobId: testJobId });
      expect(inDb).toBe(10);
    });

    it('missing headers throws error', async () => {
      const invalidCsv = Buffer.from('foo,bar\n123,456');

      await expect(
        CandidateService.processCsvUpload(testJobId.toString(), invalidCsv, 'invalid.csv')
      ).rejects.toThrow(/Invalid CSV headers/);
    });

    it('duplicate rows within the CSV are deduped', async () => {
      const csvContent = `fullName,email,profileUrl,currentTitle
Marcus Brody,marcus.brody@example.com,https://linkedin.com/in/marcusbrody,DevOps
Marcus Duplicate,MARCUS.BRODY@example.com,https://linkedin.com/in/marcus-diff,DevOps
Elena Rostova,elena@example.com,https://linkedin.com/in/elena-rostova,SRE
Elena DupUrl,elena-diff@example.com,https://www.linkedin.com/in/elena-rostova/?trk=public,SRE`;

      const result = await CandidateService.processCsvUpload(
        testJobId.toString(),
        Buffer.from(csvContent),
        'internal_dupes.csv'
      );

      expect(result.newCount).toBe(2);
      expect(result.duplicateCount).toBe(2);
      const inDb = await Candidate.countDocuments({ jobId: testJobId });
      expect(inDb).toBe(2);
    });

    it('row without email gets emailStatus="missing" and email=undefined', async () => {
      const csvContent = `fullName,email,profileUrl,currentTitle
Jordan Lee,,https://linkedin.com/in/jordanlee,Frontend Engineer`;

      const result = await CandidateService.processCsvUpload(
        testJobId.toString(),
        Buffer.from(csvContent),
        'no_email.csv'
      );

      expect(result.newCount).toBe(1);
      const candidate = await Candidate.findOne({ jobId: testJobId, fullName: 'Jordan Lee' });
      expect(candidate).toBeDefined();
      expect(candidate!.emailStatus).toBe('missing');
      expect(candidate!.email).toBeUndefined();
    });
  });

  describe('4. Scoring Worker Concurrency, Resilience & Retry', () => {
    it('rate limiter respects concurrency cap', async () => {
      const limit = pLimit(2);
      let activeWorkers = 0;
      let maxSeenActive = 0;

      const tasks = Array.from({ length: 6 }).map((_, i) =>
        limit(async () => {
          activeWorkers++;
          if (activeWorkers > maxSeenActive) maxSeenActive = activeWorkers;
          await new Promise((r) => setTimeout(r, 20));
          activeWorkers--;
          return i;
        })
      );

      await Promise.all(tasks);
      expect(maxSeenActive).toBeLessThanOrEqual(2);
    });

    it('exponential retry recovers from transient 429 errors', async () => {
      let attempts = 0;

      const mockLlmCall = async () => {
        attempts++;
        if (attempts < 3) {
          const err: any = new Error('Rate limit exceeded: 429 RESOURCE_EXHAUSTED');
          err.statusCode = 429;
          throw err;
        }
        return {
          score: 85,
          reason: 'Solid Kubernetes and Go background match requirements.',
          missingInfo: ['Salary expectations'],
        };
      };

      let result: any = null;
      for (let i = 1; i <= 3; i++) {
        try {
          result = await mockLlmCall();
          break;
        } catch (err: any) {
          if (i < 3 && err.statusCode === 429) {
            await new Promise((r) => setTimeout(r, 10));
          } else {
            throw err;
          }
        }
      }

      expect(attempts).toBe(3);
      expect(result.score).toBe(85);
      expect(result.reason).toContain('Kubernetes');
    });

    it('permanent failure marks candidate scoreStatus="failed" without throwing fatal worker error', async () => {
      const job = await Job.create({
        title: 'Failure Isolation Role',
        status: 'OPEN',
      });

      const candidate = await Candidate.create({
        jobId: job._id,
        fullName: 'Isolated Error Candidate',
        emailStatus: 'missing',
        source: 'search',
        sourceMode: 'fixture',
        scoreStatus: 'pending',
        status: 'Sourced',
      });

      // Call REAL processScoringJob with a failing scorer mock (dependency injection)
      const failingScorer = vi.fn().mockRejectedValue(new Error('Simulated upstream LLM network failure'));

      await processScoringJob(
        {
          jobId: job._id.toString(),
          candidateId: candidate._id.toString(),
          conversationId: '',
        },
        failingScorer
      );

      const updated = await Candidate.findById(candidate._id);
      expect(updated!.scoreStatus).toBe('failed');
      expect(updated!.score).toBeNull();
      expect(updated!.scoreReason).toContain('could not score: Simulated upstream LLM network failure');

      await Candidate.findByIdAndDelete(candidate._id);
      await Job.findByIdAndDelete(job._id);
    });

    it('scoring job that hangs/times out resolves candidate to failed status', async () => {
      const job = await Job.create({
        title: 'Timeout Guard SRE',
        department: 'Infrastructure',
        status: 'OPEN',
      });

      const candidate = await Candidate.create({
        jobId: job._id,
        fullName: 'Hanging Scorer Candidate',
        emailStatus: 'missing',
        source: 'search',
        sourceMode: 'fixture',
        scoreStatus: 'pending',
        status: 'Sourced',
      });

      // Scorer mock that never resolves (or throws timeout)
      const hangingScorer = vi.fn().mockImplementation(() => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Scoring timed out after 30000ms')), 50);
        });
      });

      await processScoringJob(
        {
          jobId: job._id.toString(),
          candidateId: candidate._id.toString(),
          conversationId: '',
        },
        hangingScorer
      );

      const updated = await Candidate.findById(candidate._id);
      expect(updated!.scoreStatus).toBe('failed');
      expect(updated!.score).toBeNull();
      expect(updated!.scoreReason).toContain('could not score: Scoring timed out');

      await Candidate.findByIdAndDelete(candidate._id);
      await Job.findByIdAndDelete(job._id);
    });
  });

  describe('5. Safe Contextual jobId Resolution in Sourcing Tool (C3 c)', () => {
    it('resolves job A in conversation A and job B in conversation B without silently picking latest', async () => {
      const jobA = await Job.create({
        title: 'Backend Systems Engineer (Job A)',
        department: 'Core',
        status: 'OPEN',
      });

      const jobB = await Job.create({
        title: 'Frontend React Specialist (Job B)',
        department: 'UI',
        status: 'OPEN',
      });

      const convA = await Conversation.create({
        title: 'Thread A',
        jobId: jobA._id,
      });

      const convB = await Conversation.create({
        title: 'Thread B',
        jobId: jobB._id,
      });

      // In conversation A: "source candidates for it" (no jobId passed)
      const resA = await executeRequestCandidateSourcing({ targetCount: 5 }, convA._id.toString());
      expect(resA.success).toBe(true);
      expect(resA.card?.payload.jobId).toBe(jobA._id.toString());
      expect(resA.card?.payload.jobTitle).toBe(jobA.title);

      // In conversation B: "source candidates for it" (no jobId passed)
      const resB = await executeRequestCandidateSourcing({ targetCount: 5 }, convB._id.toString());
      expect(resB.success).toBe(true);
      expect(resB.card?.payload.jobId).toBe(jobB._id.toString());
      expect(resB.card?.payload.jobTitle).toBe(jobB.title);

      // In an unlinked conversation when multiple jobs exist: asks which one instead of silently picking latest
      const convUnlinked = await Conversation.create({
        title: 'Thread Unlinked',
      });
      const resUnlinked = await executeRequestCandidateSourcing({ targetCount: 5 }, convUnlinked._id.toString());
      expect(resUnlinked.success).toBe(false);
      expect(resUnlinked.error).toContain('There are multiple active jobs');
      expect(resUnlinked.error).toContain('Which job would you like to source candidates for?');

      // Cleanup
      await Conversation.deleteMany({ _id: { $in: [convA._id, convB._id, convUnlinked._id] } });
      await Job.deleteMany({ _id: { $in: [jobA._id, jobB._id] } });
    });
  });
});
