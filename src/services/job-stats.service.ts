import mongoose, { Types } from 'mongoose';
import {
  Job,
  Candidate,
  Reply,
  Campaign,
  OutreachMessage,
  ActivityLog,
  TokenUsage,
  Conversation,
} from '../models';
import { calculateEstimatedCostUsd } from '../config/pricing.config';

export const ALL_PIPELINE_STATUSES = [
  'Sourced',
  'Accepted',
  'Rejected',
  'Contacted',
  'Replied',
  'Interested',
  'Not interested',
  'Unsubscribed',
  'Meeting booked',
  'Interviewed',
  'Shortlisted',
  'Hired',
] as const;

export interface JobStatsResponse {
  jobId: string;
  jobTitle: string;
  totals: {
    totalCandidates: number;
    contacted: number;
    replied: number;
    interested: number;
    meetings: number;
    hires: number;
  };
  rates: {
    replyRate: number | string;
    replyRateFormatted: string;
    interestedRate: number | string;
    interestedRateFormatted: string;
  };
  funnel: Record<string, number>;
  sourceBreakdown: {
    fixture: number;
    csv: number;
    serper: number;
  };
  campaignSummary: {
    campaignsCount: number;
    sentMessages: number;
    queuedMessages: number;
    cancelledMessages: number;
    isPaused: boolean;
  };
  tokenUsage: {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    totalEstimatedCostUsd: number;
    byCaller: Record<
      string,
      {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        estimatedCostUsd: number;
      }
    >;
  };
}

