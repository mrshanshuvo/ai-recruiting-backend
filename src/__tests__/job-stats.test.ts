import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import { env } from '../config/env';
import { Job, Candidate, Reply, Campaign, OutreachMessage, ActivityLog, TokenUsage, Conversation } from '../models';
import { JobStatsService, ALL_PIPELINE_STATUSES } from '../services/job-stats.service';
import { jobRouter } from '../routes/job.route';
import { executeGetJobStats } from '../agent/tools/get-job-stats.tool';

const app = express();
app.use(express.json());
app.use('/api', jobRouter);

describe('Checkpoint 9: Recruiting Pipeline Metrics, Funnel Dashboard & Stats Tool', () => {
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(env.MONGO_URI);
    }
  });

  afterAll(async () => {
    await Job.deleteMany({ title: /TestStatsJob/i });
    await Candidate.deleteMany({ email: /@teststats\.com/i });
  });

  beforeEach(async () => {
    await Job.deleteMany({ title: /TestStatsJob/i });
    await Candidate.deleteMany({ email: /@teststats\.com/i });
  });

  // 1. Metric Math & Funnel Aggregation
  describe('1. Metric Math & Full 12-Stage Funnel', () => {
    it('calculates exact funnel counts for all 12 pipeline stages', async () => {
      const job = await Job.create({
        title: 'TestStatsJob Senior React',
        department: 'Engineering',
        status: 'OPEN',
      });

      // Insert 1 candidate in each of the 12 statuses
      for (let i = 0; i < ALL_PIPELINE_STATUSES.length; i++) {
        const status = ALL_PIPELINE_STATUSES[i];
        await Candidate.create({
          jobId: job._id,
          fullName: `Candidate ${status}`,
          email: `candidate.${i}@teststats.com`,
          emailStatus: 'valid',
          source: 'search',
          sourceMode: i % 2 === 0 ? 'fixture' : 'csv',
          score: 80,
          scoreStatus: 'scored',
          status,
          contactedAt: status !== 'Sourced' && status !== 'Accepted' ? new Date() : undefined,
          outreachStopped: false,
        });
      }

      const stats = await JobStatsService.getJobStats(job._id);

      expect(stats.totals.totalCandidates).toBe(12);
      for (const st of ALL_PIPELINE_STATUSES) {
        expect(stats.funnel[st]).toBe(1);
      }
    });

    it('calculates correct conversion rates when candidates are contacted', async () => {
      const job = await Job.create({
        title: 'TestStatsJob Rate Calculations',
        department: 'Engineering',
        status: 'OPEN',
      });

      // 4 contacted candidates
      const c1 = await Candidate.create({
        jobId: job._id,
        fullName: 'Contacted Only',
        email: 'c1@teststats.com',
        emailStatus: 'valid',
        source: 'search',
        sourceMode: 'fixture',
        status: 'Contacted',
        contactedAt: new Date(),
        outreachStopped: false,
      });

      const c2 = await Candidate.create({
        jobId: job._id,
        fullName: 'Replied Candidate',
        email: 'c2@teststats.com',
        emailStatus: 'valid',
        source: 'search',
        sourceMode: 'fixture',
        status: 'Replied',
        contactedAt: new Date(),
        outreachStopped: true,
      });

      const c3 = await Candidate.create({
        jobId: job._id,
        fullName: 'Interested Candidate',
        email: 'c3@teststats.com',
        emailStatus: 'valid',
        source: 'search',
        sourceMode: 'fixture',
        status: 'Interested',
        contactedAt: new Date(),
        outreachStopped: true,
      });

      const c4 = await Candidate.create({
        jobId: job._id,
        fullName: 'Meeting Booked Candidate',
        email: 'c4@teststats.com',
        emailStatus: 'valid',
        source: 'search',
        sourceMode: 'fixture',
        status: 'Meeting booked',
        contactedAt: new Date(),
        outreachStopped: true,
      });

      const stats = await JobStatsService.getJobStats(job._id);

      // Contacted = 4
      expect(stats.totals.contacted).toBe(4);
      // Replied = 3 (Replied, Interested, Meeting booked)
      expect(stats.totals.replied).toBe(3);
      // Interested = 2 (Interested, Meeting booked)
      expect(stats.totals.interested).toBe(2);
      // Meetings = 1
      expect(stats.totals.meetings).toBe(1);

      // Rates: replyRate = 3/4 = 0.75 (75.0%), interestedRate = 2/4 = 0.5 (50.0%)
      expect(stats.rates.replyRate).toBe(0.75);
      expect(stats.rates.replyRateFormatted).toBe('75.0%');
      expect(stats.rates.interestedRate).toBe(0.5);
      expect(stats.rates.interestedRateFormatted).toBe('50.0%');
    });
  });

  // 2. Edge Cases (0 Contacted, Progressed to Hired, Unsubscribed)
  describe('2. Edge Cases & Progression Resilience', () => {
    it('safely handles 0 contacted candidates without dividing by zero (returns "n/a")', async () => {
      const job = await Job.create({
        title: 'TestStatsJob Zero Contacted',
        department: 'Engineering',
        status: 'OPEN',
      });

      await Candidate.create({
        jobId: job._id,
        fullName: 'Sourced Only',
        email: 'sourced@teststats.com',
        emailStatus: 'valid',
        source: 'search',
        sourceMode: 'fixture',
        status: 'Sourced',
        outreachStopped: false,
      });

      const stats = await JobStatsService.getJobStats(job._id);

      expect(stats.totals.totalCandidates).toBe(1);
      expect(stats.totals.contacted).toBe(0);
      expect(stats.rates.replyRate).toBe('n/a');
      expect(stats.rates.replyRateFormatted).toBe('n/a');
      expect(stats.rates.interestedRate).toBe('n/a');
      expect(stats.rates.interestedRateFormatted).toBe('n/a');
    });

    it('candidate who progressed to Hired still counts in ever-replied and ever-interested', async () => {
      const job = await Job.create({
        title: 'TestStatsJob Hired Progression',
        department: 'Engineering',
        status: 'OPEN',
      });

      const c = await Candidate.create({
        jobId: job._id,
        fullName: 'Fast Track Candidate',
        email: 'fasttrack@teststats.com',
        emailStatus: 'valid',
        source: 'search',
        sourceMode: 'fixture',
        status: 'Hired',
        contactedAt: new Date(),
        outreachStopped: true,
      });

      // Log activity showing candidate went through Replied and Interested
      await ActivityLog.create({
        jobId: job._id,
        candidateId: c._id,
        actor: 'system',
        action: 'candidate_status_changed',
        previousStatus: 'Contacted',
        newStatus: 'Replied',
        timestamp: new Date(),
      });

      await ActivityLog.create({
        jobId: job._id,
        candidateId: c._id,
        actor: 'system',
        action: 'candidate_status_changed',
        previousStatus: 'Replied',
        newStatus: 'Interested',
        timestamp: new Date(),
      });

      await ActivityLog.create({
        jobId: job._id,
        candidateId: c._id,
        actor: 'recruiter',
        action: 'candidate_status_changed',
        previousStatus: 'Shortlisted',
        newStatus: 'Hired',
        timestamp: new Date(),
      });

      const stats = await JobStatsService.getJobStats(job._id);

      expect(stats.totals.contacted).toBe(1);
      expect(stats.totals.replied).toBe(1);
      expect(stats.totals.interested).toBe(1);
      expect(stats.totals.hires).toBe(1);
      expect(stats.rates.replyRateFormatted).toBe('100.0%');
      expect(stats.rates.interestedRateFormatted).toBe('100.0%');
    });

    it('candidate who unsubscribed after replying still counts in replied metrics', async () => {
      const job = await Job.create({
        title: 'TestStatsJob Unsubscribed After Reply',
        department: 'Engineering',
        status: 'OPEN',
      });

      const c = await Candidate.create({
        jobId: job._id,
        fullName: 'Unsubscribed Candidate',
        email: 'unsub@teststats.com',
        emailStatus: 'valid',
        source: 'search',
        sourceMode: 'fixture',
        status: 'Unsubscribed',
        statusBeforeUnsubscribe: 'Replied',
        contactedAt: new Date(),
        outreachStopped: true,
      });

      await Reply.create({
        jobId: job._id,
        candidateId: c._id,
        senderEmail: c.email!,
        body: 'Not interested at this time, please unsubscribe.',
        replyClass: 'Unsubscribe',
        receivedAt: new Date(),
      });

      const stats = await JobStatsService.getJobStats(job._id);

      expect(stats.totals.contacted).toBe(1);
      expect(stats.totals.replied).toBe(1);
      expect(stats.funnel['Unsubscribed']).toBe(1);
      expect(stats.rates.replyRateFormatted).toBe('100.0%');
    });
  });

  // 3. Source Mode Breakdown
  describe('3. Sourcing Channels Breakdown', () => {
    it('aggregates counts by sourceMode (fixture, csv, serper)', async () => {
      const job = await Job.create({
        title: 'TestStatsJob Sourcing Channels',
        department: 'Engineering',
        status: 'OPEN',
      });

      // 3 fixture, 2 csv, 1 serper
      for (let i = 0; i < 3; i++) {
        await Candidate.create({
          jobId: job._id,
          fullName: `Fixture ${i}`,
          email: `fix${i}@teststats.com`,
          emailStatus: 'valid',
          source: 'search',
          sourceMode: 'fixture',
          status: 'Sourced',
          outreachStopped: false,
        });
      }

      for (let i = 0; i < 2; i++) {
        await Candidate.create({
          jobId: job._id,
          fullName: `CSV ${i}`,
          email: `csv${i}@teststats.com`,
          emailStatus: 'valid',
          source: 'csv',
          sourceMode: 'csv',
          status: 'Sourced',
          outreachStopped: false,
        });
      }

      await Candidate.create({
        jobId: job._id,
        fullName: `Serper Candidate`,
        email: `serper@teststats.com`,
        emailStatus: 'valid',
        source: 'search',
        sourceMode: 'serper',
        status: 'Sourced',
        outreachStopped: false,
      });

      const stats = await JobStatsService.getJobStats(job._id);

      expect(stats.sourceBreakdown.fixture).toBe(3);
      expect(stats.sourceBreakdown.csv).toBe(2);
      expect(stats.sourceBreakdown.serper).toBe(1);
    });
  });

  // 4. Token Usage & AI Cost Aggregation
  describe('4. Token Usage & Estimated AI Cost Aggregation', () => {
    it('aggregates promptTokens, completionTokens, and estimated cost grouped by caller', async () => {
      const job = await Job.create({
        title: 'TestStatsJob Token Tracking',
        department: 'Engineering',
        status: 'OPEN',
      });

      await TokenUsage.create({
        jobId: job._id,
        caller: 'agent',
        model: 'gemini-3.1-flash-lite',
        promptTokens: 1000,
        completionTokens: 200,
        totalTokens: 1200,
        estimatedCostUsd: 0.000135,
        timestamp: new Date(),
      });

      await TokenUsage.create({
        jobId: job._id,
        caller: 'worker:scoring',
        model: 'gemini-3.1-flash-lite',
        promptTokens: 3000,
        completionTokens: 500,
        totalTokens: 3500,
        estimatedCostUsd: 0.000375,
        timestamp: new Date(),
      });

      const stats = await JobStatsService.getJobStats(job._id);

      expect(stats.tokenUsage.totalPromptTokens).toBe(4000);
      expect(stats.tokenUsage.totalCompletionTokens).toBe(700);
      expect(stats.tokenUsage.totalTokens).toBe(4700);
      expect(stats.tokenUsage.totalEstimatedCostUsd).toBe(0.00051);
      expect(stats.tokenUsage.byCaller['agent'].totalTokens).toBe(1200);
      expect(stats.tokenUsage.byCaller['worker:scoring'].totalTokens).toBe(3500);
    });
  });

  // 5. Job Resolution & Ambiguous Names (Item 4)
  describe('5. Ambiguous Job Resolution', () => {
    it('resolves job by exact full title case-insensitively', async () => {
      const job = await Job.create({
        title: 'TestStatsJob Unique Engineer',
        department: 'Engineering',
        status: 'OPEN',
      });

      const resolved = await JobStatsService.resolveJob('teststatsjob unique engineer');
      expect(resolved._id.toString()).toBe(job._id.toString());
    });

    it('rejects ambiguous job name and lists candidates when multiple match', async () => {
      await Job.create({
        title: 'TestStatsJob Ambiguous Alpha',
        department: 'Engineering',
        status: 'OPEN',
      });

      await Job.create({
        title: 'TestStatsJob Ambiguous Beta',
        department: 'Engineering',
        status: 'OPEN',
      });

      await expect(JobStatsService.resolveJob('TestStatsJob Ambiguous')).rejects.toThrow(
        /Ambiguous job name/
      );
    });
  });

  // 6. REST API Endpoint: GET /api/jobs/:id/stats
  describe('6. REST API Endpoint GET /api/jobs/:id/stats', () => {
    it('returns 200 OK with full stats payload', async () => {
      const job = await Job.create({
        title: 'TestStatsJob API Test',
        department: 'Engineering',
        status: 'OPEN',
      });

      const res = await request(app).get(`/api/jobs/${job._id}/stats`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.stats.jobId).toBe(job._id.toString());
      expect(res.body.stats.funnel.Sourced).toBe(0);
      expect(res.body.stats.rates.replyRateFormatted).toBe('n/a');
    });

    it('returns 400 for invalid ObjectId format', async () => {
      const res = await request(app).get('/api/jobs/invalid-id-123/stats');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 for non-existent job ID', async () => {
      const nonExistent = new mongoose.Types.ObjectId();
      const res = await request(app).get(`/api/jobs/${nonExistent}/stats`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ENTITY_NOT_FOUND');
    });
  });

  // 7. Chat Read Tool: get_job_stats
  describe('7. Chat Read Tool get_job_stats', () => {
    it('returns stats_summary card and factual numbers message', async () => {
      const job = await Job.create({
        title: 'TestStatsJob Tool Integration',
        department: 'Engineering',
        status: 'OPEN',
      });

      await Candidate.create({
        jobId: job._id,
        fullName: 'Tool Test Candidate',
        email: 'tooltest@teststats.com',
        emailStatus: 'valid',
        source: 'search',
        sourceMode: 'fixture',
        status: 'Contacted',
        contactedAt: new Date(),
        outreachStopped: false,
      });

      const result = await executeGetJobStats({ jobId: job._id.toString() });

      expect(result.success).toBe(true);
      expect(result.card?.cardType).toBe('stats_summary');
      expect(result.card?.payload.jobTitle).toBe('TestStatsJob Tool Integration');
      expect(result.card?.payload.totals.totalCandidates).toBe(1);
      expect(result.card?.payload.totals.contacted).toBe(1);
      expect(result.message).toContain('1 candidates sourced');
    });
  });
});
