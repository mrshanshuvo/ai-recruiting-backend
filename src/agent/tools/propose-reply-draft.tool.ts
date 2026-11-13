import mongoose from 'mongoose';
import { z } from 'zod';
import { Candidate, Reply } from '../../models';
import { PendingActionService } from '../../services/pending-action.service';

export const proposeReplyDraftInputSchema = z.object({
  candidateId: z.string().describe('ID of the candidate to draft a response for'),
  replyId: z.string().optional().describe('ID of the inbound candidate reply being answered'),
  subject: z.string().optional().describe('Subject line of the email response'),
  draftedBody: z.string().describe('Body text of the drafted response'),
});

export async function executeProposeReplyDraft(
  input: z.infer<typeof proposeReplyDraftInputSchema>,
  conversationId: string
) {
  let candidate = null;
  if (input.candidateId && mongoose.Types.ObjectId.isValid(input.candidateId)) {
    candidate = await Candidate.findById(input.candidateId);
  }

  if (!candidate) {
    return {
      success: false,
      error: `Candidate "${input.candidateId}" not found to draft a reply for.`,
    };
  }

  let reply = null;
  if (input.replyId && mongoose.Types.ObjectId.isValid(input.replyId)) {
    reply = await Reply.findById(input.replyId);
  } else {
    reply = await Reply.findOne({ candidateId: candidate._id }).sort({ receivedAt: -1 });
  }

  const subject = input.subject || `Re: Outreach from Aironauts Technologies`;
  const replyClass = reply?.replyClass || 'Question';
  const candidateMessage = reply?.body || '';

  const pendingAction = await PendingActionService.createAction({
    conversationId,
    actionType: 'SEND_REPLY',
    payload: {
      candidateId: candidate._id.toString(),
      candidateName: candidate.fullName,
      candidateEmail: candidate.email,
      replyId: reply?._id.toString(),
      replyClass,
      candidateMessage,
      subject,
      body: input.draftedBody,
      draftedBody: input.draftedBody,
      jobId: candidate.jobId.toString(),
    },
  });

  return {
    success: true,
    message: `I prepared this reply draft for ${candidate.fullName}, please review and confirm.`,
    card: {
      cardType: 'reply_draft',
      actionId: pendingAction._id.toString(),
      status: 'pending',
      payload: {
        candidateId: candidate._id.toString(),
        candidateName: candidate.fullName,
        candidateEmail: candidate.email,
        replyId: reply?._id.toString(),
        replyClass,
        candidateMessage,
        subject,
        body: input.draftedBody,
        draftedBody: input.draftedBody,
      },
    },
  };
}
