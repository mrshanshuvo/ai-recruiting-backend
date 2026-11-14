import mongoose from 'mongoose';
import { z } from 'zod';
import crypto from 'crypto';
import { Candidate, Job } from '../../models';
import { PendingActionService } from '../../services/pending-action.service';
import { env } from '../../config/env';

export const proposeBookingLinkInputSchema = z.object({
  candidateId: z.string().optional().describe('Candidate ID to send booking link to'),
  candidateName: z.string().optional().describe('Candidate full name to resolve candidateId'),
  jobId: z.string().optional().describe('Job ID if known'),
});
export const sendBookingLinkInputSchema = proposeBookingLinkInputSchema;

export async function executeProposeBookingLink(
  input: z.infer<typeof proposeBookingLinkInputSchema>,
  conversationId: string
) {
  let candidate = null;

  if (input.candidateId && mongoose.Types.ObjectId.isValid(input.candidateId)) {
    candidate = await Candidate.findById(input.candidateId);
  }

  if (!candidate && input.candidateName) {
    candidate = await Candidate.findOne({
      fullName: { $regex: new RegExp(`^${input.candidateName.trim()}$`, 'i') },
    });
    if (!candidate) {
      const partialMatches = await Candidate.find({
        fullName: { $regex: new RegExp(input.candidateName.trim(), 'i') },
      });
      if (partialMatches.length === 1) {
        candidate = partialMatches[0];
      }
    }
  }

  if (!candidate) {
    // Pick the most recent Interested candidate
    candidate = await Candidate.findOne({ status: 'Interested' }).sort({ updatedAt: -1 });
  }

  if (!candidate) {
    return {
      success: false,
      error: 'Could not find candidate to propose a booking link for.',
    };
  }

  const job = await Job.findById(candidate.jobId).lean();
  const jobTitle = job?.title || 'Engineering Role';

  if (!candidate.bookingToken) {
    candidate.bookingToken = crypto.randomBytes(24).toString('hex');
    await candidate.save();
  }

  const bookingUrl = `${env.PUBLIC_FRONTEND_URL}/mock-booking/${candidate.bookingToken}`;

  const pendingAction = await PendingActionService.createAction({
    conversationId,
    actionType: 'SEND_BOOKING_LINK',
    payload: {
      replyClass: 'Wants a meeting',
      candidateId: candidate._id.toString(),
      candidateName: candidate.fullName,
      candidateEmail: candidate.email,
      jobId: candidate.jobId.toString(),
      jobTitle,
      bookingToken: candidate.bookingToken,
      bookingUrl,
    },
  });

  return {
    success: true,
    message: `I prepared this, please confirm. I created a proposal to send an introductory meeting booking link to ${candidate.fullName} for "${jobTitle}".`,
    card: {
      cardType: 'booking_link',
      actionId: pendingAction._id.toString(),
      status: 'pending',
      payload: {
        replyClass: 'Wants a meeting',
        candidateId: candidate._id.toString(),
        candidateName: candidate.fullName,
        candidateEmail: candidate.email,
        jobId: candidate.jobId.toString(),
        jobTitle,
        bookingToken: candidate.bookingToken,
        bookingUrl,
      },
    },
  };
}

export const executeSendBookingLink = executeProposeBookingLink;

