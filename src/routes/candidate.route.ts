import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { CandidateStatusService, InvalidStateTransitionError } from '../services/candidate-status.service';
import { Candidate, CandidateStatus, Reply } from '../models';
import { replyProcessingQueue } from '../queues';

export const candidateRouter = Router();

const updateStatusSchema = z.object({
  newStatus: z.enum([
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
  ]),
  reason: z.string().optional(),
});

// PATCH /api/candidates/:id/status
candidateRouter.patch('/candidates/:id/status', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid candidateId format',
        },
      });
      return;
    }

    const parseResult = updateStatusSchema.safeParse(req.body);
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

    const { newStatus, reason } = parseResult.data;

    const result = await CandidateStatusService.transition(
      id,
      newStatus as CandidateStatus,
      'recruiter',
      reason || 'Recruiter direct status change'
    );

    res.status(200).json({
      success: true,
      candidateId: result.candidateId,
      previousStatus: result.previousStatus,
      newStatus: result.newStatus,
      noOp: result.noOp,
    });
  } catch (error: any) {
    if (error instanceof InvalidStateTransitionError || error.code === 'INVALID_STATE_TRANSITION') {
      res.status(422).json({
        success: false,
        error: {
          code: 'INVALID_STATE_TRANSITION',
          message: error.message,
        },
      });
      return;
    }

    if (error.statusCode === 404 || error.code === 'CANDIDATE_NOT_FOUND') {
      res.status(404).json({
        success: false,
        error: {
          code: 'CANDIDATE_NOT_FOUND',
          message: error.message,
        },
      });
      return;
    }

    console.error('[CandidateRouter.updateStatus]', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: error.message || 'Failed to update candidate status',
      },
    });
  }
});

// POST /api/candidates/:id/retry-classification (A7)
candidateRouter.post('/candidates/:id/retry-classification', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid candidateId format' },
      });
      return;
    }

    const candidate = await Candidate.findById(id);
    if (!candidate) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Candidate not found' },
      });
      return;
    }

    const latestReply = await Reply.findOne({ candidateId: candidate._id }).sort({ createdAt: -1 });
    if (!latestReply) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'No reply records found for this candidate' },
      });
      return;
    }

    const job = await replyProcessingQueue.add('process-reply', {
      candidateId: candidate._id.toString(),
      emailText: latestReply.body,
      isSimulated: latestReply.isSimulated ?? true,
    });

    res.status(200).json({
      success: true,
      message: 'Reply classification successfully re-enqueued',
      jobId: job.id,
      candidateId: candidate._id.toString(),
    });
  } catch (error: any) {
    console.error('[CandidateRouter.retryClassification]', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: error.message || 'Failed to retry reply classification' },
    });
  }
});

