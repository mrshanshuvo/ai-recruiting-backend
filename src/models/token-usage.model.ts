import mongoose, { Schema, Types } from 'mongoose';

export type TokenCaller =
  | 'agent'
  | 'worker:scoring'
  | 'worker_scoring'
  | 'worker:classification'
  | 'worker_classification'
  | 'worker:drafting'
  | 'worker_drafting';

export interface ITokenUsage {
  _id: Types.ObjectId;
  jobId?: Types.ObjectId;
  conversationId?: Types.ObjectId;
  caller: TokenCaller;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  timestamp: Date;
}

const TokenUsageSchema = new Schema<ITokenUsage>(
  {
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: false },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: false },
    caller: {
      type: String,
      enum: [
        'agent',
        'worker:scoring',
        'worker_scoring',
        'worker:classification',
        'worker_classification',
        'worker:drafting',
        'worker_drafting',
      ],
      required: true,
    },
    model: { type: String, required: true },
    promptTokens: { type: Number, required: true },
    completionTokens: { type: Number, required: true },
    totalTokens: { type: Number, required: true },
    estimatedCostUsd: { type: Number, default: 0 },
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

TokenUsageSchema.index({ jobId: 1, timestamp: -1 });
TokenUsageSchema.index({ caller: 1 });

export const TokenUsage = mongoose.model<ITokenUsage>('TokenUsage', TokenUsageSchema);
