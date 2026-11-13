import mongoose from 'mongoose';
import { Candidate, CandidateStatus, ActivityLog, ActivityActor, Job } from '../models';

export class InvalidStateTransitionError extends Error {
  public statusCode: number = 422;
  public code: string = 'INVALID_STATE_TRANSITION';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateTransitionError';
  }
}

export const ALLOWED_TRANSITIONS: Record<CandidateStatus, CandidateStatus[]> = {
  Sourced: ['Accepted', 'Rejected'],
  Accepted: ['Contacted', 'Rejected'],
  Contacted: ['Replied', 'Unsubscribed'],
  Replied: ['Interested', 'Not interested', 'Meeting booked', 'Replied', 'Unsubscribed'],
  Interested: ['Meeting booked', 'Rejected', 'Unsubscribed'],
  'Not interested': ['Rejected', 'Unsubscribed'],
  'Meeting booked': ['Interviewed', 'Rejected', 'Unsubscribed'],
  Interviewed: ['Shortlisted', 'Rejected', 'Unsubscribed'],
  Shortlisted: ['Hired', 'Rejected', 'Unsubscribed'],
  Hired: ['Unsubscribed'],
  Rejected: ['Unsubscribed'], // Allowed if contactedAt != null per DEC-13
  Unsubscribed: ['Unsubscribed'], // Clean no-op per DEC-13
};

export class CandidateStatusService {
  /**
   * Authoritative method to transition a candidate from their current status to newStatus.
   * Enforces status-state-machine.md rules, DEC-13 unsubscribe rules, and logs every change to ActivityLog.
   */
  public static async transition(
    candidateId: string | mongoose.Types.ObjectId,
    newStatus: CandidateStatus,
    actor: ActivityActor = 'recruiter',
    reason?: string
  ): Promise<{
    success: boolean;
    candidateId: string;
    previousStatus: CandidateStatus;
    newStatus: CandidateStatus;
    noOp?: boolean;
  }> {
    const candidate = await Candidate.findById(candidateId);
    if (!candidate) {
      const err = new Error(`Candidate with id ${candidateId} not found`);
      (err as any).statusCode = 404;
      (err as any).code = 'CANDIDATE_NOT_FOUND';
      throw err;
    }

    const currentStatus = candidate.status;

    // 1. DEC-13: Unsubscribing an already Unsubscribed candidate is a clean no-op
    if (newStatus === 'Unsubscribed' && currentStatus === 'Unsubscribed') {
      return {
        success: true,
        candidateId: candidate._id.toString(),
        previousStatus: currentStatus,
        newStatus: currentStatus,
        noOp: true,
      };
    }

    // 2. Unsubscribe Protocol & DEC-13 validation
    if (newStatus === 'Unsubscribed') {
      // Allowed from any status once contacted: Contacted, Replied, Interested, Not interested,
      // Meeting booked, Interviewed, Shortlisted, Hired, and Rejected (if contactedAt != null)
      const allowedFromContacted = [
        'Contacted',
        'Replied',
        'Interested',
        'Not interested',
        'Meeting booked',
        'Interviewed',
        'Shortlisted',
        'Hired',
      ];

      const isEligible =
        allowedFromContacted.includes(currentStatus) ||
        (currentStatus === 'Rejected' && Boolean(candidate.contactedAt));

      if (!isEligible) {
        throw new InvalidStateTransitionError(
          `Cannot transition candidate from '${currentStatus}' to 'Unsubscribed' because candidate has not been contacted`
        );
      }

      // Preserve statusBeforeUnsubscribe before mutating
      candidate.statusBeforeUnsubscribe = currentStatus;
      candidate.status = 'Unsubscribed';
      candidate.outreachStopped = true;

      await candidate.save();

      // Write immutable ActivityLog entry
      await ActivityLog.create({
        jobId: candidate.jobId,
        candidateId: candidate._id,
        actor,
        action: 'candidate_unsubscribed',
        previousStatus: currentStatus,
        newStatus: 'Unsubscribed',
        details: { reason: reason || 'Candidate unsubscribed / opted out' },
        timestamp: new Date(),
      });

      // Update Job candidateCounts if job exists
      await this.updateJobCounts(candidate.jobId, currentStatus, 'Unsubscribed');

      return {
        success: true,
        candidateId: candidate._id.toString(),
        previousStatus: currentStatus,
        newStatus: 'Unsubscribed',
      };
    }

    // 3. Standard state machine guard checks
    const allowedTargets = ALLOWED_TRANSITIONS[currentStatus] || [];
    if (!allowedTargets.includes(newStatus)) {
      throw new InvalidStateTransitionError(
        `Cannot transition candidate from '${currentStatus}' to '${newStatus}'`
      );
    }

    // 4. Outreach Prerequisite Guard: Only Accepted with valid email can move to Contacted
    if (newStatus === 'Contacted') {
      if (candidate.emailStatus === 'missing' || !candidate.email) {
        throw new InvalidStateTransitionError(
          `Cannot transition candidate without valid email to 'Contacted'`
        );
      }
      if (!candidate.contactedAt) {
        candidate.contactedAt = new Date();
      }
    }

    // 5. Update candidate status
    candidate.status = newStatus;
    await candidate.save();

    // 6. Write ActivityLog entry
    await ActivityLog.create({
      jobId: candidate.jobId,
      candidateId: candidate._id,
      actor,
      action: 'candidate_status_changed',
      previousStatus: currentStatus,
      newStatus,
      details: { reason: reason || `Status changed from ${currentStatus} to ${newStatus}` },
      timestamp: new Date(),
    });

    // 7. Update Job candidateCounts
    await this.updateJobCounts(candidate.jobId, currentStatus, newStatus);

    return {
      success: true,
      candidateId: candidate._id.toString(),
      previousStatus: currentStatus,
      newStatus,
    };
  }

  /**
   * Bulk transition multiple candidates. Executes each transition atomically.
   */
  public static async bulkTransition(
    candidateIds: string[] | mongoose.Types.ObjectId[],
    newStatus: CandidateStatus,
    actor: ActivityActor = 'agent',
    reason?: string
  ): Promise<{
    success: boolean;
    updatedCount: number;
    results: Array<{ candidateId: string; success: boolean; error?: string }>;
  }> {
    const results: Array<{ candidateId: string; success: boolean; error?: string }> = [];
    let updatedCount = 0;

    for (const cid of candidateIds) {
      const cidStr = cid.toString();
      try {
        await this.transition(cid, newStatus, actor, reason);
        results.push({ candidateId: cidStr, success: true });
        updatedCount++;
      } catch (err: any) {
        results.push({
          candidateId: cidStr,
          success: false,
          error: err.message || 'Transition error',
        });
      }
    }

    return {
      success: updatedCount > 0,
      updatedCount,
      results,
    };
  }

  /**
   * Helper to keep Job.candidateCounts in sync
   */
  private static async updateJobCounts(
    jobId: mongoose.Types.ObjectId,
    prevStatus: CandidateStatus,
    newStatus: CandidateStatus
  ): Promise<void> {
    try {
      const incUpdate: Record<string, number> = {};
      incUpdate[`candidateCounts.${prevStatus}`] = -1;
      incUpdate[`candidateCounts.${newStatus}`] = 1;

      await Job.updateOne({ _id: jobId }, { $inc: incUpdate });
    } catch (e) {
      console.warn(`[CandidateStatusService] Failed to update candidateCounts for job ${jobId}:`, e);
    }
  }
}
