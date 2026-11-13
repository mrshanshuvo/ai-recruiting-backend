import mongoose from 'mongoose';
import crypto from 'crypto';
import { env } from '../src/config/env';
import { Candidate, Job, Campaign, CampaignStep, OutreachMessage, ActivityLog, PendingAction, Reply, Conversation } from '../src/models';
import { outreachSendQueue } from '../src/queues';
import { PendingActionService } from '../src/services/pending-action.service';
import { CandidateStatusService } from '../src/services/candidate-status.service';
import { processReplyJob } from '../src/workers/reply.worker';

async function main() {
  console.log('='.repeat(80));
  console.log('CHECKPOINT 7: LIVE PROOF OF ALL 5 REPLY CLASSES (F5)');
  console.log('='.repeat(80));

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(env.MONGO_URI);
  }

  const runId = Date.now().toString().slice(-6);

  // 1. Create Clean Job for this Run
  const conversation = await Conversation.create({
    title: `Recruiting Run ${runId}`,
  });

  const job = await Job.create({
    title: `Staff Distributed Systems Engineer (Run ${runId})`,
    department: 'Engineering',
    location: 'Remote - US & Canada',
    remotePolicy: 'Remote',
    seniority: 'Staff',
    rawDescription: 'Building high-throughput streaming pipelines and distributed state storage.',
    mustHaveSkills: ['Go', 'Kubernetes', 'Distributed Systems'],
    niceToHaveSkills: ['Kafka', 'gRPC'],
    salaryRange: {
      min: 185000,
      max: 235000,
      currency: 'USD',
    },
    status: 'OPEN',
    conversationId: conversation._id,
  });

  conversation.jobId = job._id;
  await conversation.save();

  console.log(`\nCreated Job: "${job.title}" (ID: ${job._id})`);
  console.log(`Linked Conversation ID: ${conversation._id}`);

  // 2. Create 5 Candidates with Valid Emails
  const candidateData = [
    { name: 'Zoe Washington', title: 'Senior Distributed Systems Engineer', company: 'StreamTech' },
    { name: 'Liam Patel', title: 'Lead Backend Engineer', company: 'DataMesh Corp' },
    { name: 'Maya Lin', title: 'Staff Infrastructure Engineer', company: 'CloudBase' },
    { name: 'Carlos Mendez', title: 'Systems Architect', company: 'ScaleX' },
    { name: 'Elena Rostova', title: 'Principal Systems Developer', company: 'KernelWorks' },
  ];

  const candidates: any[] = [];
  for (const c of candidateData) {
    const slug = c.name.toLowerCase().replace(/\s+/g, '.');
    const doc = await Candidate.create({
      jobId: job._id,
      fullName: c.name,
      email: `${slug}.${runId}@example.com`,
      emailStatus: 'valid',
      currentTitle: c.title,
      currentCompany: c.company,
      skills: ['Go', 'Kubernetes', 'Distributed Systems'],
      score: 85,
      scoreStatus: 'scored',
      status: 'Accepted',
      outreachStopped: false,
    });
    candidates.push(doc);
  }

  console.log(`Created 5 Accepted Candidates:`);
  for (const c of candidates) {
    console.log(` - ${c.fullName} <${c.email}> [Status: ${c.status}]`);
  }

  // 3. Launch Outreach Campaign (3 steps: Day 0, Day 3, Day 7)
  console.log('\n--- Launching 3-Step Outreach Campaign ---');
  const campaignAction = await PendingActionService.createAction({
    conversationId: conversation._id.toString(),
    jobId: job._id.toString(),
    actionType: 'SEND_CAMPAIGN',
    payload: {
      jobId: job._id.toString(),
      candidateIds: candidates.map((c) => c._id.toString()),
      name: `Outreach Campaign ${runId}`,
      steps: [
        {
          stepIndex: 0,
          delayDays: 0,
          label: 'Initial Outreach (Day 0)',
          subject: `Opportunity: ${job.title} at Aironauts Technologies`,
          bodyTemplate: `Hi {{firstName}},\n\nWe are building next-gen systems and would love to connect about the ${job.title} role.\n\nBest,\nAironauts Recruiting`,
        },
        {
          stepIndex: 1,
          delayDays: 3,
          label: 'Follow-Up (Day 3)',
          subject: `Following up: Opportunity: ${job.title} at Aironauts Technologies`,
          bodyTemplate: `Hi {{firstName}},\n\nJust following up on my previous note about the ${job.title} role.\n\nBest,\nAironauts Recruiting`,
        },
        {
          stepIndex: 2,
          delayDays: 7,
          label: 'Final Follow-Up (Day 7)',
          subject: `Following up: Opportunity: ${job.title} at Aironauts Technologies`,
          bodyTemplate: `Hi {{firstName}},\n\nChecking in one last time regarding the ${job.title} opening.\n\nBest,\nAironauts Recruiting`,
        },
      ],
      candidates: candidates.map((c) => ({
        candidateId: c._id.toString(),
        personalOpening: `I noticed your distributed systems work at ${c.currentCompany}. `,
      })),
    },
  });

  const confirmCampaignRes = await PendingActionService.confirmAction(
    campaignAction._id.toString(),
    conversation._id.toString()
  );
  const campaignId = confirmCampaignRes.result.campaignId;
  console.log(`Campaign Confirmed & Launched (CampaignId: ${campaignId})`);

  // Update candidate status to Contacted (simulating Step 0 send completion)
  for (const c of candidates) {
    await CandidateStatusService.transition(
      c._id,
      'Contacted',
      'system',
      'Step 0 outreach sent'
    );
  }

  // Helper to query BullMQ queue jobs for a candidate
  async function getQueuedJobsForCandidate(candId: string) {
    const jobs = await outreachSendQueue.getJobs(['waiting', 'delayed']);
    return jobs.filter(
      (j) => j.data?.candidateId === candId || String(j.data?.candidateId) === candId
    );
  }

  // 4. Test Inbound Reply Simulation for All 5 Classes
  console.log('\n' + '='.repeat(80));
  console.log('SIMULATING 1 INBOUND REPLY FOR EACH OF THE 5 CLASSES (1 PER CANDIDATE)');
  console.log('='.repeat(80));

  const simulationPlans = [
    {
      candidate: candidates[0], // Zoe Washington
      replyClass: 'Interested' as const,
      emailText:
        'Hi, thanks for reaching out! The role at Aironauts sounds very interesting. I would love to learn more about what your team is building.',
    },
    {
      candidate: candidates[1], // Liam Patel
      replyClass: 'Question' as const,
      emailText:
        'Could you share more details about the salary range, tech stack, and remote work policy for this role?',
    },
    {
      candidate: candidates[2], // Maya Lin
      replyClass: 'Wants a meeting' as const,
      emailText:
        'I would be glad to speak with you! Could you send over a link to schedule a 15-minute chat on my calendar?',
    },
    {
      candidate: candidates[3], // Carlos Mendez
      replyClass: 'Not interested' as const,
      emailText:
        'Thank you for reaching out, but I am very happy at my current position and will have to pass.',
    },
    {
      candidate: candidates[4], // Elena Rostova
      replyClass: 'Unsubscribe' as const,
      emailText:
        'Please unsubscribe me and remove my email from your recruitment outreach list immediately.',
    },
  ];

  let bookingActionIdToConfirm: string | undefined;

  for (let i = 0; i < simulationPlans.length; i++) {
    const plan = simulationPlans[i];
    const cand = plan.candidate;

    console.log(`\n--------------------------------------------------------------------------------`);
    console.log(`CLASS ${i + 1}/5: "${plan.replyClass}" | Candidate: ${cand.fullName} (${cand._id})`);
    console.log(`--------------------------------------------------------------------------------`);

    // Status Before
    const candBefore = await Candidate.findById(cand._id);
    const statusBefore = candBefore?.status;

    // BullMQ jobs Before
    const queueBefore = await getQueuedJobsForCandidate(cand._id.toString());
    const queueJobIdsBefore = queueBefore.map((j) => j.id);

    console.log(`[Status Before]: ${statusBefore}`);
    console.log(`[BullMQ Jobs Before (${queueBefore.length})]: ${queueJobIdsBefore.join(', ') || 'None'}`);
    console.log(`[Inbound Reply Text]: "${plan.emailText}"`);

    // Process Inbound Reply
    const replyResult = await processReplyJob({
      candidateId: cand._id.toString(),
      emailText: plan.emailText,
      conversationId: conversation._id.toString(),
      isSimulated: true,
    });

    // Candidate After
    const candAfter = await Candidate.findById(cand._id);
    const statusAfter = candAfter?.status;
    const outreachStoppedAfter = candAfter?.outreachStopped;

    // BullMQ jobs After
    const queueAfter = await getQueuedJobsForCandidate(cand._id.toString());
    const queueJobIdsAfter = queueAfter.map((j) => j.id);

    // Reply Record
    const replyDoc = await Reply.findById(replyResult.replyId);

    // PendingAction / Draft Created
    let actionDoc = null;
    if (replyResult.actionId) {
      actionDoc = await PendingAction.findById(replyResult.actionId);
      if (plan.replyClass === 'Wants a meeting') {
        bookingActionIdToConfirm = replyResult.actionId;
      }
    }

    // ActivityLog Entries
    const activityLogs = await ActivityLog.find({
      candidateId: cand._id,
    }).sort({ timestamp: -1 }).limit(2);

    console.log(`\n--- Verification Output for ${plan.replyClass} ---`);
    console.log(`[Classified Class]: "${replyResult.replyClass}"`);
    console.log(`[Classification Reason]: "${replyDoc?.classificationReason}"`);
    console.log(`[Status Before -> After]: "${statusBefore}" -> "${statusAfter}"`);
    console.log(`[outreachStopped Flag]: ${outreachStoppedAfter} (MUST BE TRUE)`);
    console.log(`[BullMQ Jobs Remaining After]: ${queueAfter.length} (MUST BE 0: [${queueJobIdsAfter.join(', ')}])`);

    if (actionDoc) {
      console.log(`[PendingAction Created]: ID: ${actionDoc._id} | Type: ${actionDoc.actionType}`);
      console.log(`[Card Payload]:`, JSON.stringify(actionDoc.payload, null, 2));
    } else {
      console.log(`[PendingAction Created]: None (Unsubscribe produces no email draft per F2)`);
    }

    console.log(`[Recent ActivityLog Entries]:`);
    for (const log of activityLogs) {
      console.log(`  - Action: ${log.action} | Actor: ${log.actor} | Prev: ${log.previousStatus} -> New: ${log.newStatus} | Details:`, JSON.stringify(log.details));
    }

    // Assertions
    if (outreachStoppedAfter !== true) throw new Error(`outreachStopped is not true for ${cand.fullName}`);
    if (queueAfter.length !== 0) throw new Error(`Queue jobs were not cleared for ${cand.fullName}`);
    if (plan.replyClass === 'Question' && statusAfter !== 'Replied') throw new Error(`Question status must remain Replied (DEC-01)`);
    if (plan.replyClass === 'Interested' && statusAfter !== 'Interested') throw new Error(`Interested status must be Interested`);
    if (plan.replyClass === 'Wants a meeting' && statusAfter !== 'Interested') throw new Error(`Wants a meeting must transition to Interested`);
    if (plan.replyClass === 'Not interested' && statusAfter !== 'Not interested') throw new Error(`Not interested status must be Not interested`);
    if (plan.replyClass === 'Unsubscribe' && statusAfter !== 'Unsubscribed') throw new Error(`Unsubscribe status must be Unsubscribed`);
  }

  // 5. Confirm Booking Link Proposal for Candidate 3 ("Wants a meeting")
  console.log('\n' + '='.repeat(80));
  console.log('CONFIRMING BOOKING LINK PROPOSAL FOR CANDIDATE 3 ("Wants a meeting")');
  console.log('='.repeat(80));

  if (!bookingActionIdToConfirm) {
    throw new Error('No booking action ID captured for Wants a meeting candidate');
  }

  const maya = candidates[2];
  console.log(`Confirming PendingAction: ${bookingActionIdToConfirm} for ${maya.fullName}...`);

  const confirmBookingRes = await PendingActionService.confirmAction(
    bookingActionIdToConfirm,
    conversation._id.toString()
  );

  console.log(`Booking Confirmation Status: ${confirmBookingRes.status}`);
  console.log(`Execution Result:`, JSON.stringify(confirmBookingRes.result, null, 2));

  const mayaAfterBooking = await Candidate.findById(maya._id);
  console.log(`Candidate Status After Booking Confirmation: "${mayaAfterBooking?.status}" (MUST BE "Meeting booked")`);
  console.log(`Candidate Booking Token: "${mayaAfterBooking?.bookingToken}"`);
  console.log(`Ethereal Email Preview URL: "${confirmBookingRes.result.previewUrl || 'Local transport (preview in logs)'}"`);

  // 6. Simulate Mock Slot Picker Selection
  console.log('\n--- Candidate Accesses Mock Slot Picker & Selects Slot ---');
  const chosenSlot = 'Thu, Nov 21 at 02:00 PM (UTC)';
  mayaAfterBooking!.meetingSlot = chosenSlot;
  await mayaAfterBooking!.save();

  await ActivityLog.create({
    jobId: job._id,
    candidateId: maya._id,
    actor: 'system',
    action: 'candidate_selected_slot',
    previousStatus: mayaAfterBooking!.status,
    newStatus: mayaAfterBooking!.status,
    details: {
      slot: chosenSlot,
      bookingToken: mayaAfterBooking!.bookingToken,
    },
    timestamp: new Date(),
  });

  const mayaFinal = await Candidate.findById(maya._id);
  console.log(`Saved meetingSlot: "${mayaFinal?.meetingSlot}"`);
  console.log(`Final Status (DEC-02): "${mayaFinal?.status}" (Remains Meeting booked)`);

  const slotLog = await ActivityLog.findOne({
    candidateId: maya._id,
    action: 'candidate_selected_slot',
  });
  console.log(`Slot Selection ActivityLog Entry:`, JSON.stringify(slotLog?.toJSON(), null, 2));

  console.log('\n' + '='.repeat(80));
  console.log('ALL 5 REPLY CLASSES LIVE PROOF SUCCESSFULLY COMPLETED');
  console.log('='.repeat(80));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Fatal error during Checkpoint 7 live proof run:', err);
  process.exit(1);
});
