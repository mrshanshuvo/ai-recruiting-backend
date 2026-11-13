import mongoose, { Schema, Document, Types } from 'mongoose';

export type ActionType =
  | 'CREATE_JOB'
  | 'START_SOURCING'
  | 'BULK_REVIEW'
  | 'SEND_CAMPAIGN'
  | 'SEND_REPLY'
  | 'SEND_BOOKING_LINK'
  | 'UPDATE_STATUS'
  | 'PAUSE_CAMPAIGN'
  | 'RESUME_CAMPAIGN';

export type ActionStatus = 'PENDING' | 'EXECUTED' | 'CANCELLED' | 'EXPIRED';

export interface IPendingAction extends Document {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  jobId?: Types.ObjectId;
  actionType: ActionType;
  status: ActionStatus;
  payload: Record<string, unknown>;
  editedPayload?: Record<string, unknown> | null;
  description?: string;
  expiresAt: Date;
  executedAt?: Date;
  createdAt: Date;
}

const PendingActionSchema = new Schema<IPendingAction>(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: false },
    actionType: {
      type: String,
      enum: [
        'CREATE_JOB',
        'START_SOURCING',
        'BULK_REVIEW',
        'SEND_CAMPAIGN',
        'SEND_REPLY',
        'SEND_BOOKING_LINK',
        'UPDATE_STATUS',
        'PAUSE_CAMPAIGN',
        'RESUME_CAMPAIGN',
      ],
      required: true,
    },
    status: {
      type: String,
      enum: ['PENDING', 'EXECUTED', 'CANCELLED', 'EXPIRED'],
      default: 'PENDING',
    },
    payload: { type: Schema.Types.Mixed, required: true },
    editedPayload: { type: Schema.Types.Mixed, default: null },
    description: { type: String, required: false },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
    executedAt: { type: Date, required: false },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// Indexes: conversationId + status for fast lookup, and expiresAt index for expiration checks (NO TTL index; documents are never auto-deleted)
PendingActionSchema.index({ conversationId: 1, status: 1 });
PendingActionSchema.index({ expiresAt: 1 });

export const PendingAction = mongoose.model<IPendingAction>('PendingAction', PendingActionSchema);
