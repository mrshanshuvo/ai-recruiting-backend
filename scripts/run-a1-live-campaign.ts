import mongoose from 'mongoose';
import { env } from '../src/config/env';
import { Job, Candidate, Campaign, OutreachMessage, Conversation, PendingAction } from '../src/models';
import { PendingActionService } from '../src/services/pending-action.service';
import { generateCandidateOpening } from '../src/agent/tools/propose-campaign.tool';
import { outreachSendQueue } from '../src/queues';

async function main() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(env.MONGO_URI);
  }

  console.log('='.repeat(80));
  console.log('ITEM A1 (c): LIVE OUTREACH CAMPAIGN WITH DELAY_UNIT=seconds');
  console.log('='.repeat(80));

  // 1. Create Job
  const conversation = await Conversation.create({
    channel: 'web',
    metadata: { test: 'a1-live-campaign' },
  });

  const job = await Job.create({
    title: 'Senior Frontend Engineer',
    department: 'Engineering',
    location: 'Remote',
    seniority: 'Senior',
    mustHaveSkills: ['React', 'TypeScript', 'Tailwind CSS'],
    remotePolicy: 'Remote',
    conversationId: conversation._id,
  });

  // 2. Create 2 Candidates (Sarah Chen with rich profile, Alex Rivera)
  const sarah = await Candidate.create({
    jobId: job._id,
    fullName: 'Sarah Chen',
    currentTitle: 'Staff UI Engineer',
    currentCompany: 'CloudScale Inc',
    skills: ['React', 'TypeScript', 'Tailwind CSS', 'Vite', 'SSE'],
    snippet: 'Leading frontend UI architecture, design systems, and real-time streaming interfaces.',
    email: 'sarah.chen@example.com',
    emailStatus: 'valid',
    status: 'Accepted',
    source: 'csv',
    sourceMode: 'csv',
  });

  const alex = await Candidate.create({
    jobId: job._id,
    fullName: 'Alex Rivera',
    currentTitle: 'Frontend Engineer',
    currentCompany: 'FinTech Labs',
    skills: ['React', 'TypeScript', 'Next.js'],
    snippet: 'Building high-performance financial dashboards.',
    email: 'alex.rivera@example.com',
    emailStatus: 'valid',
    status: 'Accepted',
    source: 'csv',
    sourceMode: 'csv',
  });

  const candidates = [sarah, alex];

  console.log(`\nCreated job: ${job.title} (${job._id})`);
  console.log(`Enrolled candidates: ${candidates.map(c => c.fullName).join(', ')}`);

  // 3. Propose Campaign with 3 steps: Day 0 (0s), Day 1 (2s), Day 2 (4s)
  const candidateMetadata = candidates.map((c) => ({
    candidateId: c._id.toString(),
    fullName: c.fullName,
    currentTitle: c.currentTitle,
    currentCompany: c.currentCompany,
    skills: c.skills,
    snippet: c.snippet,
    personalOpening: generateCandidateOpening(c, job.title),
  }));

  const steps = [
    {
      stepIndex: 0,
      delayDays: 0,
      label: 'Initial Outreach (Day 0)',
      subject: `Opportunity: ${job.title} at Aironauts Technologies`,
      bodyTemplate: `Hi {{firstName}},\n\n{{personalOpening}}We are currently expanding our core team at Aironauts Technologies and are hiring for a ${job.title}.\n\nGiven your strong expertise with React, TypeScript, I believe this role would be a great mutual fit.\n\nWould you be open to a 15-minute chat this week to discuss what we are building?\n\nBest regards,\nAironauts Recruiting Team`,
    },
    {
      stepIndex: 1,
      delayDays: 2,
      label: 'Follow-Up (Day 3)',
      subject: `Following up: Opportunity: ${job.title} at Aironauts Technologies`,
      bodyTemplate: `Hi {{firstName}},\n\nJust following up on my previous note regarding the ${job.title} position at Aironauts Technologies. I know things get busy, so I wanted to ensure this did not slip through the cracks.\n\nLet me know if you might have 10-15 minutes for a quick conversation, or feel free to reply with any initial questions.\n\nBest,\nAironauts Recruiting Team`,
    },
    {
      stepIndex: 2,
      delayDays: 4,
      label: 'Final Follow-Up (Day 7)',
      subject: `Following up: Opportunity: ${job.title} at Aironauts Technologies`,
      bodyTemplate: `Hi {{firstName}},\n\nI wanted to reach out one last time regarding the ${job.title} opportunity. If the timing is not right, no worries at all!\n\nFeel free to keep in touch for future opportunities.\n\nBest regards,\nAironauts Recruiting Team`,
    },
  ];

  const pendingAction = await PendingActionService.createAction({
    conversationId: conversation._id.toString(),
    actionType: 'SEND_CAMPAIGN',
    payload: {
      jobId: job._id.toString(),
      jobTitle: job.title,
      name: `${job.title} Outreach Campaign`,
      candidateIds: candidates.map(c => c._id.toString()),
      candidates: candidateMetadata,
      steps,
    },
  });

  console.log(`Created PendingAction: ${pendingAction._id}`);

  // 4. Confirm campaign (triggers BullMQ enrollment with seconds delay)
  const confirmResult = await PendingActionService.confirmAction(pendingAction._id.toString());
  console.log('Confirmed campaign proposal:', confirmResult.result);

  const campaignId = confirmResult.result.campaignId;

  // 5. Poll until all 6 messages (2 candidates * 3 steps) are SENT
  console.log('\nWaiting for BullMQ worker to dispatch Step 0, Step 1, and Step 2...');
  const startTime = Date.now();
  let sentCount = 0;

  while (Date.now() - startTime < 30000) {
    sentCount = await OutreachMessage.countDocuments({
      campaignId: new mongoose.Types.ObjectId(campaignId),
      status: 'SENT',
    });
    console.log(`[${Math.round((Date.now() - startTime) / 1000)}s] Sent messages: ${sentCount}/6`);
    if (sentCount >= 6) break;
    await new Promise(r => setTimeout(r, 1000));
  }

  // 6. Fetch Sarah Chen's 3 messages
  const sarahMessages = await OutreachMessage.find({
    campaignId: new mongoose.Types.ObjectId(campaignId),
    candidateId: sarah._id,
  }).sort({ stepIndex: 1 });

  console.log('\n' + '='.repeat(80));
  console.log('STORED DATA OF SARAH CHEN:');
  console.log('='.repeat(80));
  console.log(JSON.stringify({
    fullName: sarah.fullName,
    currentTitle: sarah.currentTitle,
    currentCompany: sarah.currentCompany,
    skills: sarah.skills,
    snippet: sarah.snippet,
  }, null, 2));

  console.log('\n' + '='.repeat(80));
  console.log('LIVE DISPATCHED OUTREACH MESSAGES FOR SARAH CHEN:');
  console.log('='.repeat(80));

  for (const msg of sarahMessages) {
    console.log(`\n----------------- STEP ${msg.stepIndex} (sentAt: ${msg.sentAt?.toISOString()}) -----------------`);
    console.log(`Subject: ${msg.subject}`);
    console.log(`Transport: ${msg.transport}`);
    console.log(`Preview URL: ${msg.previewUrl || 'N/A'}`);
    console.log(`Body:\n${msg.body}`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
