import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { app } from '../index.api';
import { Job, Candidate, ActivityLog, PendingAction } from '../models';
import {
  CandidateStatusService,
  InvalidStateTransitionError,
  ALLOWED_TRANSITIONS,
} from '../services/candidate-status.service';
import { PendingActionService } from '../services/pending-action.service';
import { executeFindCandidates } from '../agent/tools/job-tools';
import { executeProposeCandidateReview } from '../agent/tools/propose-candidate-review.tool';
import { resolveCandidateByName } from '../utils/candidate-resolver';

describe('Checkpoint 5: Candidate Status Machine, Review, and Confirmation Gate', () => {
  let testJobId: mongoose.Types.ObjectId;
  let testJobIdStr: string;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/ai-recruiting-co-worker');
    }
  });

  afterAll(async () => {
    await Job.deleteMany({ title: /Checkpoint 5 Test/ });
    await Candidate.deleteMany({ fullName: /TestCand/ });
    await ActivityLog.deleteMany({ action: /candidate_/ });
    await PendingAction.deleteMany({ description: /Bulk/ });
  });

  beforeEach(async () => {
    const job = await Job.create({
      title: 'Checkpoint 5 Test Job - Senior React Engineer',
      mustHaveSkills: ['React', 'TypeScript'],
      niceToHaveSkills: ['Tailwind CSS'],
      status: 'OPEN',
    });
    testJobId = job._id;
    testJobIdStr = job._id.toString();
  });

  // Helper to create a candidate
  async function createCandidate(overrides: Record<string, any> = {}) {
    return Candidate.create({
      jobId: testJobId,
      fullName: 'TestCand ' + Math.random().toString(36).substring(7),
      email: 'cand.' + Math.random().toString(36).substring(7) + '@example.com',
      emailStatus: 'valid',
      profileUrl: 'https://linkedin.com/in/testcand-' + Math.random().toString(36).substring(7),
      source: 'search',
      sourceMode: 'fixture',
      currentTitle: 'Frontend Engineer',
      currentCompany: 'Tech Corp',
      skills: ['React', 'TypeScript'],
      score: 85,
      scoreStatus: 'scored',
      scoreReason: 'Strong React and TypeScript skills',
      status: 'Sourced',
      ...overrides,
    });
  }

  describe('1. Allowed State Transitions & Audit Trail', () => {
    it('allows valid single transitions according to transition matrix', async () => {
      // Sourced -> Accepted
      const cand = await createCandidate({ status: 'Sourced' });
      const res1 = await CandidateStatusService.transition(cand._id, 'Accepted', 'recruiter', 'Good fit');
      expect(res1.previousStatus).toBe('Sourced');
      expect(res1.newStatus).toBe('Accepted');

      const updated1 = await Candidate.findById(cand._id);
      expect(updated1?.status).toBe('Accepted');

      // Check ActivityLog
      const log1 = await ActivityLog.findOne({ candidateId: cand._id, newStatus: 'Accepted' });
      expect(log1).toBeDefined();
      expect(log1?.actor).toBe('recruiter');
      expect(log1?.previousStatus).toBe('Sourced');
      expect(log1?.details?.reason).toBe('Good fit');

      // Accepted -> Contacted (sets contactedAt)
      const res2 = await CandidateStatusService.transition(cand._id, 'Contacted', 'system');
      expect(res2.newStatus).toBe('Contacted');
      const updated2 = await Candidate.findById(cand._id);
      expect(updated2?.contactedAt).toBeDefined();

      // Contacted -> Replied
      const res3 = await CandidateStatusService.transition(cand._id, 'Replied', 'system');
      expect(res3.newStatus).toBe('Replied');

      // Replied -> Interested
      const res4 = await CandidateStatusService.transition(cand._id, 'Interested', 'system');
      expect(res4.newStatus).toBe('Interested');

      // Interested -> Meeting booked
      const res5 = await CandidateStatusService.transition(cand._id, 'Meeting booked', 'agent');
      expect(res5.newStatus).toBe('Meeting booked');

      // Meeting booked -> Interviewed
      const res6 = await CandidateStatusService.transition(cand._id, 'Interviewed', 'recruiter');
      expect(res6.newStatus).toBe('Interviewed');

      // Interviewed -> Shortlisted
      const res7 = await CandidateStatusService.transition(cand._id, 'Shortlisted', 'recruiter');
      expect(res7.newStatus).toBe('Shortlisted');

      // Shortlisted -> Hired
      const res8 = await CandidateStatusService.transition(cand._id, 'Hired', 'recruiter');
      expect(res8.newStatus).toBe('Hired');
    });

    it('allows rejection from intermediate states (Sourced, Accepted, Interested, Interviewed, Shortlisted)', async () => {
      // Sourced -> Rejected
      const cand1 = await createCandidate({ status: 'Sourced' });
      const r1 = await CandidateStatusService.transition(cand1._id, 'Rejected', 'recruiter');
      expect(r1.newStatus).toBe('Rejected');

      // Accepted -> Rejected
      const cand2 = await createCandidate({ status: 'Accepted' });
      const r2 = await CandidateStatusService.transition(cand2._id, 'Rejected', 'recruiter');
      expect(r2.newStatus).toBe('Rejected');

      // Interested -> Rejected
      const cand3 = await createCandidate({ status: 'Interested' });
      const r3 = await CandidateStatusService.transition(cand3._id, 'Rejected', 'recruiter');
      expect(r3.newStatus).toBe('Rejected');

      // Interviewed -> Rejected
      const cand4 = await createCandidate({ status: 'Interviewed' });
      const r4 = await CandidateStatusService.transition(cand4._id, 'Rejected', 'recruiter');
      expect(r4.newStatus).toBe('Rejected');

      // Shortlisted -> Rejected
      const cand5 = await createCandidate({ status: 'Shortlisted' });
      const r5 = await CandidateStatusService.transition(cand5._id, 'Rejected', 'recruiter');
      expect(r5.newStatus).toBe('Rejected');
    });

    it('allows Replied -> Replied for Question reply class (DEC-01)', async () => {
      const cand = await createCandidate({ status: 'Replied' });
      const res = await CandidateStatusService.transition(cand._id, 'Replied', 'system', 'Question asked');
      expect(res.newStatus).toBe('Replied');
    });
  });

  describe('2. Unsubscribe Protocol (DEC-03 & DEC-13)', () => {
    it('allows Unsubscribed from contacted states, preserves statusBeforeUnsubscribe, and sets outreachStopped', async () => {
      const cand = await createCandidate({
        status: 'Contacted',
        contactedAt: new Date(),
      });

      const res = await CandidateStatusService.transition(cand._id, 'Unsubscribed', 'system', 'Candidate replied STOP');
      expect(res.newStatus).toBe('Unsubscribed');

      const updated = await Candidate.findById(cand._id);
      expect(updated?.status).toBe('Unsubscribed');
      expect(updated?.statusBeforeUnsubscribe).toBe('Contacted');
      expect(updated?.outreachStopped).toBe(true);

      const log = await ActivityLog.findOne({ candidateId: cand._id, action: 'candidate_unsubscribed' });
      expect(log).toBeDefined();
      expect(log?.previousStatus).toBe('Contacted');
    });

    it('allows Unsubscribed from Rejected if contactedAt is set (DEC-13)', async () => {
      const cand = await createCandidate({
        status: 'Rejected',
        contactedAt: new Date(Date.now() - 3600000),
      });

      const res = await CandidateStatusService.transition(cand._id, 'Unsubscribed', 'system');
      expect(res.newStatus).toBe('Unsubscribed');
      const updated = await Candidate.findById(cand._id);
      expect(updated?.statusBeforeUnsubscribe).toBe('Rejected');
    });

    it('rejects Unsubscribed from Rejected if candidate was never contacted', async () => {
      const cand = await createCandidate({
        status: 'Rejected',
        contactedAt: undefined,
      });

      await expect(
        CandidateStatusService.transition(cand._id, 'Unsubscribed', 'recruiter')
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('rejects Unsubscribed from Sourced if candidate was never contacted', async () => {
      const cand = await createCandidate({ status: 'Sourced' });

      await expect(
        CandidateStatusService.transition(cand._id, 'Unsubscribed', 'recruiter')
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('is a clean no-op when unsubscribing an already Unsubscribed candidate (DEC-13)', async () => {
      const cand = await createCandidate({
        status: 'Unsubscribed',
        statusBeforeUnsubscribe: 'Contacted',
        outreachStopped: true,
      });

      const res = await CandidateStatusService.transition(cand._id, 'Unsubscribed', 'system');
      expect(res.noOp).toBe(true);
      expect(res.newStatus).toBe('Unsubscribed');

      // Ensure no new duplicate ActivityLog was written for the no-op
      const logCount = await ActivityLog.countDocuments({ candidateId: cand._id });
      expect(logCount).toBe(0);
    });

    it('allows Unsubscribed from Replied once contacted (DEC-13)', async () => {
      const cand = await createCandidate({ status: 'Replied', contactedAt: new Date() });
      const res = await CandidateStatusService.transition(cand._id, 'Unsubscribed', 'system');
      expect(res.newStatus).toBe('Unsubscribed');
      const updated = await Candidate.findById(cand._id);
      expect(updated?.statusBeforeUnsubscribe).toBe('Replied');
    });

    it('allows Unsubscribed from Interested once contacted (DEC-13)', async () => {
      const cand = await createCandidate({ status: 'Interested', contactedAt: new Date() });
      const res = await CandidateStatusService.transition(cand._id, 'Unsubscribed', 'system');
      expect(res.newStatus).toBe('Unsubscribed');
      const updated = await Candidate.findById(cand._id);
      expect(updated?.statusBeforeUnsubscribe).toBe('Interested');
    });

    it('allows Unsubscribed from Not interested once contacted (DEC-13)', async () => {
      const cand = await createCandidate({ status: 'Not interested', contactedAt: new Date() });
      const res = await CandidateStatusService.transition(cand._id, 'Unsubscribed', 'system');
      expect(res.newStatus).toBe('Unsubscribed');
      const updated = await Candidate.findById(cand._id);
      expect(updated?.statusBeforeUnsubscribe).toBe('Not interested');
    });

    it('allows Unsubscribed from Meeting booked once contacted (DEC-13)', async () => {
      const cand = await createCandidate({ status: 'Meeting booked', contactedAt: new Date() });
      const res = await CandidateStatusService.transition(cand._id, 'Unsubscribed', 'system');
      expect(res.newStatus).toBe('Unsubscribed');
      const updated = await Candidate.findById(cand._id);
      expect(updated?.statusBeforeUnsubscribe).toBe('Meeting booked');
    });

    it('allows Unsubscribed from Interviewed once contacted (DEC-13)', async () => {
      const cand = await createCandidate({ status: 'Interviewed', contactedAt: new Date() });
      const res = await CandidateStatusService.transition(cand._id, 'Unsubscribed', 'system');
      expect(res.newStatus).toBe('Unsubscribed');
      const updated = await Candidate.findById(cand._id);
      expect(updated?.statusBeforeUnsubscribe).toBe('Interviewed');
    });

    it('allows Unsubscribed from Shortlisted once contacted (DEC-13)', async () => {
      const cand = await createCandidate({ status: 'Shortlisted', contactedAt: new Date() });
      const res = await CandidateStatusService.transition(cand._id, 'Unsubscribed', 'system');
      expect(res.newStatus).toBe('Unsubscribed');
      const updated = await Candidate.findById(cand._id);
      expect(updated?.statusBeforeUnsubscribe).toBe('Shortlisted');
    });

    it('allows Unsubscribed from Hired once contacted (DEC-13)', async () => {
      const cand = await createCandidate({ status: 'Hired', contactedAt: new Date() });
      const res = await CandidateStatusService.transition(cand._id, 'Unsubscribed', 'system');
      expect(res.newStatus).toBe('Unsubscribed');
      const updated = await Candidate.findById(cand._id);
      expect(updated?.statusBeforeUnsubscribe).toBe('Hired');
    });

    it('rejects Unsubscribed from Accepted if candidate was never contacted', async () => {
      const cand = await createCandidate({ status: 'Accepted' });
      await expect(
        CandidateStatusService.transition(cand._id, 'Unsubscribed', 'recruiter')
      ).rejects.toThrow(InvalidStateTransitionError);
    });
  });

  describe('3. Forbidden Transitions (422 INVALID_STATE_TRANSITION)', () => {
    it('rejects skipping stages: Sourced directly to Hired or Interviewed', async () => {
      const cand = await createCandidate({ status: 'Sourced' });

      await expect(
        CandidateStatusService.transition(cand._id, 'Hired', 'recruiter')
      ).rejects.toThrow(InvalidStateTransitionError);

      await expect(
        CandidateStatusService.transition(cand._id, 'Interviewed', 'recruiter')
      ).rejects.toThrow(InvalidStateTransitionError);

      const dbCand = await Candidate.findById(cand._id);
      expect(dbCand?.status).toBe('Sourced');
    });

    it('rejects transitioning to Contacted if candidate lacks an email', async () => {
      const cand = await createCandidate({
        status: 'Accepted',
        email: undefined,
        emailStatus: 'missing',
      });

      await expect(
        CandidateStatusService.transition(cand._id, 'Contacted', 'system')
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('rejects moving out of Hired to any other status except Unsubscribed', async () => {
      const cand = await createCandidate({ status: 'Hired' });

      await expect(
        CandidateStatusService.transition(cand._id, 'Rejected', 'recruiter')
      ).rejects.toThrow(InvalidStateTransitionError);

      await expect(
        CandidateStatusService.transition(cand._id, 'Sourced', 'recruiter')
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('rejects moving out of Unsubscribed to any active recruitment status', async () => {
      const cand = await createCandidate({
        status: 'Unsubscribed',
        statusBeforeUnsubscribe: 'Accepted',
      });

      await expect(
        CandidateStatusService.transition(cand._id, 'Accepted', 'recruiter')
      ).rejects.toThrow(InvalidStateTransitionError);

      await expect(
        CandidateStatusService.transition(cand._id, 'Contacted', 'system')
      ).rejects.toThrow(InvalidStateTransitionError);
    });
  });

  describe('4. Direct REST Status Endpoint: PATCH /api/candidates/:id/status (DEC-16)', () => {
    it('accepts a valid status change with 200 OK and logs activity', async () => {
      const cand = await createCandidate({ status: 'Sourced' });

      const res = await request(app)
        .patch(`/api/candidates/${cand._id}/status`)
        .send({
          newStatus: 'Accepted',
          reason: 'Direct UI button click from review card',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.previousStatus).toBe('Sourced');
      expect(res.body.newStatus).toBe('Accepted');

      const updated = await Candidate.findById(cand._id);
      expect(updated?.status).toBe('Accepted');

      const log = await ActivityLog.findOne({ candidateId: cand._id, newStatus: 'Accepted' });
      expect(log).toBeDefined();
      expect(log?.actor).toBe('recruiter');
    });

    it('returns 422 INVALID_STATE_TRANSITION on forbidden transitions', async () => {
      const cand = await createCandidate({ status: 'Sourced' });

      const res = await request(app)
        .patch(`/api/candidates/${cand._id}/status`)
        .send({
          newStatus: 'Hired',
          reason: 'Illegal skip',
        });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
      expect(res.body.error.message).toContain("Cannot transition candidate from 'Sourced' to 'Hired'");
    });

    it('returns 400 on invalid candidateId format', async () => {
      const res = await request(app)
        .patch('/api/candidates/invalid-id/status')
        .send({ newStatus: 'Accepted' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 if candidate does not exist', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .patch(`/api/candidates/${fakeId}/status`)
        .send({ newStatus: 'Accepted' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('CANDIDATE_NOT_FOUND');
    });
  });

  describe('5. Read Tool: find_candidates', () => {
    it('filters candidates by job, status, and minScore in descending order', async () => {
      const c1 = await createCandidate({ fullName: 'TestCand Top', score: 95, status: 'Sourced' });
      const c2 = await createCandidate({ fullName: 'TestCand Mid', score: 75, status: 'Sourced' });
      const c3 = await createCandidate({ fullName: 'TestCand Low', score: 40, status: 'Sourced' });
      const c4 = await createCandidate({ fullName: 'TestCand Acc', score: 90, status: 'Accepted' });

      // Find Sourced candidates with score >= 70
      const result = await executeFindCandidates({
        jobId: testJobIdStr,
        status: 'Sourced',
        minScore: 70,
      });

      expect(result.success).toBe(true);
      expect(result.count).toBe(2);
      expect(result.candidates[0].fullName).toBe('TestCand Top');
      expect(result.candidates[0].score).toBe(95);
      expect(result.candidates[1].fullName).toBe('TestCand Mid');
      expect(result.candidates[1].score).toBe(75);
    });
  });

  describe('6. Bulk Candidate Review & Confirmation Gate (propose_candidate_review)', () => {
    it('creates a BULK_REVIEW PendingAction and candidate_table card without mutating status before confirmation', async () => {
      const c1 = await createCandidate({ status: 'Sourced', score: 92 });
      const c2 = await createCandidate({ status: 'Sourced', score: 88 });
      const conversationId = new mongoose.Types.ObjectId().toString();

      const toolRes = await executeProposeCandidateReview(
        {
          jobId: testJobIdStr,
          candidateIds: [c1._id.toString(), c2._id.toString()],
          decision: 'accept',
          reason: 'Top 2 candidates from scoring',
        },
        conversationId
      );

      expect(toolRes.success).toBe(true);
      expect(toolRes.card).toBeDefined();
      expect(toolRes.card!.cardType).toBe('candidate_table');
      expect(toolRes.card!.status).toBe('pending');
      expect(toolRes.card!.actionId).toBeDefined();
      expect(toolRes.card!.payload.candidates.length).toBe(2);

      const actionId = toolRes.card!.actionId!;

      // Invariant: Statuses MUST NOT change before confirmation
      const cand1Before = await Candidate.findById(c1._id);
      const cand2Before = await Candidate.findById(c2._id);
      expect(cand1Before?.status).toBe('Sourced');
      expect(cand2Before?.status).toBe('Sourced');

      // Confirm the action via PendingActionService
      const confirmRes = await PendingActionService.confirmAction(actionId, conversationId);
      expect(confirmRes.status).toBe('EXECUTED');
      expect(confirmRes.result.targetStatus).toBe('Accepted');
      expect(confirmRes.result.updatedCount).toBe(2);

      // Verify statuses updated in DB
      const cand1After = await Candidate.findById(c1._id);
      const cand2After = await Candidate.findById(c2._id);
      expect(cand1After?.status).toBe('Accepted');
      expect(cand2After?.status).toBe('Accepted');

      // Verify ActivityLog entries written
      const logs = await ActivityLog.find({
        candidateId: { $in: [c1._id, c2._id] },
        newStatus: 'Accepted',
      });
      expect(logs.length).toBe(2);
      expect(logs[0].actor).toBe('agent');
    });

    it('rejects bulk review when action is cancelled and leaves statuses unchanged', async () => {
      const c1 = await createCandidate({ status: 'Sourced', score: 45 });
      const conversationId = new mongoose.Types.ObjectId().toString();

      const toolRes = await executeProposeCandidateReview(
        {
          jobId: testJobIdStr,
          candidateIds: [c1._id.toString()],
          decision: 'reject',
        },
        conversationId
      );

      const actionId = toolRes.card!.actionId!;

      // Cancel the action
      const cancelRes = await PendingActionService.cancelAction(actionId, conversationId, 'User changed mind');
      expect(cancelRes.status).toBe('CANCELLED');

      // Verify candidate status was NOT changed
      const cand = await Candidate.findById(c1._id);
      expect(cand?.status).toBe('Sourced');

      // Attempting to confirm cancelled action fails
      await expect(
        PendingActionService.confirmAction(actionId, conversationId)
      ).rejects.toThrow();
    });
  });

  describe('7. Ambiguous Name Resolution (Item 4)', () => {
    it('matches exact full name case-insensitively', async () => {
      await createCandidate({ fullName: 'Sarah Chen' });
      await createCandidate({ fullName: 'Sarah Chen-Alt' });

      const res = await resolveCandidateByName(testJobId, 'sarah chen');
      expect(res.success).toBe(true);
      expect(res.candidate?.fullName).toBe('Sarah Chen');
    });

    it('matches a unique partial name when only one candidate matches', async () => {
      await createCandidate({ fullName: 'Tariq Al-Mansoor' });

      const res = await resolveCandidateByName(testJobId, 'Tariq');
      expect(res.success).toBe(true);
      expect(res.candidate?.fullName).toBe('Tariq Al-Mansoor');
    });

    it('refuses to guess and returns error with candidate names on ambiguous partial match', async () => {
      await createCandidate({ fullName: 'Alex Rivera' });
      await createCandidate({ fullName: 'Alex Mercer' });

      const res = await resolveCandidateByName(testJobId, 'Alex');
      expect(res.success).toBe(false);
      expect(res.error).toContain('ambiguous and matches multiple candidates');
      expect(res.ambiguousCandidates).toContain('Alex Rivera');
      expect(res.ambiguousCandidates).toContain('Alex Mercer');
    });

    it('returns candidate not found on non-matching name', async () => {
      const res = await resolveCandidateByName(testJobId, 'Nonexistent Candidate');
      expect(res.success).toBe(false);
      expect(res.error).toContain('not found');
      expect(res.ambiguousCandidates).toEqual([]);
    });

    it('propose_candidate_review rejects ambiguous candidate names with clear error', async () => {
      await createCandidate({ fullName: 'John Doe' });
      await createCandidate({ fullName: 'John Smith' });

      const res = await executeProposeCandidateReview(
        {
          jobId: testJobIdStr,
          candidateIds: ['John'],
          decision: 'accept',
        },
        new mongoose.Types.ObjectId().toString()
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('ambiguous and matches multiple candidates');
    });
  });
});

