import mongoose, { Schema, Document, Types } from 'mongoose';

export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED';

export interface ICampaign extends Document {
  _id: Types.ObjectId;
  jobId: Types.ObjectId;
  name: string;
  status: CampaignStatus;
  dailySendLimit: number;
  createdAt: Date;
  updatedAt: Date;
}

const CampaignSchema = new Schema<ICampaign>(
  {
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    name: { type: String, required: true },
    status: {
      type: String,
      enum: ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED'],
      default: 'DRAFT',
    },
    dailySendLimit: { type: Number, default: 50 },
  },
  { timestamps: true }
);

CampaignSchema.index({ jobId: 1, status: 1 });

export const Campaign = mongoose.model<ICampaign>('Campaign', CampaignSchema);

