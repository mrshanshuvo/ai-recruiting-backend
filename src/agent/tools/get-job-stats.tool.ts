import { z } from 'zod';
import mongoose from 'mongoose';
import { Conversation, Job } from '../../models';
import { JobStatsService } from '../../services/job-stats.service';

export const getJobStatsInputSchema = z.object({
  jobId: z
    .string()
    .optional()
    .describe('Job ID to fetch statistics for. If omitted, resolved from conversation context or jobTitle.'),
  jobTitle: z
    .string()
    .optional()
    .describe('Job title to search for (e.g. "Senior Frontend Engineer", "React"). Matches exact title first, rejects ambiguous partials.'),
});

export async function executeGetJobStats(
  input: z.infer<typeof getJobStatsInputSchema>,
  conversationId?: string
) {
  try {
    let targetJob = null;

    if (input.jobId) {
      targetJob = await JobStatsService.resolveJob(input.jobId);
    } else if (input.jobTitle) {
      targetJob = await JobStatsService.resolveJob(input.jobTitle);
    } else if (conversationId && mongoose.Types.ObjectId.isValid(conversationId)) {
      const conv = await Conversation.findById(conversationId).lean();
      if (conv?.jobId) {
        targetJob = await Job.findById(conv.jobId).lean();
      }
    }

    if (!targetJob) {
      // Fallback to latest job if only one exists or pick latest
      targetJob = await Job.findOne().sort({ createdAt: -1 }).lean();
    }

    if (!targetJob) {
      return {
        success: false,
        error: 'No active job found to report statistics for.',
      };
    }

    const stats = await JobStatsService.getJobStats(targetJob._id);

    return {
      success: true,
      jobId: stats.jobId,
      jobTitle: stats.jobTitle,
      stats,
      card: {
        cardType: 'stats_summary',
        payload: {
          jobId: stats.jobId,
          jobTitle: stats.jobTitle,
          everReached: stats.everReached,
          rates: stats.rates,
          currentStatusCounts: stats.currentStatusCounts,
          sourceBreakdown: stats.sourceBreakdown,
          campaignSummary: stats.campaignSummary,
          tokenUsage: stats.tokenUsage,
        },
      },
      message: `Here is the current recruiting status for "${stats.jobTitle}": ${stats.everReached.totalCandidates} candidates sourced, ${stats.everReached.contacted} contacted, ${stats.everReached.replied} replied (${stats.rates.replyRateFormatted}), ${stats.everReached.interested} interested (${stats.rates.interestedRateFormatted}), ${stats.everReached.meetings} meetings booked, and ${stats.everReached.hires} hires.`,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Failed to retrieve job statistics',
    };
  }
}

