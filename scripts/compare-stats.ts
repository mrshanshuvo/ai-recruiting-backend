import mongoose, { Types } from 'mongoose';
import { env } from '../src/config/env';
import { Job, Candidate, Reply, ActivityLog, OutreachMessage, TokenUsage } from '../src/models';
import { ALL_PIPELINE_STATUSES } from '../src/services/job-stats.service';

const API_BASE = `http://localhost:${env.PORT || 4000}`;

interface ComparisonRow {
  metric: string;
  apiValue: number | string;
  mongoValue: number | string;
  match: 'MATCH' | 'MISMATCH';
}

async function main() {
  let targetJobId = process.argv[2];

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(env.MONGO_URI);
  }

  if (!targetJobId) {
    const latestJob = await Job.findOne().sort({ createdAt: -1 }).lean();
    if (!latestJob) {
      console.error('No jobs found in database.');
      process.exit(1);
    }
    targetJobId = latestJob._id.toString();
  }

  console.log(`\n================================================================================`);
  console.log(`Comparing Stats for Job ID: ${targetJobId}`);
  console.log(`================================================================================\n`);

  // 1. Fetch Stats from REST API
  const res = await fetch(`${API_BASE}/api/jobs/${targetJobId}/stats`);
  if (!res.ok) {
    console.error(`Failed to fetch stats from API: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const apiData = await res.json();
  const apiStats = apiData.stats;
  const everReached = apiStats.everReached || apiStats.totals;
  const currentStatusCounts = apiStats.currentStatusCounts || apiStats.funnel;

  const jobObjectId = new Types.ObjectId(targetJobId);
  const rows: ComparisonRow[] = [];

  // Helper to add row
  function addRow(metric: string, apiVal: number | string, mongoVal: number | string) {
    const isMatch = String(apiVal) === String(mongoVal);
    rows.push({
      metric,
      apiValue: apiVal,
      mongoValue: mongoVal,
      match: isMatch ? 'MATCH' : 'MISMATCH',
    });
  }

  // 2. Total Candidates
  const rawTotalCandidates = await Candidate.countDocuments({ jobId: jobObjectId });
  addRow('Total Candidates', everReached.totalCandidates, rawTotalCandidates);

  // 3. Status Funnel (all 12 statuses)
  for (const st of ALL_PIPELINE_STATUSES) {
    const rawCount = await Candidate.countDocuments({ jobId: jobObjectId, status: st });
    addRow(`Status: ${st}`, currentStatusCounts[st] ?? 0, rawCount);
  }

  // 4. Ever-Contacted Candidates
  const rawContacted = await Candidate.countDocuments({
    jobId: jobObjectId,
    $or: [
      { contactedAt: { $exists: true, $ne: null } },
      { status: { $nin: ['Sourced', 'Accepted', 'Rejected'] } },
    ],
  });
  addRow('Ever Contacted', everReached.contacted, rawContacted);

  // 5. Ever-Replied Candidates
  const repliedCandidateIds = await Reply.distinct('candidateId', { jobId: jobObjectId });
  const repliedActivityIds = await ActivityLog.distinct('candidateId', {
    jobId: jobObjectId,
    action: 'candidate_status_changed',
    newStatus: {
      $in: [
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
  });
  const statusRepliedCandidates = await Candidate.find({
    jobId: jobObjectId,
    status: {
      $in: [
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
  })
    .select('_id')
    .lean();

  const uniqueRepliedSet = new Set<string>();
  for (const id of repliedCandidateIds) uniqueRepliedSet.add(id.toString());
  for (const id of repliedActivityIds) if (id) uniqueRepliedSet.add(id.toString());
  for (const c of statusRepliedCandidates) uniqueRepliedSet.add(c._id.toString());
  addRow('Ever Replied', everReached.replied, uniqueRepliedSet.size);

  // 6. Ever-Interested Candidates
  const interestedReplyIds = await Reply.distinct('candidateId', {
    jobId: jobObjectId,
    replyClass: { $in: ['Interested', 'Wants a meeting'] },
  });
  const activityInterestedIds = await ActivityLog.distinct('candidateId', {
    jobId: jobObjectId,
    action: 'candidate_status_changed',
    newStatus: { $in: ['Interested', 'Meeting booked', 'Interviewed', 'Shortlisted', 'Hired'] },
  });
  const statusInterestedCandidates = await Candidate.find({
    jobId: jobObjectId,
    status: { $in: ['Interested', 'Meeting booked', 'Interviewed', 'Shortlisted', 'Hired'] },
  })
    .select('_id')
    .lean();

  const uniqueInterestedSet = new Set<string>();
  for (const id of interestedReplyIds) uniqueInterestedSet.add(id.toString());
  for (const id of activityInterestedIds) if (id) uniqueInterestedSet.add(id.toString());
  for (const c of statusInterestedCandidates) uniqueInterestedSet.add(c._id.toString());
  addRow('Ever Interested', everReached.interested, uniqueInterestedSet.size);

  // 7. Ever Booked Meeting Candidates
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
  })
    .select('_id')
    .lean();

  const uniqueMeetingsSet = new Set<string>();
  for (const id of meetingActivityIds) if (id) uniqueMeetingsSet.add(id.toString());
  for (const c of statusMeetingCandidates) uniqueMeetingsSet.add(c._id.toString());
  addRow('Ever Meetings', everReached.meetings, uniqueMeetingsSet.size);

  // 8. Hires
  const rawHires = await Candidate.countDocuments({ jobId: jobObjectId, status: 'Hired' });
  addRow('Hires', everReached.hires, rawHires);

  // 9. Outreach Messages Breakdown
  const rawSent = await OutreachMessage.countDocuments({ jobId: jobObjectId, status: 'SENT' });
  const rawQueued = await OutreachMessage.countDocuments({ jobId: jobObjectId, status: 'QUEUED' });
  const rawCancelled = await OutreachMessage.countDocuments({ jobId: jobObjectId, status: 'CANCELLED' });
  addRow('Outreach Sent', apiStats.campaignSummary.sentMessages, rawSent);
  addRow('Outreach Queued', apiStats.campaignSummary.queuedMessages, rawQueued);
  addRow('Outreach Cancelled', apiStats.campaignSummary.cancelledMessages, rawCancelled);

  // 10. Token Usage Sums
  const tokenAggr = await TokenUsage.aggregate([
    { $match: { jobId: jobObjectId } },
    {
      $group: {
        _id: null,
        totalPrompt: { $sum: '$promptTokens' },
        totalCompletion: { $sum: '$completionTokens' },
        totalTokens: { $sum: '$totalTokens' },
      },
    },
  ]);
  const rawTokens = tokenAggr[0] || { totalPrompt: 0, totalCompletion: 0, totalTokens: 0 };
  addRow('Token Prompt Sum', apiStats.tokenUsage.totalPromptTokens, rawTokens.totalPrompt);
  addRow('Token Completion Sum', apiStats.tokenUsage.totalCompletionTokens, rawTokens.totalCompletion);
  addRow('Token Total Sum', apiStats.tokenUsage.totalTokens, rawTokens.totalTokens);

  // Print Formatted Markdown Table
  console.log('| Metric | API Value | Raw Mongo Value | Match |');
  console.log('|---|---|---|---|');
  let hasMismatch = false;
  for (const r of rows) {
    console.log(`| ${r.metric} | ${r.apiValue} | ${r.mongoValue} | ${r.match} |`);
    if (r.match === 'MISMATCH') {
      hasMismatch = true;
    }
  }

  console.log('\n================================================================================');
  if (hasMismatch) {
    console.error('FAILED: One or more metrics mismatched between REST API and Raw Mongo query!');
    process.exit(1);
  } else {
    console.log('PASSED: All metrics strictly match between REST API and Raw Mongo query (100% computed match).');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
