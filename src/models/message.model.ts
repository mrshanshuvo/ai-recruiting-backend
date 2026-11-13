import mongoose, { Schema, Document, Types } from 'mongoose';

export type MessageRole = 'user' | 'assistant' | 'system';
export type CardType =
  | 'job_confirmation'
  | 'sourcing_confirmation'
  | 'candidate_table'
  | 'campaign_preview'
  | 'reply_draft'
  | 'status_update'
  | 'booking_link'
  | 'stats_summary';

export type CardStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired';

export interface ICardPart {
  type: 'card';
  card: {
    cardType: CardType;
    actionId?: Types.ObjectId;
    status: CardStatus;
    payload: Record<string, unknown>;
  };
}

export interface ITextPart {
  type: 'text';
  text: string;
}

export type IMessagePart = ITextPart | ICardPart;

export interface IMessage extends Document {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  role: MessageRole;
  parts: IMessagePart[];
  createdAt: Date;
}

const MessagePartSchema = new Schema(
  {
    type: { type: String, enum: ['text', 'card'], required: true },
    text: { type: String, required: false },
    card: {
      type: new Schema(
        {
          cardType: {
            type: String,
            enum: [
              'job_confirmation',
              'sourcing_confirmation',
              'candidate_table',
              'campaign_preview',
              'reply_draft',
              'status_update',
              'booking_link',
              'stats_summary',
            ],
            required: true,
          },
          actionId: { type: Schema.Types.ObjectId, ref: 'PendingAction', required: false },
          status: {
            type: String,
            enum: ['pending', 'confirmed', 'cancelled', 'expired'],
            default: 'pending',
          },
          payload: { type: Schema.Types.Mixed, default: {} },
        },
        { _id: false }
      ),
      required: false,
    },
  },
  { _id: false }
);

const MessageSchema = new Schema<IMessage>(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
    parts: { type: [MessagePartSchema], required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

MessageSchema.index({ conversationId: 1, createdAt: 1 });

export const Message = mongoose.model<IMessage>('Message', MessageSchema);

