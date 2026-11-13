import { Worker, Job as BullJob } from 'bullmq';
import mongoose from 'mongoose';
import { redisConnection } from '../config/redis';
import { env } from '../config/env';
import {
  Candidate,
  Job,
  Campaign,
  CampaignStep,
  OutreachMessage,
  ActivityLog,
} from '../models';
import { OUTREACH_SEND_QUEUE_NAME, outreachSendQueue } from '../queues';
import { EmailTransportService } from '../services/email-transport.service';
import { CandidateStatusService } from '../services/candidate-status.service';
import { publishConversationEvent } from '../services/event-bus.service';

export interface OutreachJobPayload {
  campaignId: string;
  campaignStepId: string;
  candidateId: string;
  jobId: string;
  stepIndex: number;
  conversationId?: string;
}

export type OutreachJobResultStatus =
  | 'SENT'
  | 'SKIPPED_REPLIED'
  | 'SKIPPED_UNSUBSCRIBED'
  | 'SKIPPED_PAUSED'
  | 'SKIPPED_ALREADY_SENT'
  | 'SKIPPED_DAILY_LIMIT'
  | 'RE_DELAYED_DAILY_LIMIT'
  | 'SKIPPED_NO_EMAIL';

export interface OutreachJobResult {
  outreachMessageId?: string;
  candidateId: string;
  sentAt?: string;
  previewUrl?: string;
  status: OutreachJobResultStatus;
  delayUntil?: string;
}

