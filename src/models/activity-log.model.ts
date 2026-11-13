import mongoose, { Schema, Document, Types } from 'mongoose';

export type ActivityActor = 'recruiter' | 'user' | 'agent' | 'worker' | 'system';

export interface IActivityLog extends Document {
  _id: Types.ObjectId;
  jobId: Types.ObjectId;
  candidateId?: Types.ObjectId;
  actor: ActivityActor;
  action: string;
  previousStatus?: string | null;
  newStatus?: string | null;
  details?: Record<string, unknown>;
  timestamp: Date;
}

const ActivityLogSchema = new Schema<IActivityLog>(
  {
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'Candidate', required: false },
    actor: {
      type: String,
      enum: ['recruiter', 'user', 'agent', 'worker', 'system'],
      required: true,
    },
    action: { type: String, required: true },
    previousStatus: { type: String, default: null },
    newStatus: { type: String, default: null },
    details: { type: Schema.Types.Mixed, default: {} },
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

ActivityLogSchema.index({ jobId: 1, timestamp: -1 });
ActivityLogSchema.index({ candidateId: 1, timestamp: -1 });

export const ActivityLog = mongoose.model<IActivityLog>('ActivityLog', ActivityLogSchema);

