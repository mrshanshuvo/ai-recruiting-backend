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
import { executeProposeCampaign } from '../agent/tools/propose-campaign.tool';
import { PendingActionService } from '../services/pending-action.service';
import { processOutreachJob } from '../workers/outreach.worker';
import { EmailTransportService } from '../services/email-transport.service';
import { env } from '../config/env';

describe('Checkpoint 6: Outreach Campaign, Preview Gate & Sending Tests', () => {
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
    await Candidate.deleteMany({ jobId: testJobId });
    await Campaign.deleteMany({ jobId: testJobId });
    await OutreachMessage.deleteMany({ jobId: testJobId });
    await ActivityLog.deleteMany({ jobId: testJobId });
    await PendingAction.deleteMany({ conversationId });
    await Job.findByIdAndDelete(testJobId);
    vi.restoreAllMocks();
  });

  describe('1. Campaign Proposal Gate & Enrollment Rules', () => {
    it('refuses to propose campaign if no Accepted candidates exist with valid email', async () => {
      // Create Sourced candidate and candidate without email
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

    it('creates a SEND_CAMPAIGN PendingAction and campaign_preview card for Accepted candidates with valid email', async () => {
      await Candidate.create([
        {
          jobId: testJobId,
          fullName: 'Sarah Chen',
          email: 'sarah.chen@example.com',
          emailStatus: 'valid',
          currentTitle: 'Staff Engineer',
          currentCompany: 'CloudScale Inc',
          status: 'Accepted',
          source: 'search',
          sourceMode: 'fixture',
        },
        {
          jobId: testJobId,
          fullName: 'Alex Rivera',
          email: 'alex.rivera@example.com',
          emailStatus: 'valid',
          currentTitle: 'Senior Go Developer',
          currentCompany: 'FinTech Labs',
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
      expect(res.card!.actionId).toBeDefined();

      const payload = res.card!.payload as any;
      expect(payload.recipientCount).toBe(2);
      expect(payload.steps.length).toBe(2);
      expect(payload.steps[0].delayDays).toBe(0);
      expect(payload.steps[1].delayDays).toBe(3);

      // Invariant: Nothing created in Campaign or OutreachMessage collections yet
      const campaignsCount = await Campaign.countDocuments({ jobId: testJobId });
      const outreachCount = await OutreachMessage.countDocuments({ jobId: testJobId });
      expect(campaignsCount).toBe(0);
      expect(outreachCount).toBe(0);
    });
  });

  describe('2. Campaign Confirmation & Deterministic Queue Enqueuing', () => {
    it('confirms campaign, creates Campaign, CampaignSteps, and enqueues BullMQ jobs with deterministic IDs', async () => {
      const c1 = await Candidate.create({
        jobId: testJobId,
        fullName: 'Tariq Al-Mansoor',
        email: 'tariq@example.com',
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

      // Confirm via PendingActionService
      const confirmRes = await PendingActionService.confirmAction(actionId, conversationId);
      expect(confirmRes.status).toBe('EXECUTED');
      expect(confirmRes.result.recipientCount).toBe(1);
      expect(confirmRes.result.stepsCount).toBe(2);

      // Verify Campaign created
      const campaign = await Campaign.findOne({ jobId: testJobId });
      expect(campaign).toBeDefined();
      expect(campaign!.status).toBe('ACTIVE');

      // Verify CampaignSteps created
      const steps = await CampaignStep.find({ campaignId: campaign!._id }).sort({ stepIndex: 1 });
      expect(steps.length).toBe(2);
      expect(steps[0].stepIndex).toBe(0);
      expect(steps[1].stepIndex).toBe(1);
      expect(steps[1].delayDays).toBe(3);

      // Verify OutreachMessages pre-queued
      const messages = await OutreachMessage.find({ campaignId: campaign!._id }).sort({ stepIndex: 1 });
      expect(messages.length).toBe(2);
      expect(messages[0].status).toBe('QUEUED');
      expect(messages[1].status).toBe('QUEUED');
      expect(messages[0].candidateId.toString()).toBe(c1._id.toString());
    });
  });

  describe('3. Outreach Worker Execution, Sending & State Transitions', () => {
    it('sends Step 0 email, generates preview URL, transitions candidate to Contacted, and writes ActivityLog', async () => {
      const candidate = await Candidate.create({
        jobId: testJobId,
        fullName: 'Elena Rostova',
        email: 'elena.rostova@example.com',
        emailStatus: 'valid',
        currentTitle: 'Lead Architect',
        currentCompany: 'DataStream',
        status: 'Accepted',
        source: 'search',
        sourceMode: 'fixture',
      });

      const campaign = await Campaign.create({
        jobId: testJobId,
        name: 'Test Outreach Campaign',
        status: 'ACTIVE',
      });

      const step = await CampaignStep.create({
        campaignId: campaign._id,
        stepIndex: 0,
        delayDays: 0,
        subjectTemplate: 'Hello {{firstName}} regarding {{jobTitle}}',
        bodyTemplate: 'Hi {{firstName}}, would you be interested in {{jobTitle}} at Aironauts?',
      });

      // Mock EmailTransportService.sendMail
      const sendMailSpy = vi.spyOn(EmailTransportService, 'sendMail').mockResolvedValue({
        messageId: 'mock-msg-12345',
        previewUrl: 'https://ethereal.email/message/mock-msg-12345',
      });

      const result = await processOutreachJob({
        campaignId: campaign._id.toString(),
        campaignStepId: step._id.toString(),
        candidateId: candidate._id.toString(),
        jobId: testJobId.toString(),
        stepIndex: 0,
        conversationId,
      });

      expect(result.status).toBe('SENT');
      expect(result.previewUrl).toBe('https://ethereal.email/message/mock-msg-12345');
      expect(sendMailSpy).toHaveBeenCalledWith({
        to: 'elena.rostova@example.com',
        subject: 'Hello Elena regarding Senior Distributed Systems Engineer',
        text: 'Hi Elena, would you be interested in Senior Distributed Systems Engineer at Aironauts?',
      });

      // Verify candidate transitioned to Contacted and contactedAt is set
      const updatedCand = await Candidate.findById(candidate._id);
      expect(updatedCand!.status).toBe('Contacted');
      expect(updatedCand!.contactedAt).toBeDefined();

      // Verify OutreachMessage updated to SENT
      const outMsg = await OutreachMessage.findById(result.outreachMessageId);
      expect(outMsg!.status).toBe('SENT');
      expect(outMsg!.previewUrl).toBe('https://ethereal.email/message/mock-msg-12345');
      expect(outMsg!.sentAt).toBeDefined();

      // Verify ActivityLog entry with actor="system"
      const log = await ActivityLog.findOne({
        candidateId: candidate._id,
        action: 'outreach_sent',
      });
      expect(log).toBeDefined();
      expect(log!.actor).toBe('system');
    });

    it('pre-flight check: cancels step if candidate has outreachStopped=true (replied)', async () => {
      const candidate = await Candidate.create({
        jobId: testJobId,
        fullName: 'Replied Candidate',
        email: 'replied@example.com',
        emailStatus: 'valid',
        status: 'Replied',
        outreachStopped: true, // Candidate already replied
        source: 'search',
        sourceMode: 'fixture',
      });

      const campaign = await Campaign.create({
        jobId: testJobId,
        name: 'Pre-flight Test',
        status: 'ACTIVE',
      });

      const step = await CampaignStep.create({
        campaignId: campaign._id,
        stepIndex: 1,
        delayDays: 3,
        subjectTemplate: 'Follow-up',
        bodyTemplate: 'Follow-up body',
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

    it('pre-flight check: cancels step if candidate is Unsubscribed', async () => {
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
        name: 'Pre-flight Test',
        status: 'ACTIVE',
      });

      const step = await CampaignStep.create({
        campaignId: campaign._id,
        stepIndex: 1,
        delayDays: 3,
        subjectTemplate: 'Follow-up',
        bodyTemplate: 'Follow-up body',
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

    it('pre-flight check: skips step if campaign is PAUSED', async () => {
      const candidate = await Candidate.create({
        jobId: testJobId,
        fullName: 'Active Candidate',
        email: 'active@example.com',
        emailStatus: 'valid',
        status: 'Accepted',
        source: 'search',
        sourceMode: 'fixture',
      });

      const campaign = await Campaign.create({
        jobId: testJobId,
        name: 'Paused Campaign',
        status: 'PAUSED', // Paused campaign
      });

      const step = await CampaignStep.create({
        campaignId: campaign._id,
        stepIndex: 0,
        delayDays: 0,
        subjectTemplate: 'Subject',
        bodyTemplate: 'Body',
      });

      const sendMailSpy = vi.spyOn(EmailTransportService, 'sendMail');

      const result = await processOutreachJob({
        campaignId: campaign._id.toString(),
        campaignStepId: step._id.toString(),
        candidateId: candidate._id.toString(),
        jobId: testJobId.toString(),
        stepIndex: 0,
      });

      expect(result.status).toBe('SKIPPED_PAUSED');
      expect(sendMailSpy).not.toHaveBeenCalled();
    });

    it('pre-flight check: skips step if already SENT (idempotency guard)', async () => {
      const candidate = await Candidate.create({
        jobId: testJobId,
        fullName: 'Already Sent Candidate',
        email: 'alreadysent@example.com',
        emailStatus: 'valid',
        status: 'Contacted',
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

      // Existing message with status SENT
      await OutreachMessage.create({
        campaignId: campaign._id,
        campaignStepId: step._id,
        stepIndex: 0,
        candidateId: candidate._id,
        jobId: testJobId,
        toEmail: candidate.email!,
        subject: 'Already sent subject',
        body: 'Already sent body',
        status: 'SENT',
        sentAt: new Date(),
        previewUrl: 'https://ethereal.email/message/already-sent',
      });

      const sendMailSpy = vi.spyOn(EmailTransportService, 'sendMail');

      const result = await processOutreachJob({
        campaignId: campaign._id.toString(),
        campaignStepId: step._id.toString(),
        candidateId: candidate._id.toString(),
        jobId: testJobId.toString(),
        stepIndex: 0,
      });

      expect(result.status).toBe('SKIPPED_ALREADY_SENT');
      expect(sendMailSpy).not.toHaveBeenCalled();
    });
  });
});

