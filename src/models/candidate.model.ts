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
export type SourceMode = 'serper' | 'fixture' | 'csv';
export type EmailStatus = 'valid' | 'missing';
export type ScoreStatus = 'pending' | 'scored' | 'failed';

export interface ICandidate extends Document {
  _id: Types.ObjectId;
  jobId: Types.ObjectId;
  jobIds?: Types.ObjectId[];
  fullName: string;
  email?: string;
  normalizedEmail?: string;
  emailStatus: EmailStatus;
  profileUrl?: string;
  normalizedProfileUrl?: string;
  source: CandidateSource;
  sourceMode: SourceMode;
  currentTitle?: string;
  currentCompany?: string;
  skills: string[];
  score: number | null;
  scoreStatus: ScoreStatus;
  scoreReason?: string;
  scoreMissingInfo: string[];
  missingInfo: string[];
  status: CandidateStatus;
  statusBeforeUnsubscribe?: CandidateStatus;
  outreachStopped: boolean;
  contactedAt?: Date;
  bookingToken?: string;
  meetingSlot?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CandidateSchema = new Schema<ICandidate>(
  {
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    jobIds: [{ type: Schema.Types.ObjectId, ref: 'Job' }],
    fullName: { type: String, required: true },
    email: { type: String, required: false },
    normalizedEmail: { type: String, required: false },
    emailStatus: { type: String, enum: ['valid', 'missing'], default: 'valid' },
    profileUrl: { type: String, required: false },
    normalizedProfileUrl: { type: String, required: false },
    source: { type: String, enum: ['search', 'csv'], default: 'search' },
    sourceMode: { type: String, enum: ['serper', 'fixture', 'csv'], default: 'fixture' },
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
    missingInfo: { type: [String], default: [] },
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
    statusBeforeUnsubscribe: { type: String, required: false },
    outreachStopped: { type: Boolean, default: false },
    contactedAt: { type: Date, required: false },
    bookingToken: { type: String, required: false },
    meetingSlot: { type: String, required: false },
  },
  { timestamps: true }
);

// Deduplication and fast query indexes per ADR-0007 & ADR-0015
CandidateSchema.index(
  { jobId: 1, normalizedEmail: 1 },
  { unique: true, partialFilterExpression: { normalizedEmail: { $type: 'string' } } }
);
CandidateSchema.index(
  { jobId: 1, normalizedProfileUrl: 1 },
  { unique: true, partialFilterExpression: { normalizedProfileUrl: { $type: 'string' } } }
);
CandidateSchema.index(
  { bookingToken: 1 },
  { unique: true, partialFilterExpression: { bookingToken: { $type: 'string' } } }
);
CandidateSchema.index({ jobId: 1, status: 1, score: -1 });

export const Candidate = mongoose.model<ICandidate>('Candidate', CandidateSchema);

