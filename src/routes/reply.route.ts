import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Candidate, Job, Reply, OutreachMessage } from '../models';
import { replyProcessingQueue } from '../queues';
import { processReplyJob } from '../workers/reply.worker';

export const replyRouter = Router();

const simulateReplySchema = z
  .object({
    candidateId: z.string().min(1, 'candidateId is required'),
    message: z.string().optional(),
    emailText: z.string().optional(),
  })
  .refine((data) => Boolean(data.message?.trim() || data.emailText?.trim()), {
    message: 'message is required in request body',
    path: ['message'],
  });

export async function handleSimulateReply(req: Request, res: Response) {
  try {
    const parseResult = simulateReplySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parseResult.error.errors.map((e) => e.message).join(', '),
        },
      });
      return;
    }

    const { candidateId } = parseResult.data;
    const message = (parseResult.data.message || parseResult.data.emailText)!.trim();

    if (!mongoose.Types.ObjectId.isValid(candidateId)) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid candidateId format',
        },
      });
      return;
    }

    const candidate = await Candidate.findById(candidateId);
    if (!candidate) {
      res.status(404).json({
        success: false,
        error: {
          code: 'CANDIDATE_NOT_FOUND',
          message: `Candidate with id ${candidateId} not found`,
        },
      });
      return;
    }

    // Sequence halting: set outreachStopped = true immediately per ADR-0009
    candidate.outreachStopped = true;
    await candidate.save();

    // Mark all unsent outreach messages for this candidate as CANCELLED with reason replied
    await OutreachMessage.updateMany(
      { candidateId: candidate._id, status: 'QUEUED' },
      {
        $set: {
          status: 'CANCELLED',
          cancellationReason: 'replied',
          errorMessage: 'Outreach cancelled due to candidate reply',
        },
      }
    );

    // Enqueue job to BullMQ reply-processing-queue (real queue, no sync flag)
    const job = await replyProcessingQueue.add('process-reply', {
      candidateId,
      emailText: message,
      isSimulated: true,
    });

    res.status(200).json({
      success: true,
      jobId: job.id,
      candidateId,
      message: 'Inbound reply enqueued for processing and campaign follow-ups halted.',
    });
  } catch (error: any) {
    console.error('[ReplyRouter.simulateReply]', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: error.message || 'Failed to simulate candidate reply',
      },
    });
  }
}

// GET /api/replies?jobId=... or ?candidateId=...
replyRouter.get('/replies', async (req: Request, res: Response) => {
  try {
    const { candidateId, jobId } = req.query;
    const filter: Record<string, any> = {};

    if (candidateId && mongoose.Types.ObjectId.isValid(candidateId as string)) {
      filter.candidateId = new mongoose.Types.ObjectId(candidateId as string);
    }
    if (jobId && mongoose.Types.ObjectId.isValid(jobId as string)) {
      filter.jobId = new mongoose.Types.ObjectId(jobId as string);
    }

    const replies = await Reply.find(filter).sort({ receivedAt: -1 }).lean();
    res.status(200).json({ success: true, replies });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

