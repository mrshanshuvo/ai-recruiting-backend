import mongoose from 'mongoose';
import crypto from 'crypto';
import {
  PendingAction,
  IPendingAction,
  ActionType,
  CandidateStatus,
  Campaign,
  CampaignStep,
  OutreachMessage,
  Candidate,
} from '../models';
import { JobService, jobPayloadSchema } from './job.service';
import { CandidateStatusService } from './candidate-status.service';
import { publishConversationEvent } from './event-bus.service';
import { sourcingQueue, outreachSendQueue } from '../queues';
import { EmailTransportService } from './email-transport.service';
import { env } from '../config/env';

export class ActionError extends Error {
  public statusCode: number;
  public code: string;
  public details?: unknown;

  constructor(code: string, message: string, statusCode = 422, details?: unknown) {
    super(message);
    this.name = 'ActionError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class PendingActionService {
  public static async createAction(params: {
    conversationId: mongoose.Types.ObjectId | string;
    jobId?: mongoose.Types.ObjectId | string;
    actionType: ActionType;
    payload: Record<string, unknown>;
    description?: string;
    expiresAt?: Date;
  }): Promise<IPendingAction> {
    // Validate payload on creation
    if (params.actionType === 'CREATE_JOB') {
      const parsed = jobPayloadSchema.safeParse(params.payload);
      if (!parsed.success) {
        throw new ActionError('VALIDATION_ERROR', 'Invalid job proposal payload', 422, parsed.error.format());
      }
    }

    const action = await PendingAction.create({
      conversationId: new mongoose.Types.ObjectId(params.conversationId),
      jobId: params.jobId ? new mongoose.Types.ObjectId(params.jobId) : undefined,
      actionType: params.actionType,
      status: 'PENDING',
      payload: params.payload,
      description: params.description,
      expiresAt: params.expiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    return action;
  }

  public static async getAction(id: string): Promise<IPendingAction> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new ActionError('INVALID_ID', 'Invalid action ID format', 400);
    }

    const action = await PendingAction.findById(id);
    if (!action) {
      throw new ActionError('ENTITY_NOT_FOUND', 'Pending action not found', 404);
    }

    // In-code expiration check
    if (action.status === 'PENDING' && action.expiresAt <= new Date()) {
      action.status = 'EXPIRED';
      await action.save();
      await publishConversationEvent(action.conversationId.toString(), 'CARD_UPDATED', {
        actionId: action._id.toString(),
        status: 'expired',
      });
    }

    return action;
  }

  public static async resolveActionId(
    conversationId: string,
    actionId?: string,
    operation: 'confirm' | 'cancel' = 'confirm'
  ): Promise<{ resolvedId?: string; error?: string }> {
    if (actionId) {
      return { resolvedId: actionId };
    }

    const now = new Date();
    const pendingActions = await PendingAction.find({
      conversationId: new mongoose.Types.ObjectId(conversationId),
      status: 'PENDING',
      expiresAt: { $gt: now },
    }).sort({ createdAt: -1 });

    if (pendingActions.length === 0) {
      return {
        error: `No active pending action found to ${operation} in this conversation.`,
      };
    }

    if (pendingActions.length === 1) {
      return { resolvedId: pendingActions[0]._id.toString() };
    }

    const list = pendingActions
      .map(
        (a) =>
          `[Type: ${a.actionType}, Title: "${(a.payload as any)?.title || a.description || 'Untitled'}", Created: ${a.createdAt.toISOString()}]`
      )
      .join(', ');

    return {
      error: `Multiple pending actions exist (${list}). Please specify which one you want to ${operation}.`,
    };
  }

  public static async updatePayload(id: string, editedPayload: Record<string, unknown>): Promise<IPendingAction> {
    const action = await this.getAction(id);

    if (action.status !== 'PENDING') {
      throw new ActionError(
        action.status === 'EXPIRED' ? 'ACTION_EXPIRED' : 'ACTION_NOT_PENDING',
        `Cannot update payload for action with status ${action.status}`,
        422
      );
    }

    // Validate edited payload schema
    if (action.actionType === 'CREATE_JOB') {
      const parsed = jobPayloadSchema.safeParse(editedPayload);
      if (!parsed.success) {
        throw new ActionError('VALIDATION_ERROR', 'Invalid edited job payload', 422, parsed.error.format());
      }
    }

    action.editedPayload = editedPayload;
    await action.save();

    return action;
  }

  public static async confirmAction(
    id: string,
    conversationId?: string,
    modifiedPayload?: Record<string, unknown>
  ): Promise<{
    actionId: string;
    status: 'EXECUTED';
    result: Record<string, unknown>;
    originalPayload?: Record<string, unknown>;
    effectivePayload?: Record<string, unknown>;
  }> {
    const action = await this.getAction(id);

    // Verify conversation ownership if specified (e.g. from chat confirm_action tool)
    if (conversationId && action.conversationId.toString() !== conversationId) {
      throw new ActionError(
        'ACTION_CONVERSATION_MISMATCH',
        'Cannot confirm an action belonging to a different conversation',
        422
      );
    }

    // Check expiration
    if (action.status === 'EXPIRED' || action.expiresAt <= new Date()) {
      if (action.status !== 'EXPIRED') {
        action.status = 'EXPIRED';
        await action.save();
        await publishConversationEvent(action.conversationId.toString(), 'CARD_UPDATED', {
          actionId: action._id.toString(),
          status: 'expired',
        });
      }
      throw new ActionError('ACTION_EXPIRED', 'Action has expired and cannot be confirmed', 422);
    }

    if (action.status === 'CANCELLED') {
      throw new ActionError('ACTION_CANCELLED', 'Action has been cancelled and cannot be confirmed', 422);
    }

    if (action.status === 'EXECUTED') {
      throw new ActionError('ACTION_ALREADY_EXECUTED', 'Action has already been executed', 422);
    }

    // Validate modified payload if passed with confirm
    if (modifiedPayload) {
      if (action.actionType === 'CREATE_JOB') {
        const parsed = jobPayloadSchema.safeParse(modifiedPayload);
        if (!parsed.success) {
          throw new ActionError('VALIDATION_ERROR', 'Invalid modified payload', 422, parsed.error.format());
        }
      }
    }

    // Atomic state transition: findOneAndUpdate with status === "PENDING"
    const updateDoc: Record<string, unknown> = {
      status: 'EXECUTED',
      executedAt: new Date(),
    };
    if (modifiedPayload) {
      updateDoc.editedPayload = modifiedPayload;
    }

    const atomicResult = await PendingAction.findOneAndUpdate(
      { _id: action._id, status: 'PENDING' },
      { $set: updateDoc },
      { new: false }
    );

    if (!atomicResult) {
      throw new ActionError(
        'ACTION_ALREADY_EXECUTED',
        'Action was already executed or is no longer pending',
        422
      );
    }

    // Determine effective payload (editedPayload || payload)
    const originalPayload = (atomicResult.payload || {}) as Record<string, unknown>;
    const effectivePayload = (modifiedPayload || atomicResult.editedPayload || atomicResult.payload) as Record<
      string,
      unknown
    >;

    // Delegate to specialized execution handler
    let result: Record<string, unknown> = {};

    switch (atomicResult.actionType) {
      case 'CREATE_JOB': {
        const job = await JobService.createConfirmedJob(effectivePayload, atomicResult.conversationId);
        result = {
          jobId: job._id.toString(),
          title: job.title,
          appliedEdits: atomicResult.editedPayload ? atomicResult.editedPayload : undefined,
        };
        break;
      }
      case 'START_SOURCING': {
        const jobId = effectivePayload.jobId as string;
        const targetCount = Number(effectivePayload.targetCount) || 10;
        const searchQueries = (effectivePayload.searchQueries as string[]) || [];

        const bullJob = await sourcingQueue.add('source_candidates', {
          jobId,
          conversationId: atomicResult.conversationId.toString(),
          targetCount,
          searchQueries,
          actionId: atomicResult._id.toString(),
        });

        result = {
          jobId,
          jobTitle: (effectivePayload.jobTitle as string) || 'Job',
          targetCount,
          searchQueries,
          bullJobId: bullJob.id,
        };
        break;
      }
      case 'BULK_REVIEW': {
        const candidateIds = (effectivePayload.candidateIds as string[]) || [];
        const decision = (effectivePayload.decision as string) || 'accept';
        const targetStatus: CandidateStatus =
          (effectivePayload.targetStatus as CandidateStatus) ||
          (decision === 'accept' ? 'Accepted' : 'Rejected');
        const reason = (effectivePayload.reason as string) || `Bulk review (${decision})`;

        const bulkResult = await CandidateStatusService.bulkTransition(
          candidateIds,
          targetStatus,
          'agent',
          reason
        );

        result = {
          jobId: effectivePayload.jobId,
          decision,
          targetStatus,
          updatedCount: bulkResult.updatedCount,
          totalRequested: candidateIds.length,
          results: bulkResult.results,
        };
        break;
      }
      case 'SEND_CAMPAIGN': {
        const jobId = effectivePayload.jobId as string;
        const jobTitle = (effectivePayload.jobTitle as string) || 'Job';
        const campaignName = (effectivePayload.name as string) || `${jobTitle} Outreach Campaign`;
        const candidateIds = (effectivePayload.candidateIds as string[]) || [];
        const steps = (effectivePayload.steps as Array<{
          stepIndex: number;
          delayDays: number;
          subject: string;
          bodyTemplate: string;
        }>) || [];

        // 1. Create Campaign
        const campaign = await Campaign.create({
          jobId: new mongoose.Types.ObjectId(jobId),
          name: campaignName,
          status: 'ACTIVE',
          dailySendLimit: env.DAILY_SEND_LIMIT || 50,
        });

        // 2. Create CampaignSteps
        const createdSteps: any[] = [];
        const step0Subject = steps[0]?.subject || `Opportunity: ${jobTitle} at Aironauts Technologies`;
        for (const s of steps) {
          let stepSubject = s.subject;
          if (s.stepIndex > 0) {
            if (!stepSubject || stepSubject.startsWith('Re:') || stepSubject.startsWith('Final follow-up:')) {
              stepSubject = `Following up: ${step0Subject}`;
            } else if (!stepSubject.startsWith('Following up:')) {
              stepSubject = `Following up: ${step0Subject}`;
            }
          }
          const stepDoc = await CampaignStep.create({
            campaignId: campaign._id,
            stepIndex: s.stepIndex,
            delayDays: s.delayDays,
            subjectTemplate: stepSubject,
            bodyTemplate: s.bodyTemplate,
          });
          createdSteps.push(stepDoc);
        }

        // 3. Find candidates and enqueue BullMQ jobs for each candidate and step
        const candidates = await Candidate.find({ _id: { $in: candidateIds } }).lean();
        const delayUnit = env.OUTREACH_STEP_DELAY_UNIT; // 'seconds' | 'days'

        let enqueuedCount = 0;
        for (const candidate of candidates) {
          const candidateMeta = (effectivePayload.candidates as any[])?.find(
            (c: any) => c.candidateId === candidate._id.toString() || c._id === candidate._id.toString()
          );
          const personalOpening = candidateMeta?.personalOpening || '';

          for (const stepDoc of createdSteps) {
            let delayMs = 0;
            if (stepDoc.delayDays > 0) {
              delayMs =
                delayUnit === 'seconds'
                  ? stepDoc.delayDays * 1000
                  : stepDoc.delayDays * 24 * 60 * 60 * 1000;
            }

            // Create pre-queued OutreachMessage record
            await OutreachMessage.create({
              campaignId: campaign._id,
              campaignStepId: stepDoc._id,
              stepIndex: stepDoc.stepIndex,
              candidateId: candidate._id,
              jobId: new mongoose.Types.ObjectId(jobId),
              toEmail: candidate.email || 'unknown@example.com',
              subject: stepDoc.subjectTemplate,
              body: stepDoc.bodyTemplate,
              personalOpening: stepDoc.stepIndex === 0 ? personalOpening : undefined,
              status: 'QUEUED',
            });

            // Enqueue with deterministic job ID per ADR-0006 (using dash separator for BullMQ v5 compatibility)
            const deterministicJobId = `outreach-${campaign._id}-${candidate._id}-${stepDoc.stepIndex}`;
            await outreachSendQueue.add(
              'send_outreach_step',
              {
                campaignId: campaign._id.toString(),
                campaignStepId: stepDoc._id.toString(),
                candidateId: candidate._id.toString(),
                jobId,
                stepIndex: stepDoc.stepIndex,
                conversationId: atomicResult.conversationId.toString(),
              },
              {
                jobId: deterministicJobId,
                delay: delayMs,
              }
            );
            enqueuedCount++;
          }
        }

        result = {
          campaignId: campaign._id.toString(),
          name: campaign.name,
          jobId,
          jobTitle,
          recipientCount: candidates.length,
          stepsCount: createdSteps.length,
          enqueuedJobsCount: enqueuedCount,
        };
        break;
      }
      case 'PAUSE_CAMPAIGN': {
        const campaignId = effectivePayload.campaignId as string;
        await Campaign.findByIdAndUpdate(campaignId, { status: 'PAUSED' });
        result = { campaignId, status: 'PAUSED' };
        break;
      }
      case 'RESUME_CAMPAIGN': {
        const campaignId = effectivePayload.campaignId as string;
        await Campaign.findByIdAndUpdate(campaignId, { status: 'ACTIVE' });

        // Find all QUEUED messages for this campaign and re-enqueue them
        const queuedMessages = await OutreachMessage.find({
          campaignId: new mongoose.Types.ObjectId(campaignId),
          status: 'QUEUED',
        });

        const campaignSteps = await CampaignStep.find({ campaignId: new mongoose.Types.ObjectId(campaignId) });
        const stepMap = new Map(campaignSteps.map((s) => [s._id.toString(), s]));

        let reEnqueuedCount = 0;
        for (const msg of queuedMessages) {
          const stepDoc = stepMap.get(msg.campaignStepId.toString());
          const delayUnit = env.OUTREACH_STEP_DELAY_UNIT;
          let delayMs = 0;
          if (stepDoc && stepDoc.delayDays > 0) {
            delayMs =
              delayUnit === 'seconds'
                ? stepDoc.delayDays * 1000
                : stepDoc.delayDays * 24 * 60 * 60 * 1000;
          }

          const deterministicJobId = `outreach-${campaignId}-${msg.candidateId}-${msg.stepIndex}`;
          try {
            const existingJob = await outreachSendQueue.getJob(deterministicJobId);
            if (existingJob) {
              await existingJob.remove();
            }
          } catch {}

          await outreachSendQueue.add(
            'send_outreach_step',
            {
              campaignId,
              campaignStepId: msg.campaignStepId.toString(),
              candidateId: msg.candidateId.toString(),
              jobId: msg.jobId.toString(),
              stepIndex: msg.stepIndex,
              conversationId: atomicResult.conversationId.toString(),
            },
            {
              jobId: deterministicJobId,
              delay: delayMs,
            }
          );
          reEnqueuedCount++;
        }

        result = { campaignId, status: 'ACTIVE', reEnqueuedCount };
        break;
      }
      case 'SEND_BOOKING_LINK': {
        const candidateId = effectivePayload.candidateId as string;
        const candidate = await Candidate.findById(candidateId);
        if (!candidate) throw new ActionError('CANDIDATE_NOT_FOUND', `Candidate ${candidateId} not found`, 404);

        if (!candidate.bookingToken) {
          candidate.bookingToken = crypto.randomBytes(24).toString('hex');
          await candidate.save();
        }

        const transitionRes = await CandidateStatusService.transition(
          candidate._id,
          'Meeting booked',
          'agent',
          'Recruiter approved and sent meeting booking link'
        );

        const bookingUrl = `${env.PUBLIC_FRONTEND_URL}/mock-booking/${candidate.bookingToken}`;

        const sendRes = await EmailTransportService.sendMail({
          to: candidate.email || 'candidate@example.com',
          subject: (effectivePayload.subject as string) || `Interview Invitation: Aironauts Technologies`,
          text:
            (effectivePayload.body as string) ||
            `Hi ${candidate.fullName.split(' ')[0]},\n\nPlease select a time slot for our introductory call:\n${bookingUrl}\n\nBest regards,\nAironauts Recruiting Team`,
        });

        result = {
          candidateId,
          candidateName: candidate.fullName,
          bookingToken: candidate.bookingToken,
          bookingUrl,
          status: 'Meeting booked',
          previousStatus: transitionRes.previousStatus,
          previewUrl: (sendRes as any).previewUrl || null,
        };
        break;
      }
      case 'UPDATE_STATUS': {
        const candidateId = effectivePayload.candidateId as string;
        const newStatus = effectivePayload.newStatus as CandidateStatus;
        const reason = (effectivePayload.reason as string) || 'Recruiter status update via chat';

        const transitionRes = await CandidateStatusService.transition(
          candidateId,
          newStatus,
          'recruiter',
          reason
        );

        result = {
          candidateId,
          newStatus: transitionRes.newStatus,
          previousStatus: transitionRes.previousStatus,
        };
        break;
      }
      case 'SEND_REPLY': {
        const candidateId = effectivePayload.candidateId as string;
        const replyBody = (effectivePayload.replyBody as string) || (effectivePayload.draftedBody as string) || '';
        const candidate = await Candidate.findById(candidateId);
        if (!candidate) throw new ActionError('CANDIDATE_NOT_FOUND', `Candidate ${candidateId} not found`, 404);

        const sendRes = await EmailTransportService.sendMail({
          to: candidate.email || 'candidate@example.com',
          subject: (effectivePayload.subject as string) || 'Re: Your Application / Outreach at Aironauts',
          text: replyBody,
        });

        result = {
          candidateId,
          sent: true,
          previewUrl: (sendRes as any).previewUrl || null,
        };
        break;
      }
      default:
        result = { executed: true, appliedEdits: atomicResult.editedPayload };
    }

    const cardStatus = atomicResult.actionType === 'START_SOURCING' ? 'in_progress' : 'confirmed';

    // Emit CARD_UPDATED via Redis Pub/Sub to SSE
    await publishConversationEvent(atomicResult.conversationId.toString(), 'CARD_UPDATED', {
      actionId: atomicResult._id.toString(),
      status: cardStatus,
      result,
    });

    return {
      actionId: atomicResult._id.toString(),
      status: 'EXECUTED',
      result,
      originalPayload,
      effectivePayload,
    };
  }

  public static async cancelAction(
    id: string,
    conversationId?: string,
    _reason?: string
  ): Promise<{ actionId: string; status: 'CANCELLED'; title: string }> {
    const action = await this.getAction(id);

    if (conversationId && action.conversationId.toString() !== conversationId) {
      throw new ActionError(
        'ACTION_CONVERSATION_MISMATCH',
        'Cannot cancel an action belonging to a different conversation',
        422
      );
    }

    if (action.status !== 'PENDING') {
      throw new ActionError(
        'ACTION_NOT_PENDING',
        `Cannot cancel action with status ${action.status}`,
        422
      );
    }

    const atomicResult = await PendingAction.findOneAndUpdate(
      { _id: action._id, status: 'PENDING' },
      { $set: { status: 'CANCELLED' } },
      { new: false }
    );

    if (!atomicResult) {
      throw new ActionError('ACTION_NOT_PENDING', 'Action was already processed', 422);
    }

    const title = (atomicResult.payload as any)?.title || 'Job Proposal';

    await publishConversationEvent(atomicResult.conversationId.toString(), 'CARD_UPDATED', {
      actionId: atomicResult._id.toString(),
      status: 'cancelled',
    });

    return {
      actionId: atomicResult._id.toString(),
      status: 'CANCELLED',
      title,
    };
  }
}

