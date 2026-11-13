import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Candidate, Job, Reply } from '../models';
import { replyProcessingQueue } from '../queues';
import { processReplyJob } from '../workers/reply.worker';

export const replyRouter = Router();

const simulateReplySchema = z.object({
  candidateId: z.string(),
  emailText: z.string().optional(),
  message: z.string().optional(),
  sentiment: z.string().optional(),
  conversationId: z.string().optional(),
  sync: z.boolean().optional(),
});

async function handleSimulateReply(req: Request, res: Response) {
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

    const { candidateId, sentiment, conversationId, sync } = parseResult.data;
    const emailText = parseResult.data.emailText || parseResult.data.message || 'I am interested in this role and would love to learn more.';

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

    // If sync requested (e.g. from tests or fast verification)
    if (sync || req.query.sync === 'true') {
      const result = await processReplyJob({
        candidateId,
        emailText,
        sentiment,
        conversationId,
        isSimulated: true,
      });

      res.status(200).json({
        success: true,
        replyId: result.replyId,
        candidateId: result.candidateId,
        replyClass: result.replyClass,
        newStatus: result.newStatus,
      });
      return;
    }

    // Otherwise enqueue job to BullMQ reply-processing-queue
    const job = await replyProcessingQueue.add('process-reply', {
      candidateId,
      emailText,
      sentiment,
      conversationId,
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

// Support both POST /api/replies/simulate and POST /simulate-reply (DEC-15)
replyRouter.post('/replies/simulate', handleSimulateReply);
replyRouter.post('/simulate-reply', handleSimulateReply);

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
