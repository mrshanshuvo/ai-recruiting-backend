import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Candidate, Job, ActivityLog } from '../models';

export const bookingRouter = Router();

const selectSlotSchema = z.object({
  slot: z.string().min(1, 'Meeting slot selection is required'),
});

// GET /api/booking/:token
bookingRouter.get('/booking/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    if (!token) {
      res.status(400).json({ success: false, error: 'Token is required' });
      return;
    }

    const candidate = await Candidate.findOne({ bookingToken: token });
    if (!candidate) {
      res.status(404).json({
        success: false,
        error: {
          code: 'BOOKING_TOKEN_NOT_FOUND',
          message: 'Invalid or expired meeting booking link.',
        },
      });
      return;
    }

    const job = await Job.findById(candidate.jobId).lean();

    // Generate mock upcoming slots
    const now = new Date();
    const day1 = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const day2 = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    const day3 = new Date(now.getTime() + 72 * 60 * 60 * 1000);

    const formatDate = (d: Date, timeStr: string) => {
      const datePart = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      return `${datePart} at ${timeStr} (UTC)`;
    };

    const slots = [
      formatDate(day1, '10:00 AM'),
      formatDate(day1, '02:00 PM'),
      formatDate(day2, '11:00 AM'),
      formatDate(day2, '03:30 PM'),
      formatDate(day3, '01:00 PM'),
    ];

    res.status(200).json({
      success: true,
      candidate: {
        id: candidate._id.toString(),
        fullName: candidate.fullName,
        email: candidate.email,
        currentTitle: candidate.currentTitle,
      },
      job: {
        id: job?._id.toString(),
        title: job?.title || 'Staff Distributed Systems Engineer',
        company: 'Aironauts Technologies',
        seniority: job?.seniority,
        location: job?.location,
      },
      currentSlot: candidate.meetingSlot || null,
      availableSlots: slots,
    });
  } catch (error: any) {
    console.error('[BookingRouter.get]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/booking/:token/slot
bookingRouter.post('/booking/:token/slot', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const parseResult = selectSlotSchema.safeParse(req.body);
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

    const { slot } = parseResult.data;

    const candidate = await Candidate.findOne({ bookingToken: token });
    if (!candidate) {
      res.status(404).json({
        success: false,
        error: {
          code: 'BOOKING_TOKEN_NOT_FOUND',
          message: 'Invalid or expired meeting booking link.',
        },
      });
      return;
    }

    // Save chosen slot
    candidate.meetingSlot = slot;
    await candidate.save();

    // Log ActivityLog entry per ADR-0010 & DEC-02
    await ActivityLog.create({
      jobId: candidate.jobId,
      candidateId: candidate._id,
      actor: 'system',
      action: 'candidate_selected_slot',
      previousStatus: candidate.status,
      newStatus: candidate.status,
      details: {
        slot,
        bookingToken: token,
      },
      timestamp: new Date(),
    });

    res.status(200).json({
      success: true,
      candidateId: candidate._id.toString(),
      fullName: candidate.fullName,
      meetingSlot: slot,
      message: `Meeting successfully scheduled for ${slot}!`,
    });
  } catch (error: any) {
    console.error('[BookingRouter.selectSlot]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
