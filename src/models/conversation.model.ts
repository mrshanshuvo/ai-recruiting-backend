import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IConversation extends Document {
  _id: Types.ObjectId;
  jobId?: Types.ObjectId;
  title?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ConversationSchema = new Schema<IConversation>(
  {
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: false },
    title: { type: String, default: 'New Conversation' },
  },
  { timestamps: true }
);

ConversationSchema.index({ jobId: 1 });

export const Conversation = mongoose.model<IConversation>('Conversation', ConversationSchema);

