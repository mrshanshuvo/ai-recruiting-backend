import { Router, Request, Response } from 'express';
import { JobService } from '../services/job.service';

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

