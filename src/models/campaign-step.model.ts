import mongoose, { Schema, Document, Types } from 'mongoose';

export interface ICampaignStep extends Document {
  _id: Types.ObjectId;
  campaignId: Types.ObjectId;
  stepIndex: number;
  delayDays: number;
  subjectTemplate: string;
  bodyTemplate: string;
  createdAt: Date;
}

const CampaignStepSchema = new Schema<ICampaignStep>(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    stepIndex: { type: Number, required: true },
    delayDays: { type: Number, default: 0 },
    subjectTemplate: { type: String, required: true },
    bodyTemplate: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

CampaignStepSchema.index({ campaignId: 1, stepIndex: 1 }, { unique: true });

export const CampaignStep = mongoose.model<ICampaignStep>('CampaignStep', CampaignStepSchema);

