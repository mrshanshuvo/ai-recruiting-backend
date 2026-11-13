import mongoose, { Schema, Document, Types } from 'mongoose';

export type JobStatus = 'OPEN' | 'SOURCING' | 'PAUSED' | 'CLOSED';
export type RemotePolicy = 'Remote' | 'Hybrid' | 'On-site';

export interface ISalaryRange {
  min: number;
  max: number;
  currency: string;
}

export interface IJob extends Document {
  _id: Types.ObjectId;
  title: string;
  rawDescription?: string;
  mustHaveSkills: string[];
  niceToHaveSkills: string[];
  seniority?: string;
  location?: string;
  salaryRange?: ISalaryRange;
  remotePolicy?: RemotePolicy;
  status: JobStatus;
  conversationId?: Types.ObjectId;
  candidateCounts: Record<string, number>;
  createdAt: Date;
  updatedAt: Date;
}

const JobSchema = new Schema<IJob>(
  {
    title: { type: String, required: true },
    rawDescription: { type: String, required: false },
    mustHaveSkills: { type: [String], default: [] },
    niceToHaveSkills: { type: [String], default: [] },
    seniority: { type: String, required: false },
    location: { type: String, required: false },
    salaryRange: {
      min: { type: Number, required: false },
      max: { type: Number, required: false },
      currency: { type: String, default: 'USD' },
    },
    remotePolicy: {
      type: String,
      enum: ['Remote', 'Hybrid', 'On-site'],
      required: false,
    },
    status: {
      type: String,
      enum: ['OPEN', 'SOURCING', 'PAUSED', 'CLOSED'],
      default: 'OPEN',
    },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: false },
    candidateCounts: {
      type: Map,
      of: Number,
      default: {},
    },
  },
  { timestamps: true }
);

JobSchema.index({ status: 1 });
JobSchema.index({ createdAt: -1 });

export const Job = mongoose.model<IJob>('Job', JobSchema);

