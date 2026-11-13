import mongoose, { Schema, Document, Types } from 'mongoose';

export type OutreachStatus = 'QUEUED' | 'SENT' | 'FAILED' | 'CANCELLED';
export type EmailTransportType = 'ethereal' | 'smtp' | 'local';

export interface IOutreachMessage extends Document {
  _id: Types.ObjectId;
  campaignId: Types.ObjectId;
  campaignStepId: Types.ObjectId;
  stepIndex: number;
  candidateId: Types.ObjectId;
  jobId: Types.ObjectId;
  toEmail: string;
  subject: string;
  body: string;
  personalOpening?: string;
  status: OutreachStatus;
  transport?: EmailTransportType;
  sentAt?: Date;
  previewUrl?: string;
  errorMessage?: string;
  createdAt: Date;
}

const OutreachMessageSchema = new Schema<IOutreachMessage>(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    campaignStepId: { type: Schema.Types.ObjectId, ref: 'CampaignStep', required: true },
    stepIndex: { type: Number, required: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'Candidate', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    toEmail: { type: String, required: true },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    personalOpening: { type: String, required: false },
    status: {
      type: String,
      enum: ['QUEUED', 'SENT', 'FAILED', 'CANCELLED'],
      default: 'QUEUED',
    },
    transport: {
      type: String,
      enum: ['ethereal', 'smtp', 'local'],
      default: 'ethereal',
    },
    sentAt: { type: Date, required: false },
    previewUrl: { type: String, required: false },
    errorMessage: { type: String, required: false },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

OutreachMessageSchema.index({ campaignId: 1, candidateId: 1, stepIndex: 1 }, { unique: true });
OutreachMessageSchema.index({ status: 1, sentAt: 1 });

export const OutreachMessage = mongoose.model<IOutreachMessage>('OutreachMessage', OutreachMessageSchema);