export async function processOutreachJob(
  payload: OutreachJobPayload
): Promise<OutreachJobResult> {
  const { campaignId, campaignStepId, candidateId, jobId, stepIndex, conversationId } = payload;
  console.log(`[OutreachWorker] Processing step ${stepIndex} for candidate ${candidateId} (campaign ${campaignId})`);

  const [campaign, step, candidate, job] = await Promise.all([
    Campaign.findById(campaignId),
    CampaignStep.findById(campaignStepId),
    Candidate.findById(candidateId),
    Job.findById(jobId),
  ]);

  if (!candidate || !job || !campaign || !step) {
    console.warn(`[OutreachWorker] Missing record for candidate ${candidateId} or campaign ${campaignId}. Skipping.`);
    return { candidateId, status: 'SKIPPED_NO_EMAIL' };
  }

  // Find or create the OutreachMessage record
  let outreachMsg = await OutreachMessage.findOne({
    campaignId: campaign._id,
    candidateId: candidate._id,
    stepIndex,
  });

  if (!outreachMsg) {
    outreachMsg = await OutreachMessage.create({
      campaignId: campaign._id,
      campaignStepId: step._id,
      stepIndex,
      candidateId: candidate._id,
      jobId: job._id,
      toEmail: candidate.email || 'unknown@example.com',
      subject: step.subjectTemplate,
      body: step.bodyTemplate,
      status: 'QUEUED',
    });
  }

  // Pre-flight check 1: Candidate replied?
  if (candidate.outreachStopped) {
    console.log(`[OutreachWorker] Candidate ${candidate.fullName} has outreachStopped=true. Cancelling step ${stepIndex}.`);
    outreachMsg.status = 'CANCELLED';
    outreachMsg.errorMessage = 'Outreach stopped due to candidate reply';
    await outreachMsg.save();
    return { outreachMessageId: outreachMsg._id.toString(), candidateId, status: 'SKIPPED_REPLIED' };
  }

  // Pre-flight check 2: Candidate unsubscribed?
  if (candidate.status === 'Unsubscribed') {
    console.log(`[OutreachWorker] Candidate ${candidate.fullName} is Unsubscribed. Cancelling step ${stepIndex}.`);
    outreachMsg.status = 'CANCELLED';
    outreachMsg.errorMessage = 'Candidate unsubscribed';
    await outreachMsg.save();
    return { outreachMessageId: outreachMsg._id.toString(), candidateId, status: 'SKIPPED_UNSUBSCRIBED' };
  }

  // Pre-flight check 3: Campaign paused?
  if (campaign.status === 'PAUSED') {
    console.log(`[OutreachWorker] Campaign ${campaign.name} is PAUSED. Skipping send.`);
    return { outreachMessageId: outreachMsg._id.toString(), candidateId, status: 'SKIPPED_PAUSED' };
  }

  // Pre-flight check 4: Step already sent? (Idempotency guard per DEC-12)
  if (outreachMsg.status === 'SENT') {
    console.log(`[OutreachWorker] Step ${stepIndex} already sent for candidate ${candidate.fullName}. Skipping.`);
    return {
      outreachMessageId: outreachMsg._id.toString(),
      candidateId,
      previewUrl: outreachMsg.previewUrl,
      sentAt: outreachMsg.sentAt?.toISOString(),
      status: 'SKIPPED_ALREADY_SENT',
    };
  }

  // Pre-flight check 5: Candidate lacks email?
  if (!candidate.email || candidate.emailStatus === 'missing') {
    console.log(`[OutreachWorker] Candidate ${candidate.fullName} has no email. Cancelling.`);
    outreachMsg.status = 'CANCELLED';
    outreachMsg.errorMessage = 'Candidate has no valid email';
    await outreachMsg.save();
    return { outreachMessageId: outreachMsg._id.toString(), candidateId, status: 'SKIPPED_NO_EMAIL' };
  }

  // Pre-flight check 6: Daily send limit check per DEC-20 and ADR-0006
  const startOfUtcDay = new Date();
  startOfUtcDay.setUTCHours(0, 0, 0, 0);
  const sentToday = await OutreachMessage.countDocuments({
    campaignId: campaign._id,
    status: 'SENT',
    sentAt: { $gte: startOfUtcDay },
  });

  const dailyLimit = campaign.dailySendLimit || env.DAILY_SEND_LIMIT || 50;
  if (sentToday >= dailyLimit) {
    console.warn(`[OutreachWorker] Daily send limit reached for campaign (${sentToday}/${dailyLimit}). Re-delaying job to next UTC day.`);
    const nextUtcMidnight = new Date();
    nextUtcMidnight.setUTCDate(nextUtcMidnight.getUTCDate() + 1);
    nextUtcMidnight.setUTCHours(0, 0, 1, 0);
    const delayMs = Math.max(nextUtcMidnight.getTime() - Date.now(), 1000);

    const deterministicJobId = `outreach-${campaign._id}-${candidate._id}-${stepIndex}`;
    await outreachSendQueue.add('send_outreach_step', payload, {
      jobId: deterministicJobId,
      delay: delayMs,
    });

    return {
      outreachMessageId: outreachMsg._id.toString(),
      candidateId,
      status: 'RE_DELAYED_DAILY_LIMIT',
      delayUntil: nextUtcMidnight.toISOString(),
    };
  }

  // Template interpolation
  const firstName = candidate.fullName.split(' ')[0] || candidate.fullName;
  const renderedSubject = step.subjectTemplate
    .replace(/\{\{candidateName\}\}/g, candidate.fullName)
    .replace(/\{\{firstName\}\}/g, firstName)
    .replace(/\{\{jobTitle\}\}/g, job.title)
    .replace(/\{\{companyName\}\}/g, candidate.currentCompany || 'your team');

  const personalOpening = outreachMsg.personalOpening || '';
  let renderedBody = step.bodyTemplate
    .replace(/\{\{personalOpening\}\}/g, personalOpening)
    .replace(/\{\{candidateName\}\}/g, candidate.fullName)
    .replace(/\{\{firstName\}\}/g, firstName)
    .replace(/\{\{jobTitle\}\}/g, job.title)
    .replace(/\{\{companyName\}\}/g, candidate.currentCompany || 'your current company')
    .replace(/\{\{currentTitle\}\}/g, candidate.currentTitle || 'Engineer');

  if (personalOpening && !step.bodyTemplate.includes('{{personalOpening}}')) {
    const greetingMatch = renderedBody.match(/^(Hi [^\n]+,\n\n)/);
    if (greetingMatch) {
      renderedBody = renderedBody.replace(greetingMatch[0], `${greetingMatch[0]}${personalOpening}\n\n`);
    } else {
      renderedBody = `${personalOpening}\n\n${renderedBody}`;
    }
  }

  // Dispatch email via Nodemailer transport (Ethereal sandbox by default, falls back to local)
  const mailResult = await EmailTransportService.sendMail({
    to: candidate.email,
    subject: renderedSubject,
    text: renderedBody,
  });

  const now = new Date();
  outreachMsg.status = 'SENT';
  outreachMsg.sentAt = now;
  outreachMsg.subject = renderedSubject;
  outreachMsg.body = renderedBody;
  outreachMsg.transport = mailResult.transport;
  outreachMsg.previewUrl = mailResult.previewUrl;
  await outreachMsg.save();

  // If initial outreach (stepIndex 0), transition candidate status to 'Contacted'
  if (stepIndex === 0 && candidate.status === 'Accepted') {
    candidate.contactedAt = now;
    await candidate.save();

    await CandidateStatusService.transition(
      candidate._id.toString(),
      'Contacted',
      'system',
      `Initial outreach dispatched (Step 0) via campaign "${campaign.name}"`
    );
  }

  // Log activity
  await ActivityLog.create({
    jobId: job._id,
    candidateId: candidate._id,
    actor: 'system',
    action: 'outreach_sent',
    previousStatus: null,
    newStatus: null,
    details: {
      campaignId: campaign._id.toString(),
      stepIndex,
      subject: renderedSubject,
      previewUrl: mailResult.previewUrl,
    },
    timestamp: now,
  });

  // Emit SSE progress event if conversationId is available
  if (conversationId) {
    await publishConversationEvent(conversationId, 'CAMPAIGN_PROGRESS', {
      campaignId: campaign._id.toString(),
      candidateId: candidate._id.toString(),
      candidateName: candidate.fullName,
      stepIndex,
      status: 'SENT',
      previewUrl: mailResult.previewUrl,
    });
  }

  return {
    outreachMessageId: outreachMsg._id.toString(),
    candidateId: candidate._id.toString(),
    sentAt: now.toISOString(),
    previewUrl: mailResult.previewUrl,
    status: 'SENT',
  };
}

export function createOutreachWorker(): Worker<OutreachJobPayload, OutreachJobResult> {
  const worker = new Worker<OutreachJobPayload, OutreachJobResult>(
    OUTREACH_SEND_QUEUE_NAME,
    async (job: BullJob<OutreachJobPayload>) => {
      return processOutreachJob(job.data);
    },
    {
      connection: redisConnection,
      concurrency: 1, // Sequential rate-limiting per DEC-20
      limiter: {
        max: 10,
        duration: 1000, // Max 10 per second speed limiter
      },
    }
  );

  worker.on('completed', (job: BullJob) => {
    console.log(`[OutreachWorker] Job ${job.id} completed successfully.`);
  });

  worker.on('failed', (job: BullJob | undefined, err: Error) => {
    console.error(`[OutreachWorker] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
