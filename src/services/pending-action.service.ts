import mongoose from 'mongoose';
import { PendingAction, IPendingAction, ActionType } from '../models';
import { JobService, jobPayloadSchema } from './job.service';
import { publishConversationEvent } from './event-bus.service';
import { sourcingQueue } from '../queues';

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

