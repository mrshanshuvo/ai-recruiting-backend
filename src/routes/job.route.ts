import { Router, Request, Response } from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import { JobService } from '../services/job.service';
import { CandidateService } from '../services/candidate.service';

const upload = multer({
  limits: { fileSize: 1024 * 1024 }, // 1MB max limit per DEC-09
});

export const jobRouter = Router();

jobRouter.get('/jobs', async (req: Request, res: Response) => {
  try {
    const { status } = req.query;
    const jobs = await JobService.listJobs(status as string | undefined);
    res.status(200).json({ success: true, jobs });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to list jobs' },
    });
  }
});

jobRouter.get('/jobs/:id', async (req: Request, res: Response) => {
  try {
    const job = await JobService.getJobById(req.params.id);
    if (!job) {
      res.status(404).json({
        success: false,
        error: { code: 'ENTITY_NOT_FOUND', message: 'Job not found' },
      });
      return;
    }
    res.status(200).json({ success: true, job });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch job' },
    });
  }
});

// List candidates for a specific job with optional scoreTier and sourceMode filtering
jobRouter.get('/jobs/:id/candidates', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid jobId format' },
      });
      return;
    }

    const { scoreTier, sourceMode, search } = req.query;
    const candidates = await CandidateService.listCandidatesForJob(id, {
      scoreTier: scoreTier as any,
      sourceMode: sourceMode as any,
      search: search as string,
    });

    res.status(200).json({ success: true, count: candidates.length, candidates });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: error.message || 'Failed to list candidates' },
    });
  }
});

// Bulk upload candidates CSV for a specific job per Decision DEC-09
jobRouter.post(
  '/jobs/:id/candidates/upload-csv',
  upload.single('file'),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid jobId format' },
        });
        return;
      }

      if (!req.file) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_FILE', message: 'No CSV file provided in multipart "file" field.' },
        });
        return;
      }

      const conversationId = (req.body?.conversationId || req.query?.conversationId) as string | undefined;

      const result = await CandidateService.processCsvUpload(
        id,
        req.file.buffer,
        req.file.originalname,
        conversationId
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      const statusCode = error.message.includes('Invalid CSV headers') || error.message.includes('exceeds maximum limit')
        ? 400
        : 500;

      res.status(statusCode).json({
        success: false,
        error: {
          code: statusCode === 400 ? 'INVALID_CSV' : 'INTERNAL_SERVER_ERROR',
          message: error.message || 'Failed to process CSV upload',
        },
      });
    }
  }
);

