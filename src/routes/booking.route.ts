import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Candidate, Job, ActivityLog } from '../models';

export const bookingRouter = Router();

// Config constant: Next 5 business days at 10:00, 14:00 and 16:00 UTC (DEC-19)
export const BOOKING_SLOT_HOURS_UTC = ['10:00', '14:00', '16:00'] as const;
export const BOOKING_BUSINESS_DAYS_COUNT = 5;

export function generateUpcomingBusinessSlots(startDate: Date = new Date()): string[] {
  const slots: string[] = [];
  const cur = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));

  let businessDaysFound = 0;
  while (businessDaysFound < BOOKING_BUSINESS_DAYS_COUNT) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const dayOfWeek = cur.getUTCDay(); // 0 is Sunday, 6 is Saturday
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      businessDaysFound++;
      const weekday = cur.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
      const month = cur.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
      const day = cur.getUTCDate();
      const year = cur.getUTCFullYear();

      for (const timeStr of BOOKING_SLOT_HOURS_UTC) {
        slots.push(`${weekday}, ${month} ${day}, ${year} at ${timeStr} UTC`);
      }
    }
  }
  return slots;
}

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

    // Generate upcoming slots dynamically from current date at request time
    const slots = generateUpcomingBusinessSlots(new Date());

    // Save offered slots on the candidate record
    candidate.offeredSlots = slots;
    await candidate.save();

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

    // DEC-19 / A2: Validate that chosen slot is among the offered slots
    const offered = candidate.offeredSlots || [];
    if (offered.length > 0 && !offered.includes(slot)) {
      res.status(422).json({
        success: false,
        error: {
          code: 'INVALID_SLOT_SELECTION',
          message: `The slot "${slot}" was not offered. Please select one of the offered business slots.`,
          offeredSlots: offered,
        },
      });
      return;
    }

    const previousSlot = candidate.meetingSlot;

    // Save chosen slot (second selection cleanly replaces first)
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
        replacedPreviousSlot: previousSlot || null,
      },
      timestamp: new Date(),
    });

    res.status(200).json({
      success: true,
      candidateId: candidate._id.toString(),
      fullName: candidate.fullName,
      meetingSlot: slot,
      replacedPreviousSlot: previousSlot || null,
      message: `Meeting successfully scheduled for ${slot}!`,
    });
  } catch (error: any) {
    console.error('[BookingRouter.selectSlot]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