export class JobStatsService {
  /**
   * Resolves a job identifier by either exact ObjectId string or job title string.
   * If searching by title:
   *  1. Exact case-insensitive match first.
   *  2. If single exact match found, returns it.
   *  3. If partial match, only accepts if exactly one job matches; otherwise throws ambiguous error.
   */
  public static async resolveJob(jobIdOrTitle: string): Promise<any> {
    if (mongoose.Types.ObjectId.isValid(jobIdOrTitle)) {
      const job = await Job.findById(jobIdOrTitle).lean();
      if (job) return job;
    }

    const trimmed = jobIdOrTitle.trim();
    // 1. Exact case-insensitive title match
    const exactMatches = await Job.find({
      title: { $regex: new RegExp(`^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    }).lean();

    if (exactMatches.length === 1) {
      return exactMatches[0];
    }
    if (exactMatches.length > 1) {
      throw new Error(
        `Ambiguous job title "${jobIdOrTitle}". Found ${exactMatches.length} matching jobs. Please specify the exact Job ID.`
      );
    }

    // 2. Partial match fallback
    const partialMatches = await Job.find({
      title: { $regex: new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
    }).lean();

    if (partialMatches.length === 1) {
      return partialMatches[0];
    }
    if (partialMatches.length > 1) {
      const names = partialMatches.map((j) => `"${j.title}" (ID: ${j._id})`).join(', ');
      throw new Error(
        `Ambiguous job name "${jobIdOrTitle}" matched multiple jobs: [${names}]. Please specify the exact title or Job ID.`
      );
    }

    return null;
  }

  /**
   * Calculates comprehensive live recruiting metrics for a specific job.
   */
  public static async getJobStats(jobId: string | Types.ObjectId): Promise<JobStatsResponse> {
    const jobObjectId = typeof jobId === 'string' ? new Types.ObjectId(jobId) : jobId;
    const job = await Job.findById(jobObjectId).lean();

    if (!job) {
      throw new Error(`Job not found with ID ${jobObjectId.toString()}`);
    }

    // 1. Total Candidates and Status Funnel (all 12 statuses initialized to 0)
    const funnel: Record<string, number> = {};
    for (const status of ALL_PIPELINE_STATUSES) {
      funnel[status] = 0;
    }

    const statusCounts = await Candidate.aggregate([
      { $match: { jobId: jobObjectId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    let totalCandidates = 0;
    for (const item of statusCounts) {
      if (item._id && typeof funnel[item._id] === 'number') {
        funnel[item._id] = item.count;
      }
      totalCandidates += item.count;
    }

    // 2. Contacted Candidates Count
    // Candidates who have reached outreach (contactedAt != null or status reached/past Contacted)
    const contactedCount = await Candidate.countDocuments({
      jobId: jobObjectId,
      $or: [
        { contactedAt: { $exists: true, $ne: null } },
        {
          status: {
            $in: [
              'Contacted',
              'Replied',
              'Interested',
              'Not interested',
              'Unsubscribed',
              'Meeting booked',
              'Interviewed',
              'Shortlisted',
              'Hired',
            ],
          },
        },
      ],
    });

    // 3. Ever Replied Candidates (Resilient: includes candidates who later advanced to Hired or Unsubscribed)
    // Gather candidate IDs who sent a Reply, have an ActivityLog reply entry, or status past Contacted
    const replyCandidateIds = await Reply.distinct('candidateId', { jobId: jobObjectId });

    const activityReplyIds = await ActivityLog.distinct('candidateId', {
      jobId: jobObjectId,
      $or: [
        { action: 'candidate_status_changed', newStatus: 'Replied' },
        { action: 'candidate_status_changed', previousStatus: 'Replied' },
        { action: 'reply_received' },
      ],
    });

    const statusReplyCandidates = await Candidate.find({
      jobId: jobObjectId,
      status: {
        $in: [
          'Replied',
          'Interested',
          'Not interested',
          'Meeting booked',
          'Interviewed',
          'Shortlisted',
          'Hired',
        ],
      },
    }).select('_id').lean();

    const uniqueRepliedSet = new Set<string>();
    for (const id of replyCandidateIds) uniqueRepliedSet.add(id.toString());
    for (const id of activityReplyIds) if (id) uniqueRepliedSet.add(id.toString());
    for (const c of statusReplyCandidates) uniqueRepliedSet.add(c._id.toString());
    const repliedCount = uniqueRepliedSet.size;

    // 4. Ever Interested Candidates (Resilient: includes candidates who progressed to Hired or Unsubscribed)
    const interestedReplyIds = await Reply.distinct('candidateId', {
      jobId: jobObjectId,
      replyClass: { $in: ['Interested', 'Wants a meeting'] },
    });

    const activityInterestedIds = await ActivityLog.distinct('candidateId', {
      jobId: jobObjectId,
      $or: [
        { action: 'candidate_status_changed', newStatus: 'Interested' },
        { action: 'candidate_status_changed', newStatus: 'Meeting booked' },
      ],
    });

    const statusInterestedCandidates = await Candidate.find({
      jobId: jobObjectId,
      status: {
        $in: ['Interested', 'Meeting booked', 'Interviewed', 'Shortlisted', 'Hired'],
      },
    }).select('_id').lean();

    const uniqueInterestedSet = new Set<string>();
    for (const id of interestedReplyIds) uniqueInterestedSet.add(id.toString());
    for (const id of activityInterestedIds) if (id) uniqueInterestedSet.add(id.toString());
    for (const c of statusInterestedCandidates) uniqueInterestedSet.add(c._id.toString());
    const interestedCount = uniqueInterestedSet.size;

    // 5. Ever Booked Meeting Candidates
    const meetingActivityIds = await ActivityLog.distinct('candidateId', {
      jobId: jobObjectId,
      $or: [
        { action: 'candidate_status_changed', newStatus: 'Meeting booked' },
        { action: 'candidate_selected_slot' },
      ],
    });

    const statusMeetingCandidates = await Candidate.find({
      jobId: jobObjectId,
      $or: [
        { status: { $in: ['Meeting booked', 'Interviewed', 'Shortlisted', 'Hired'] } },
        { meetingSlot: { $exists: true, $ne: null } },
      ],
    }).select('_id').lean();

    const uniqueMeetingsSet = new Set<string>();
    for (const id of meetingActivityIds) if (id) uniqueMeetingsSet.add(id.toString());
    for (const c of statusMeetingCandidates) uniqueMeetingsSet.add(c._id.toString());
    const meetingsCount = uniqueMeetingsSet.size;

    // 6. Current Hires Count
    const hiresCount = funnel['Hired'] || 0;

    // 7. Rate Calculations (Safe edge-case handling when contacted === 0)
    let replyRate: number | string = 'n/a';
    let replyRateFormatted = 'n/a';
    let interestedRate: number | string = 'n/a';
    let interestedRateFormatted = 'n/a';

    if (contactedCount > 0) {
      const calcReply = Math.min(1, repliedCount / contactedCount);
      replyRate = Number(calcReply.toFixed(4));
      replyRateFormatted = `${(calcReply * 100).toFixed(1)}%`;

      const calcInterested = Math.min(1, interestedCount / contactedCount);
      interestedRate = Number(calcInterested.toFixed(4));
      interestedRateFormatted = `${(calcInterested * 100).toFixed(1)}%`;
    }

    // 8. Source Mode Breakdown
    const sourceCounts = await Candidate.aggregate([
      { $match: { jobId: jobObjectId } },
      { $group: { _id: '$sourceMode', count: { $sum: 1 } } },
    ]);

    const sourceBreakdown = {
      fixture: 0,
      csv: 0,
      serper: 0,
    };
    for (const s of sourceCounts) {
      if (s._id === 'fixture') sourceBreakdown.fixture = s.count;
      else if (s._id === 'csv') sourceBreakdown.csv = s.count;
      else if (s._id === 'serper') sourceBreakdown.serper = s.count;
    }

    // 9. Campaign Summary
    const campaigns = await Campaign.find({ jobId: jobObjectId }).lean();
    const campaignsCount = campaigns.length;
    const isPaused = campaigns.some((c) => c.status === 'PAUSED');

    const sentMessages = await OutreachMessage.countDocuments({
      jobId: jobObjectId,
      status: 'SENT',
    });
    const queuedMessages = await OutreachMessage.countDocuments({
      jobId: jobObjectId,
      status: 'QUEUED',
    });
    const cancelledMessages = await OutreachMessage.countDocuments({
      jobId: jobObjectId,
      status: 'CANCELLED',
    });

    // 10. Token Usage & Estimated Cost
    // Find matching usages by jobId OR conversationId (if job has linked conversation)
    const tokenQuery: any = {
      $or: [{ jobId: jobObjectId }],
    };
    if (job.conversationId) {
      tokenQuery.$or.push({ conversationId: job.conversationId });
    } else {
      const linkedConv = await Conversation.findOne({ jobId: jobObjectId }).lean();
      if (linkedConv) {
        tokenQuery.$or.push({ conversationId: linkedConv._id });
      }
    }

    const tokenUsages = await TokenUsage.find(tokenQuery).lean();

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalTokens = 0;
    let totalEstimatedCostUsd = 0;
    const byCaller: Record<
      string,
      {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        estimatedCostUsd: number;
      }
    > = {};

    for (const tu of tokenUsages) {
      const caller = tu.caller || 'agent';
      if (!byCaller[caller]) {
        byCaller[caller] = {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0,
        };
      }

      const p = tu.promptTokens || 0;
      const c = tu.completionTokens || 0;
      const t = tu.totalTokens || p + c;
      const cost = tu.estimatedCostUsd ?? calculateEstimatedCostUsd(tu.model || 'gemini-3.1-flash-lite', p, c);

      totalPromptTokens += p;
      totalCompletionTokens += c;
      totalTokens += t;
      totalEstimatedCostUsd += cost;

      byCaller[caller].promptTokens += p;
      byCaller[caller].completionTokens += c;
      byCaller[caller].totalTokens += t;
      byCaller[caller].estimatedCostUsd += cost;
    }

    // Round estimated costs
    totalEstimatedCostUsd = Number(totalEstimatedCostUsd.toFixed(6));
    for (const k of Object.keys(byCaller)) {
      byCaller[k].estimatedCostUsd = Number(byCaller[k].estimatedCostUsd.toFixed(6));
    }

    return {
      jobId: jobObjectId.toString(),
      jobTitle: job.title,
      totals: {
        totalCandidates,
        contacted: contactedCount,
        replied: repliedCount,
        interested: interestedCount,
        meetings: meetingsCount,
        hires: hiresCount,
      },
      rates: {
        replyRate,
        replyRateFormatted,
        interestedRate,
        interestedRateFormatted,
      },
      funnel,
      sourceBreakdown,
      campaignSummary: {
        campaignsCount,
        sentMessages,
        queuedMessages,
        cancelledMessages,
        isPaused,
      },
      tokenUsage: {
        totalPromptTokens,
        totalCompletionTokens,
        totalTokens,
        totalEstimatedCostUsd,
        byCaller,
      },
    };
  }
}
