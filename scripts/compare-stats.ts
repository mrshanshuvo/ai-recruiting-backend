import mongoose, { Types } from 'mongoose';
import { env } from '../src/config/env';
import { Job, Candidate, Reply, ActivityLog, OutreachMessage, TokenUsage, Conversation } from '../src/models';
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
  if (!apiData || !apiData.success || !apiData.stats) {
    console.error('FATAL: API response missing success envelope or stats object:', JSON.stringify(apiData));
    process.exit(1);
  }
  const apiStats = apiData.stats;

  console.log('--- REAL STATS API RESPONSE (JSON) ---');
  console.log(JSON.stringify(apiStats, null, 2));
  console.log('\n--- FIELD NAMES SCRIPT READS FROM apiStats ---');
  console.log([
    'apiStats.everReached.totalCandidates',
    'apiStats.everReached.contacted',
    'apiStats.everReached.replied',
    'apiStats.everReached.interested',
    'apiStats.everReached.meetings',
    'apiStats.everReached.hires',
    ...ALL_PIPELINE_STATUSES.map((st) => `apiStats.currentStatusCounts["${st}"]`),
    'apiStats.campaignSummary.sentMessages',
    'apiStats.campaignSummary.queuedMessages',
    'apiStats.campaignSummary.cancelledMessages',
    'apiStats.tokenUsage.totalPromptTokens',
    'apiStats.tokenUsage.totalCompletionTokens',
    'apiStats.tokenUsage.totalTokens',
  ].join('\n'));
  console.log('\n-----------------------------------------------\n');

  if (!apiStats.everReached || typeof apiStats.everReached !== 'object') {
    console.error('FATAL: Missing required block "everReached" in API stats');
    process.exit(1);
  }
  if (!apiStats.currentStatusCounts || typeof apiStats.currentStatusCounts !== 'object') {
    console.error('FATAL: Missing required block "currentStatusCounts" in API stats');
    process.exit(1);
  }
  if (!apiStats.campaignSummary || typeof apiStats.campaignSummary !== 'object') {
    console.error('FATAL: Missing required block "campaignSummary" in API stats');
    process.exit(1);
  }
  if (!apiStats.tokenUsage || typeof apiStats.tokenUsage !== 'object') {
    console.error('FATAL: Missing required block "tokenUsage" in API stats');
    process.exit(1);
  }

  const everReached = apiStats.everReached;
  const currentStatusCounts = apiStats.currentStatusCounts;

  function assertRequiredField(val: any, fieldPath: string) {
    if (val === undefined || val === null || typeof val !== 'number') {
      console.error(`FATAL: Missing or invalid required API field "${fieldPath}": received ${val}`);
      process.exit(1);
    }
  }

  assertRequiredField(everReached.totalCandidates, 'everReached.totalCandidates');
  assertRequiredField(everReached.contacted, 'everReached.contacted');
  assertRequiredField(everReached.replied, 'everReached.replied');
  assertRequiredField(everReached.interested, 'everReached.interested');
  assertRequiredField(everReached.meetings, 'everReached.meetings');
  assertRequiredField(everReached.hires, 'everReached.hires');

  assertRequiredField(apiStats.campaignSummary.sentMessages, 'campaignSummary.sentMessages');
  assertRequiredField(apiStats.campaignSummary.queuedMessages, 'campaignSummary.queuedMessages');
  assertRequiredField(apiStats.campaignSummary.cancelledMessages, 'campaignSummary.cancelledMessages');

  assertRequiredField(apiStats.tokenUsage.totalPromptTokens, 'tokenUsage.totalPromptTokens');
  assertRequiredField(apiStats.tokenUsage.totalCompletionTokens, 'tokenUsage.totalCompletionTokens');
  assertRequiredField(apiStats.tokenUsage.totalTokens, 'tokenUsage.totalTokens');

  for (const st of ALL_PIPELINE_STATUSES) {
    assertRequiredField(currentStatusCounts[st], `currentStatusCounts["${st}"]`);
  }

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
    addRow(`Status: ${st}`, currentStatusCounts[st], rawCount);
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
  const job = await Job.findById(jobObjectId).lean();
  const linkedConv = (job as any)?.conversationId
    ? { _id: (job as any).conversationId }
    : await Conversation.findOne({ jobId: jobObjectId }).lean();

  const tokenMatch: any = {
    $or: [{ jobId: jobObjectId }],
  };
  if (linkedConv?._id) {
    tokenMatch.$or.push({ conversationId: linkedConv._id });
  }

  const tokenAggr = await TokenUsage.aggregate([
    { $match: tokenMatch },
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
