import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  Candidate,
  Job,
  Campaign,
  CampaignStep,
  OutreachMessage,
  ActivityLog,
  PendingAction,
} from '../models';
import { executeProposeCampaign, generateCandidateOpening } from '../agent/tools/propose-campaign.tool';
import { PendingActionService } from '../services/pending-action.service';
import { CandidateStatusService } from '../services/candidate-status.service';
import { processOutreachJob } from '../workers/outreach.worker';
import { EmailTransportService } from '../services/email-transport.service';
import { env } from '../config/env';

describe('Checkpoint 6 & Requirement 5: Outreach Campaign, Preview Gate & Sending Tests', () => {
  let testJobId: mongoose.Types.ObjectId;
  let conversationId: string;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(env.MONGO_URI);
    }
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    conversationId = new mongoose.Types.ObjectId().toString();

    const job = await Job.create({
      title: 'Senior Distributed Systems Engineer',
      mustHaveSkills: ['Go', 'Kubernetes', 'gRPC'],
      seniority: 'Senior',
      location: 'Remote',
      remotePolicy: 'Remote',
      status: 'OPEN',
    });
    testJobId = job._id;
  });

  afterEach(async () => {
    EmailTransportService.resetTransporter();
    await Candidate.deleteMany({ jobId: testJobId });
    await Campaign.deleteMany({ jobId: testJobId });
    await OutreachMessage.deleteMany({ jobId: testJobId });
    await ActivityLog.deleteMany({ jobId: testJobId });
    await PendingAction.deleteMany({ conversationId });
    await Job.findByIdAndDelete(testJobId);
    vi.restoreAllMocks();
  });

  describe('Enrollment & Personalization', () => {
    it('g. a candidate without a valid email is never enrolled', async () => {
      // Create Sourced candidate, and Accepted candidate with missing email
      await Candidate.create([
        {
          jobId: testJobId,
          fullName: 'Sourced Only Candidate',
          email: 'sourced@example.com',
          emailStatus: 'valid',
          status: 'Sourced',
          source: 'search',
          sourceMode: 'fixture',
        },
        {
          jobId: testJobId,
          fullName: 'Accepted No Email Candidate',
          emailStatus: 'missing',
          status: 'Accepted',
          source: 'search',
          sourceMode: 'fixture',
        },
      ]);

      const res = await executeProposeCampaign(
        { jobId: testJobId.toString() },
        conversationId
      );

      expect(res.success).toBe(false);
      expect(res.error).toContain('No Accepted candidates with valid emails found');
      expect(res.card).toBeUndefined();
    });

    it('personalization: a candidate with an empty snippet and no skills gets no personal claim', () => {
      const thinCandidate = {
        fullName: 'Alex Plain',
        currentTitle: 'Engineer',
        currentCompany: 'Acme',
        skills: [],
        snippet: '',
      };
      const opening = generateCandidateOpening(thinCandidate, 'Senior Distributed Systems Engineer');
      expect(opening).toBe('');
    });

    it('personalization: generates opening from stored title, company, and skills without hallucinating', () => {
      const richCandidate = {
        fullName: 'Zoe Washington',
        currentTitle: 'Senior Distributed Systems Engineer',
        currentCompany: 'HyperGrid',
        skills: ['Go', 'Kubernetes', 'gRPC'],
        snippet: 'Distributed systems architect specialized in streaming.',
      };
      const opening = generateCandidateOpening(richCandidate, 'Senior Distributed Systems Engineer');
      expect(opening).toContain('Senior Distributed Systems Engineer');
      expect(opening).toContain('HyperGrid');
      expect(opening).toContain('Go, Kubernetes, gRPC');
    });

    it('creates a SEND_CAMPAIGN proposal card with 3 steps (Day 0, Day 3, Day 7) and recipient metadata', async () => {
      await Candidate.create([
        {
          jobId: testJobId,
          fullName: 'Sarah Chen',
          email: 'sarah.chen@example.com',
          emailStatus: 'valid',
          currentTitle: 'Staff Engineer',
          currentCompany: 'CloudScale Inc',
          skills: ['Go', 'Kafka'],
          status: 'Accepted',
          source: 'search',
          sourceMode: 'fixture',
        },
      ]);

      const res = await executeProposeCampaign(
        { jobId: testJobId.toString() },
        conversationId
      );

      expect(res.success).toBe(true);
      expect(res.card).toBeDefined();
      expect(res.card!.cardType).toBe('campaign_preview');
      expect(res.card!.status).toBe('pending');

      const payload = res.card!.payload as any;
      expect(payload.recipientCount).toBe(1);
      expect(payload.steps.length).toBe(3);
      expect(payload.steps[0].delayDays).toBe(0);
      expect(payload.steps[1].delayDays).toBe(3);
      expect(payload.steps[2].delayDays).toBe(7);
      expect(payload.candidates[0].personalOpening).toContain('Staff Engineer');
    });
  });

  describe('Campaign Confirmation, Autosave & Sending', () => {
    it('f. the edited subject is the one that is sent', async () => {
      const c = await Candidate.create({
        jobId: testJobId,
        fullName: 'Edited Candidate',
        email: 'edited@example.com',
        emailStatus: 'valid',
        status: 'Accepted',
        source: 'search',
        sourceMode: 'fixture',
      });

      const propRes = await executeProposeCampaign(
        { jobId: testJobId.toString() },
        conversationId
      );

      const actionId = propRes.card!.actionId!;
      const originalPayload = propRes.card!.payload as any;

      // Recruiter edits subject of Step 0 via autosave/confirm
      const updatedSteps = [...originalPayload.steps];
      updatedSteps[0].subject = 'CUSTOM EDITED SUBJECT: Urgent Opportunity';

      await PendingActionService.updatePayload(actionId, {
        ...originalPayload,
        steps: updatedSteps,
      });

      // Confirm with modifiedPayload
      await PendingActionService.confirmAction(actionId, conversationId);

      const campaign = await Campaign.findOne({ jobId: testJobId });
      const step0 = await CampaignStep.findOne({ campaignId: campaign!._id, stepIndex: 0 });

      expect(step0!.subjectTemplate).toBe('CUSTOM EDITED SUBJECT: Urgent Opportunity');

      const sendMailSpy = vi.spyOn(EmailTransportService, 'sendMail').mockResolvedValue({
        messageId: 'mock-edit-1',
        previewUrl: 'https://ethereal.email/message/mock-edit-1',
        transport: 'ethereal',
      });

      await processOutreachJob({
        campaignId: campaign!._id.toString(),
        campaignStepId: step0!._id.toString(),
        candidateId: c._id.toString(),
        jobId: testJobId.toString(),
        stepIndex: 0,
      });

      expect(sendMailSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'CUSTOM EDITED SUBJECT: Urgent Opportunity',
        })
      );
    });

    it('a. the same step for the same candidate is never sent twice (two jobs with the same ID and two worker instances)', async () => {
      const candidate = await Candidate.create({
        jobId: testJobId,
        fullName: 'Duplicate Guard Candidate',
        email: 'dup@example.com',
        emailStatus: 'valid',
        status: 'Accepted',
        source: 'search',
        sourceMode: 'fixture',
      });

      const campaign = await Campaign.create({
        jobId: testJobId,
        name: 'Idempotency Campaign',
        status: 'ACTIVE',
      });

      const step = await CampaignStep.create({
        campaignId: campaign._id,
        stepIndex: 0,
        delayDays: 0,
        subjectTemplate: 'Subject',
        bodyTemplate: 'Body',
      });

      let sendMailCount = 0;
      vi.spyOn(EmailTransportService, 'sendMail').mockImplementation(async () => {
        sendMailCount++;
        return {
          messageId: `mock-dup-${sendMailCount}`,
          previewUrl: `https://ethereal.email/message/${sendMailCount}`,
          transport: 'ethereal',
        };
      });

      const payload = {
        campaignId: campaign._id.toString(),
        campaignStepId: step._id.toString(),
        candidateId: candidate._id.toString(),
        jobId: testJobId.toString(),
        stepIndex: 0,
      };

      // Run instance 1
      const res1 = await processOutreachJob(payload);
      expect(res1.status).toBe('SENT');
      expect(sendMailCount).toBe(1);

      // Run instance 2 with identical payload / deterministic job ID
      const res2 = await processOutreachJob(payload);
      expect(res2.status).toBe('SKIPPED_ALREADY_SENT');
      expect(sendMailCount).toBe(1); // Not sent twice
    });

    it('b. a step is skipped when the candidate replied', async () => {
      const candidate = await Candidate.create({
        jobId: testJobId,
        fullName: 'Replied Candidate',
        email: 'replied@example.com',
        emailStatus: 'valid',
        status: 'Replied',
        outreachStopped: true,
        source: 'search',
        sourceMode: 'fixture',
      });

      const campaign = await Campaign.create({
        jobId: testJobId,
        name: 'Replied Campaign',
        status: 'ACTIVE',
      });

      const step = await CampaignStep.create({
        campaignId: campaign._id,
        stepIndex: 1,
        delayDays: 3,
        subjectTemplate: 'Follow-up',
        bodyTemplate: 'Body',
      });

      const sendMailSpy = vi.spyOn(EmailTransportService, 'sendMail');

      const result = await processOutreachJob({
        campaignId: campaign._id.toString(),
        campaignStepId: step._id.toString(),
        candidateId: candidate._id.toString(),
        jobId: testJobId.toString(),
        stepIndex: 1,
      });

      expect(result.status).toBe('SKIPPED_REPLIED');
      expect(sendMailSpy).not.toHaveBeenCalled();

      const msg = await OutreachMessage.findOne({ campaignId: campaign._id, candidateId: candidate._id });
      expect(msg!.status).toBe('CANCELLED');
    });

    it('c. a step is skipped when the candidate unsubscribed', async () => {
      const candidate = await Candidate.create({
        jobId: testJobId,
        fullName: 'Unsub Candidate',
        email: 'unsub@example.com',
        emailStatus: 'valid',
        status: 'Unsubscribed',
        source: 'search',
        sourceMode: 'fixture',
      });

      const campaign = await Campaign.create({
        jobId: testJobId,
        name: 'Unsub Campaign',
        status: 'ACTIVE',
      });

      const step = await CampaignStep.create({
        campaignId: campaign._id,
        stepIndex: 1,
        delayDays: 3,
        subjectTemplate: 'Follow-up',
        bodyTemplate: 'Body',
      });

      const sendMailSpy = vi.spyOn(EmailTransportService, 'sendMail');

      const result = await processOutreachJob({
        campaignId: campaign._id.toString(),
        campaignStepId: step._id.toString(),
        candidateId: candidate._id.toString(),
        jobId: testJobId.toString(),
        stepIndex: 1,
      });

      expect(result.status).toBe('SKIPPED_UNSUBSCRIBED');
      expect(sendMailSpy).not.toHaveBeenCalled();
    });

    it('d. a step is skipped when the campaign is paused', async () => {
      const candidate = await Candidate.create({
        jobId: testJobId,
        fullName: 'Paused Candidate',
        email: 'paused@example.com',
        emailStatus: 'valid',
        status: 'Accepted',
        source: 'search',
        sourceMode: 'fixture',
      });

      const campaign = await Campaign.create({
        jobId: testJobId,
        name: 'Paused Campaign',
        status: 'PAUSED',
      });

      const step = await CampaignStep.create({
        campaignId: campaign._id,
        stepIndex: 1,
        delayDays: 3,
        subjectTemplate: 'Subject',
        bodyTemplate: 'Body',
      });

      const sendMailSpy = vi.spyOn(EmailTransportService, 'sendMail');

      const result = await processOutreachJob({
        campaignId: campaign._id.toString(),
        campaignStepId: step._id.toString(),
        candidateId: candidate._id.toString(),
        jobId: testJobId.toString(),
        stepIndex: 1,
      });

      expect(result.status).toBe('SKIPPED_PAUSED');
      expect(sendMailSpy).not.toHaveBeenCalled();
    });

    it('e. the daily limit re-delays the job to the next UTC day', async () => {
      const candidate = await Candidate.create({
        jobId: testJobId,
        fullName: 'Rate Limited Candidate',
        email: 'ratelimit@example.com',
        emailStatus: 'valid',
        status: 'Accepted',
        source: 'search',
        sourceMode: 'fixture',
      });

      const campaign = await Campaign.create({
        jobId: testJobId,
        name: 'Daily Limit Campaign',
        status: 'ACTIVE',
        dailySendLimit: 1, // Limit of 1 send today
      });

      const step = await CampaignStep.create({
        campaignId: campaign._id,
        stepIndex: 0,
        delayDays: 0,
        subjectTemplate: 'Subject',
        bodyTemplate: 'Body',
      });

      // Existing message sent today to reach daily limit
      await OutreachMessage.create({
        campaignId: campaign._id,
        campaignStepId: step._id,
        stepIndex: 0,
        candidateId: new mongoose.Types.ObjectId(),
        jobId: testJobId,
        toEmail: 'other@example.com',
        subject: 'Prior email',
        body: 'Prior body',
        status: 'SENT',
        sentAt: new Date(),
      });

      const sendMailSpy = vi.spyOn(EmailTransportService, 'sendMail');

      const result = await processOutreachJob({
        campaignId: campaign._id.toString(),
        campaignStepId: step._id.toString(),
        candidateId: candidate._id.toString(),
        jobId: testJobId.toString(),
        stepIndex: 0,
      });

      expect(result.status).toBe('RE_DELAYED_DAILY_LIMIT');
      expect(result.delayUntil).toBeDefined();
      expect(sendMailSpy).not.toHaveBeenCalled();
    });
  });

  describe('Template Placeholder Rendering & Outreach Cancellation', () => {
    it('fails if any sent email (subject or body, any step) still contains "{{"', async () => {
      const candidate = await Candidate.create({
        jobId: testJobId,
        fullName: 'Jordan Miller',
        currentTitle: 'Senior Frontend Engineer',
        currentCompany: 'WebFlow Co',
        skills: ['React', 'TypeScript', 'GraphQL'],
        email: 'jordan@example.com',
        emailStatus: 'valid',
        status: 'Accepted',
        source: 'csv',
        sourceMode: 'csv',
      });

      const campaign = await Campaign.create({
        jobId: testJobId,
        name: 'Placeholder Test Campaign',
        status: 'ACTIVE',
      });

      const step0 = await CampaignStep.create({
        campaignId: campaign._id,
        stepIndex: 0,
        delayDays: 0,
        subjectTemplate: 'Hello {{firstName}}, role at {{companyName}}',
        bodyTemplate: 'Hi {{firstName}},\n\n{{personalOpening}}Job: {{jobTitle}}\n\nBest,\nRecruiting',
      });

      const step1 = await CampaignStep.create({
        campaignId: campaign._id,
        stepIndex: 1,
        delayDays: 3,
        subjectTemplate: 'Following up {{firstName}} for {{jobTitle}}',
        bodyTemplate: 'Hi {{firstName}},\n\nChecking in regarding {{jobTitle}} at {{companyName}}.\n\nBest,\nRecruiting',
      });

      vi.spyOn(EmailTransportService, 'sendMail').mockResolvedValue({
        messageId: 'mock-placeholder-id',
        previewUrl: 'https://ethereal.email/message/1',
        transport: 'ethereal',
      });

      // Process step 0
      const res0 = await processOutreachJob({
        campaignId: campaign._id.toString(),
        campaignStepId: step0._id.toString(),
        candidateId: candidate._id.toString(),
        jobId: testJobId.toString(),
        stepIndex: 0,
      });
      expect(res0.status).toBe('SENT');

      // Process step 1
      const res1 = await processOutreachJob({
        campaignId: campaign._id.toString(),
        campaignStepId: step1._id.toString(),
        candidateId: candidate._id.toString(),
        jobId: testJobId.toString(),
        stepIndex: 1,
      });
      expect(res1.status).toBe('SENT');

      const sentMessages = await OutreachMessage.find({ candidateId: candidate._id, status: 'SENT' });
      expect(sentMessages.length).toBe(2);

      for (const msg of sentMessages) {
        expect(msg.subject).not.toContain('{{');
        expect(msg.subject).not.toContain('}}');
        expect(msg.body).not.toContain('{{');
        expect(msg.body).not.toContain('}}');
        expect(msg.subject).toContain('Jordan');
        expect(msg.body).toContain('Hi Jordan');
      }
    });

    it('reply cancels unsent outreach messages with reason "replied"', async () => {
      const candidate = await Candidate.create({
        jobId: testJobId,
        fullName: 'Alex Vance',
        email: 'alex-vance@example.com',
        emailStatus: 'valid',
        status: 'Contacted',
        source: 'csv',
        sourceMode: 'csv',
      });

      const campaign = await Campaign.create({
        jobId: testJobId,
        name: 'Reply Cancel Test Campaign',
        status: 'ACTIVE',
      });

      const step1 = await CampaignStep.create({
        campaignId: campaign._id,
        stepIndex: 1,
        delayDays: 3,
        subjectTemplate: 'Follow-up 1',
        bodyTemplate: 'Body 1',
      });

      const step2 = await CampaignStep.create({
        campaignId: campaign._id,
        stepIndex: 2,
        delayDays: 7,
        subjectTemplate: 'Follow-up 2',
        bodyTemplate: 'Body 2',
      });

      const msg1 = await OutreachMessage.create({
        campaignId: campaign._id,
        campaignStepId: step1._id,
        stepIndex: 1,
        candidateId: candidate._id,
        jobId: testJobId,
        toEmail: candidate.email,
        subject: 'Follow-up 1',
        body: 'Body 1',
        status: 'QUEUED',
      });

      const msg2 = await OutreachMessage.create({
        campaignId: campaign._id,
        campaignStepId: step2._id,
        stepIndex: 2,
        candidateId: candidate._id,
        jobId: testJobId,
        toEmail: candidate.email,
        subject: 'Follow-up 2',
        body: 'Body 2',
        status: 'QUEUED',
      });

      // Simulate inbound reply
      candidate.outreachStopped = true;
      await candidate.save();
      await OutreachMessage.updateMany(
        { candidateId: candidate._id, status: 'QUEUED' },
        {
          $set: {
            status: 'CANCELLED',
            cancellationReason: 'replied',
            errorMessage: 'Outreach stopped due to candidate reply',
          },
        }
      );

      const updatedMsg1 = await OutreachMessage.findById(msg1._id);
      const updatedMsg2 = await OutreachMessage.findById(msg2._id);

      expect(updatedMsg1?.status).toBe('CANCELLED');
      expect(updatedMsg1?.cancellationReason).toBe('replied');
      expect(updatedMsg2?.status).toBe('CANCELLED');
      expect(updatedMsg2?.cancellationReason).toBe('replied');
    });

    it('unsubscribe cancels unsent outreach messages with reason "unsubscribed"', async () => {
      const candidate = await Candidate.create({
        jobId: testJobId,
        fullName: 'Morgan Lee',
        email: 'morgan-lee@example.com',
        emailStatus: 'valid',
        status: 'Contacted',
        source: 'csv',
        sourceMode: 'csv',
      });

      const campaign = await Campaign.create({
        jobId: testJobId,
        name: 'Unsubscribe Cancel Test Campaign',
        status: 'ACTIVE',
      });

      const step1 = await CampaignStep.create({
        campaignId: campaign._id,
        stepIndex: 1,
        delayDays: 3,
        subjectTemplate: 'Follow-up',
        bodyTemplate: 'Body',
      });

      const msg = await OutreachMessage.create({
        campaignId: campaign._id,
        campaignStepId: step1._id,
        stepIndex: 1,
        candidateId: candidate._id,
        jobId: testJobId,
        toEmail: candidate.email,
        subject: 'Follow-up',
        body: 'Body',
        status: 'QUEUED',
      });

      // Transition to Unsubscribed via CandidateStatusService
      await CandidateStatusService.transition(candidate._id, 'Unsubscribed', 'system', 'Opt-out requested');

      const updatedMsg = await OutreachMessage.findById(msg._id);
      expect(updatedMsg?.status).toBe('CANCELLED');
      expect(updatedMsg?.cancellationReason).toBe('unsubscribed');
      expect(updatedMsg?.errorMessage).toBe('Candidate unsubscribed');
    });

    it('pause does not cancel queued messages, and resume skips cancelled messages', async () => {
      const candidateA = await Candidate.create({
        jobId: testJobId,
        fullName: 'Active Candidate',
        email: 'active@example.com',
        emailStatus: 'valid',
        status: 'Contacted',
        source: 'csv',
        sourceMode: 'csv',
      });

      const candidateB = await Candidate.create({
        jobId: testJobId,
        fullName: 'Cancelled Candidate',
        email: 'cancelled@example.com',
        emailStatus: 'valid',
        status: 'Unsubscribed',
        outreachStopped: true,
        source: 'csv',
        sourceMode: 'csv',
      });

      const campaign = await Campaign.create({
        jobId: testJobId,
        name: 'Pause Resume Lifecycle Campaign',
        status: 'ACTIVE',
      });

      const step1 = await CampaignStep.create({
        campaignId: campaign._id,
        stepIndex: 1,
        delayDays: 3,
        subjectTemplate: 'Follow-up',
        bodyTemplate: 'Body',
      });

      const queuedMsgA = await OutreachMessage.create({
        campaignId: campaign._id,
        campaignStepId: step1._id,
        stepIndex: 1,
        candidateId: candidateA._id,
        jobId: testJobId,
        toEmail: candidateA.email,
        subject: 'Follow-up A',
        body: 'Body A',
        status: 'QUEUED',
      });

      const cancelledMsgB = await OutreachMessage.create({
        campaignId: campaign._id,
        campaignStepId: step1._id,
        stepIndex: 1,
        candidateId: candidateB._id,
        jobId: testJobId,
        toEmail: candidateB.email,
        subject: 'Follow-up B',
        body: 'Body B',
        status: 'CANCELLED',
        cancellationReason: 'unsubscribed',
      });

      // 1. Pause campaign via PendingActionService
      const pauseAction = await PendingActionService.createAction({
        conversationId,
        actionType: 'PAUSE_CAMPAIGN',
        payload: { campaignId: campaign._id.toString() },
      });
      await PendingActionService.confirmAction(pauseAction._id.toString());

      // Verify campaign is PAUSED and queuedMsgA is still QUEUED (pause does not cancel)
      const pausedCampaign = await Campaign.findById(campaign._id);
      expect(pausedCampaign?.status).toBe('PAUSED');
      const msgAAfterPause = await OutreachMessage.findById(queuedMsgA._id);
      expect(msgAAfterPause?.status).toBe('QUEUED');

      // 2. Resume campaign via PendingActionService
      const resumeAction = await PendingActionService.createAction({
        conversationId,
        actionType: 'RESUME_CAMPAIGN',
        payload: { campaignId: campaign._id.toString() },
      });
      const resumeResult = await PendingActionService.confirmAction(resumeAction._id.toString());

      // Resume only re-enqueues QUEUED messages (skips CANCELLED)
      expect(resumeResult.result.reEnqueuedCount).toBe(1);

      const msgAAfterResume = await OutreachMessage.findById(queuedMsgA._id);
      expect(msgAAfterResume?.status).toBe('QUEUED');
      const msgBAfterResume = await OutreachMessage.findById(cancelledMsgB._id);
      expect(msgBAfterResume?.status).toBe('CANCELLED');
    });
  });

  describe('Email Transport Fallback', () => {
    it('email transport fallback: falls back to local transport when Ethereal account creation fails', async () => {
      // Force ethereal failure
      EmailTransportService.setForceEtherealFailure(true);

      const result = await EmailTransportService.sendMail({
        to: 'offline@example.com',
        subject: 'Offline Test',
        text: 'Hello from offline mode',
      });

      expect(result.transport).toBe('local');
      expect(result.messageId).toContain('local-');
      expect(result.previewUrl).toBeUndefined();
    });
  });
});
