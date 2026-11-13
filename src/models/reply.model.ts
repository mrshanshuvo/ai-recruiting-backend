import mongoose, { Schema, Document, Types } from 'mongoose';

export type ReplyClass =
  | 'Interested'
  | 'Not interested'
  | 'Question'
  | 'Wants a meeting'
  | 'Unsubscribe'
  | 'Out of office';

export interface IReply extends Document {
  _id: Types.ObjectId;
  candidateId: Types.ObjectId;
  jobId: Types.ObjectId;
  outreachMessageId?: Types.ObjectId;
  senderEmail: string;
  body: string;
  replyClass: ReplyClass;
  classificationReason?: string;
  isSimulated: boolean;
  receivedAt: Date;
}

const ReplySchema = new Schema<IReply>(
  {
    candidateId: { type: Schema.Types.ObjectId, ref: 'Candidate', required: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    outreachMessageId: { type: Schema.Types.ObjectId, ref: 'OutreachMessage', required: false },
    senderEmail: { type: String, required: true },
    body: { type: String, required: true },
    replyClass: {
      type: String,
      enum: ['Interested', 'Not interested', 'Question', 'Wants a meeting', 'Unsubscribe', 'Out of office'],
      required: true,
    },
    classificationReason: { type: String, required: false },
    isSimulated: { type: Boolean, default: false },
    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

ReplySchema.index({ candidateId: 1, receivedAt: -1 });
ReplySchema.index({ jobId: 1, replyClass: 1 });

export const Reply = mongoose.model<IReply>('Reply', ReplySchema);

