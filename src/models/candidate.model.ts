import mongoose, { Schema, Document, Types } from 'mongoose';

export type CandidateStatus =
  | 'Sourced'
  | 'Accepted'
  | 'Rejected'
  | 'Contacted'
  | 'Replied'
  | 'Interested'
  | 'Not interested'
  | 'Meeting booked'
  | 'Interviewed'
  | 'Shortlisted'
  | 'Hired'
  | 'Unsubscribed';

export type CandidateSource = 'search' | 'csv';
export type ScoreStatus = 'pending' | 'scored' | 'failed';

export interface ICandidate extends Document {
  _id: Types.ObjectId;
  jobId: Types.ObjectId;
  fullName: string;
  email?: string;
  normalizedEmail?: string;
  profileUrl?: string;
  normalizedProfileUrl?: string;
  source: CandidateSource;
  currentTitle?: string;
  currentCompany?: string;
  skills: string[];
  score: number | null;
  scoreStatus: ScoreStatus;
  scoreReason?: string;
  scoreMissingInfo: string[];
  status: CandidateStatus;
  statusBeforeUnsubscribe: CandidateStatus | null;
  outreachStopped: boolean;
  contactedAt: Date | null;
  bookingToken: string | null;
  meetingSlot: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const CandidateSchema = new Schema<ICandidate>(
  {
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    fullName: { type: String, required: true },
    email: { type: String, required: false },
    normalizedEmail: { type: String, required: false },
    profileUrl: { type: String, required: false },
    normalizedProfileUrl: { type: String, required: false },
    source: { type: String, enum: ['search', 'csv'], required: true },
    currentTitle: { type: String, required: false },
    currentCompany: { type: String, required: false },
    skills: { type: [String], default: [] },
    score: { type: Number, default: null },
    scoreStatus: {
      type: String,
      enum: ['pending', 'scored', 'failed'],
      default: 'pending',
    },
    scoreReason: { type: String, required: false },
    scoreMissingInfo: { type: [String], default: [] },
    status: {
      type: String,
      enum: [
        'Sourced',
        'Accepted',
        'Rejected',
        'Contacted',
        'Replied',
        'Interested',
        'Not interested',
        'Meeting booked',
        'Interviewed',
        'Shortlisted',
        'Hired',
        'Unsubscribed',
      ],
      default: 'Sourced',
    },
    statusBeforeUnsubscribe: { type: String, default: null },
    outreachStopped: { type: Boolean, default: false },
    contactedAt: { type: Date, default: null },
    bookingToken: { type: String, default: null },
    meetingSlot: { type: String, default: null },
  },
  { timestamps: true }
);

// Deduplication and fast query indexes per ADR-0007 & ADR-0015
CandidateSchema.index({ jobId: 1, normalizedEmail: 1 }, { unique: true, sparse: true });
CandidateSchema.index({ jobId: 1, normalizedProfileUrl: 1 }, { unique: true, sparse: true });
CandidateSchema.index({ bookingToken: 1 }, { unique: true, sparse: true });
CandidateSchema.index({ jobId: 1, status: 1, score: -1 });

export const Candidate = mongoose.model<ICandidate>('Candidate', CandidateSchema);

