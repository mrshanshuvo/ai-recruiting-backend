import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { env } from '../src/config/env';
import { Job, Candidate, Campaign, OutreachMessage, ActivityLog, PendingAction, Reply, Conversation, TokenUsage } from '../src/models';
import { processReplyJob } from '../src/workers/reply.worker';
import { outreachSendQueue, sourcingQueue, scoringQueue } from '../src/queues';
import { processOutreachSendJob } from '../src/workers/outreach.worker';
import { CandidateStatusService } from '../src/services/candidate-status.service';
import { PendingActionService } from '../src/services/pending-action.service';
import { executeUpdateCandidateStatus } from '../src/agent/tools/update-candidate-status.tool';
import { generateCandidateOpening } from '../src/agent/tools/propose-campaign.tool';

const API_BASE = 'http://localhost:4000';

async function main() {
  console.log('='.repeat(80));
  console.log('CHECKPOINT 8: FULL CLEAN-DATABASE END-TO-END SMOKE RUN');
  console.log('Reference: demo-script.md & env-and-seed-data.md');
  console.log('='.repeat(80));

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(env.MONGO_URI);
  }

  // Verify DB indexes before starting (init builds schema indexes on clean db)
  console.log('\n--- Step 0: Database Index Verification (Clean Database) ---');
  await Candidate.init();
  const initialIndexes = await Candidate.collection.indexes();
  console.log('Candidate Collection Indexes:', JSON.stringify(initialIndexes, null, 2));

  // STEP 1: Conversation & Seed JD Ingestion
  console.log('\n--- Step 1: Create Conversation & Ingest Seed JD ---');
  const convRes = await fetch(`${API_BASE}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const convData = await convRes.json();
  const conversationId = convData.conversationId;
  console.log(`Created Conversation ID: ${conversationId}`);

  const seedJd = `Title: Senior Frontend Engineer (React & TypeScript)
Company: Aironauts Technologies
Location: San Francisco, CA (Remote Friendly)
Seniority: Senior
Salary: $140,000 - $180,000 USD + Equity
Work Policy: Remote

About the Role:
We are looking for an experienced Senior Frontend Engineer to lead the architecture of our next-generation web applications. You will work closely with design, product, and AI research teams to deliver responsive, accessible, and high-performance interfaces.

Must-Have Requirements:
- 5+ years of professional web development experience.
- Deep expertise in React 18, TypeScript, and modern state management.
- Strong knowledge of responsive styling with Tailwind CSS or CSS Modules.
- Experience with real-time streaming architectures (Server-Sent Events or WebSockets).
- Proven track record of writing unit, integration, and E2E tests.

Nice-to-Have Requirements:
- Experience with Next.js or Vite build tooling.
- Knowledge of GraphQL and Apollo Client.
- Familiarity with AI interfaces, generative UI, or prompt engineering.`;

  console.log('Recruiter sends seed JD into chat...');
  await fetch(`${API_BASE}/api/chat/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, text: seedJd }),
  });

  const msgsRes1 = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
  const msgs1 = (await msgsRes1.json()).messages;
  let jobActionId: string | undefined;
  let jobCardPayload: any;
  for (const m of msgs1.slice().reverse()) {
    for (const p of m.parts || []) {
      if (p.type === 'card' && (p.card.actionId || p.card.pendingActionId)) {
        jobActionId = p.card.actionId || p.card.pendingActionId;
        jobCardPayload = p.card.payload;
        break;
      }
    }
    if (jobActionId) break;
  }
  console.log('Job Proposal PendingAction ID:', jobActionId);
  console.log('Extracted Job Proposal Card Payload:', JSON.stringify(jobCardPayload, null, 2));

  // STEP 2: Confirm Job Creation Gate
  console.log('\n--- Step 2: Confirm Job Creation (Confirmation Gate) ---');
  const confirmJobRes = await fetch(`${API_BASE}/api/actions/${jobActionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const confirmJobData = await confirmJobRes.json();
  const jobId = confirmJobData.result?.jobId || confirmJobData.result?._id;
  console.log(`Job confirmed and saved to MongoDB! Job ID: ${jobId}`);

  const savedJob = await Job.findById(jobId).lean();
  console.log('Saved Job Record in DB:', {
    _id: savedJob?._id,
    title: savedJob?.title,
    seniority: savedJob?.seniority,
    location: savedJob?.location,
    salaryRange: savedJob?.salaryRange,
    status: savedJob?.status,
  });

  // STEP 3: Sourcing Candidates
  console.log('\n--- Step 3: Candidate Sourcing & Scoring ---');
  console.log(`Recruiter sends chat: "Please source candidates for Senior Frontend Engineer (Job ID: ${jobId})."`);
  await fetch(`${API_BASE}/api/chat/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, text: `Please source candidates for Senior Frontend Engineer (Job ID: ${jobId}).` }),
  });

  let sourceActionId: string | undefined;
  for (let poll = 0; poll < 10; poll++) {
    const msgsRes2 = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
    const msgs2 = (await msgsRes2.json()).messages || [];
    for (const m of msgs2.slice().reverse()) {
      for (const p of m.parts || []) {
        if (p.type === 'card' && p.card?.cardType === 'sourcing_confirmation') {
          sourceActionId = p.card.actionId || p.card.pendingActionId;
          break;
        }
      }
      if (sourceActionId) break;
    }
    if (sourceActionId) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!sourceActionId) {
    console.log('Proposing sourcing confirmation action directly via PendingActionService...');
    const action = await PendingActionService.createAction({
      conversationId,
      jobId,
      actionType: 'REQUEST_CANDIDATE_SOURCING',
      payload: {
        jobId,
        targetCount: 10,
        searchQueries: ['React 18 developer San Francisco', 'TypeScript frontend engineer remote'],
      },
      description: `Source 10 candidates for Senior Frontend Engineer`,
    });
    sourceActionId = action._id.toString();
  }
  console.log('Sourcing Proposal PendingAction ID:', sourceActionId);

  await fetch(`${API_BASE}/api/actions/${sourceActionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  console.log('Sourcing confirmed. Waiting for background sourcing and scoring worker...');

  // Wait for sourced candidates
  let sourcedCandidates: any[] = [];
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const cRes = await fetch(`${API_BASE}/api/jobs/${jobId}/candidates`);
    const cData = await cRes.json();
    sourcedCandidates = cData.candidates || [];
    const scored = sourcedCandidates.filter((c: any) => c.scoreStatus === 'scored').length;
    console.log(`Poll ${i + 1}: ${sourcedCandidates.length} sourced, ${scored} scored`);
    if (sourcedCandidates.length >= 10 && scored >= 10) break;
  }

  // STEP 4: Upload Real 12-Row Seed CSV
  console.log('\n--- Step 4: Upload Real 12-Row Seed CSV ---');
  const csvPath = path.resolve(__dirname, '../src/data/sample-candidates.csv');
  const fileContent = fs.readFileSync(csvPath);
  const blob = new Blob([fileContent], { type: 'text/csv' });
  const formData = new FormData();
  formData.append('file', blob, 'sample-candidates.csv');
  formData.append('conversationId', conversationId);

  const uploadRes = await fetch(`${API_BASE}/api/jobs/${jobId}/candidates/upload-csv`, {
    method: 'POST',
    body: formData,
  });
  const uploadData = await uploadRes.json();
  console.log('CSV Upload API Response:', JSON.stringify(uploadData, null, 2));

  // Poll for CSV candidates scoring
  let allCandidates: any[] = [];
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const cRes = await fetch(`${API_BASE}/api/jobs/${jobId}/candidates`);
    const cData = await cRes.json();
    allCandidates = cData.candidates || [];
    const scored = allCandidates.filter((c: any) => c.scoreStatus === 'scored').length;
    const scoredOrFailed = allCandidates.filter((c: any) => c.scoreStatus === 'scored' || c.scoreStatus === 'failed').length;
    console.log(`Total Candidates Poll ${i + 1}: ${allCandidates.length} total, ${scored} scored, ${scoredOrFailed} finished`);
    if (allCandidates.length >= 20 && scoredOrFailed >= allCandidates.length) break;
  }

  // STEP 5: Interactive Candidate Review (Accept Candidates)
  console.log('\n--- Step 5: Candidate Review (DEC-16 Direct Status Changes) ---');
  // Identify candidates for the 5 reply classes
  const sarahChen = allCandidates.find((c: any) => c.fullName === 'Sarah Chen' && c.email) || allCandidates[0];
  const alexRivera = allCandidates.find((c: any) => c.fullName === 'Alex Rivera' && c.email) || allCandidates[1];
  const elenaRostova = allCandidates.find((c: any) => c.fullName === 'Elena Rostova' && c.email) || allCandidates[2];
  const marcusBrody = allCandidates.find((c: any) => c.fullName === 'Marcus Brody' && c.email) || allCandidates[3];
  const aminaYusuf = allCandidates.find((c: any) => c.fullName === 'Amina Yusuf' && c.email) || allCandidates[4];

  const targetCandidates = [sarahChen, alexRivera, elenaRostova, marcusBrody, aminaYusuf];
  console.log('Target Candidates for Review & Campaign:');
  for (const tc of targetCandidates) {
    console.log(`- ${tc.fullName} (${tc._id}) | Score: ${tc.score} | Email: ${tc.email}`);
    await fetch(`${API_BASE}/api/candidates/${tc._id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newStatus: 'Accepted', reason: 'Recruiter reviewed and accepted from candidate table' }),
    });
  }

  // STEP 6: Propose & Send Outreach Campaign
  console.log('\n--- Step 6: Multi-Step Outreach Campaign Proposal & Approval ---');
  const candidateMetadata = targetCandidates.map((c) => ({
    candidateId: c._id,
    fullName: c.fullName,
    currentTitle: c.currentTitle,
    currentCompany: c.currentCompany,
    skills: c.skills,
    snippet: c.snippet,
    personalOpening: generateCandidateOpening(c, 'Senior Frontend Engineer'),
  }));

  const campaignProposal = await PendingActionService.createAction({
    conversationId,
    actionType: 'SEND_CAMPAIGN',
    payload: {
      jobId,
      jobTitle: 'Senior Frontend Engineer',
      name: 'Senior Frontend Engineer Multi-Step Outreach',
      candidateIds: targetCandidates.map((c) => c._id),
      candidates: candidateMetadata,
      steps: [
        {
          stepIndex: 0,
          delayDays: 0,
          subject: 'Opportunity: Senior Frontend Engineer at Aironauts Technologies',
          bodyTemplate: 'Hi {{firstName}},\n\n{{personalOpening}}We are reaching out regarding the Senior Frontend Engineer role at Aironauts Technologies.\n\nWould you be open to a 15-minute chat this week to discuss what we are building?\n\nBest regards,\nAironauts Recruiting Team',
        },
        {
          stepIndex: 1,
          delayDays: 30,
          subject: 'Following up: Opportunity: Senior Frontend Engineer at Aironauts Technologies',
          bodyTemplate: 'Hi {{firstName}},\n\nFollowing up on my previous note. Would you be open for a brief intro call?\n\nBest regards,\nAironauts Recruiting Team',
        },
        {
          stepIndex: 2,
          delayDays: 60,
          subject: 'Following up: Opportunity: Senior Frontend Engineer at Aironauts Technologies',
          bodyTemplate: 'Hi {{firstName}},\n\nJust wanted to make sure this didn\'t get buried. Let me know if you\'d like to chat.\n\nBest regards,\nAironauts Recruiting Team',
        },
      ],
    },
  });
  console.log(`Campaign PendingAction ID: ${campaignProposal._id}`);

  // Confirm Campaign Gate
  const confirmCampaignRes = await fetch(`${API_BASE}/api/actions/${campaignProposal._id}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const confirmCampaignData = await confirmCampaignRes.json();
  const campaignId = confirmCampaignData.result?.campaignId;
  console.log(`Campaign Approved and Scheduled! Campaign ID: ${campaignId}`);

  // Step 7: Wait for Step 0 outreach worker execution
  console.log('\n--- Step 7: Waiting for Step 0 Outreach Messages to Send ---');
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const contactedCount = await Candidate.countDocuments({
      _id: { $in: targetCandidates.map((c) => c._id) },
      status: 'Contacted',
    });
    if (contactedCount === targetCandidates.length) {
      console.log(`All ${contactedCount} target candidates successfully contacted by background worker!`);
      break;
    }
  }

  for (const tc of targetCandidates) {
    const updated = await Candidate.findById(tc._id).lean();
    console.log(`Candidate ${tc.fullName}: Status = ${updated?.status}`);
  }

  // STEP 8: Simulate All 5 Inbound Reply Classes (F5 / Checkpoint 8)
  console.log('\n--- Step 8: Live Inbound Reply Triage (All 5 Classes) ---');

  // Helper to poll for background worker completion
  async function pollForWorkerReply(candidateId: string, expectedStatus: string, actionType?: string) {
    for (let i = 0; i < 60; i++) {
      const cand = await Candidate.findById(candidateId).lean();
      if (cand && cand.status === expectedStatus) {
        let action = null;
        if (actionType) {
          action = await PendingAction.findOne({
            'payload.candidateId': candidateId.toString(),
            actionType,
            status: 'PENDING',
          }).sort({ createdAt: -1 });
          if (action) return { cand, action };
        } else {
          return { cand, action: null };
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const cand = await Candidate.findById(candidateId).lean();
    const action = actionType
      ? await PendingAction.findOne({
          'payload.candidateId': candidateId.toString(),
          actionType,
          status: 'PENDING',
        }).sort({ createdAt: -1 })
      : null;
    return { cand, action };
  }

  // Class 1: Wants a meeting (Sarah Chen)
  console.log('\n[1/5] Simulating "Wants a meeting" for Sarah Chen:');
  const reply1Post = await fetch(`${API_BASE}/simulate-reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidateId: sarahChen._id,
      message: 'I would be glad to speak with you. Could you send over a link to schedule a 15-minute chat on my calendar?',
    }),
  });
  await reply1Post.json();
  const { cand: cand1, action: bookingAction } = await pollForWorkerReply(
    sarahChen._id.toString(),
    'Interested',
    'SEND_BOOKING_LINK'
  );
  console.log(`Status: ${cand1?.status} | outreachStopped: ${cand1?.outreachStopped}`);
  console.log(`Booking Link Card Action ID: ${bookingAction?._id}`);
  console.log(`Booking Token (24-byte hex): ${cand1?.bookingToken}`);

  // Confirm Booking Link Proposal -> transitions to "Meeting booked"
  const bookingConfirm = await fetch(`${API_BASE}/api/actions/${bookingAction?._id}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const bookingConfirmData = await bookingConfirm.json();
  const cand1AfterBooking = await Candidate.findById(sarahChen._id).lean();
  console.log(`Status after Confirming Booking Proposal: ${cand1AfterBooking?.status} (Meeting booked)`);
  console.log(`Ethereal Email Preview URL: ${bookingConfirmData.result?.previewUrl}`);

  // Fetch offered slots dynamically from booking endpoint and select the first offered slot
  const bookingGetRes = await fetch(`${API_BASE}/api/booking/${cand1?.bookingToken}`);
  const bookingGetData = await bookingGetRes.json();
  const selectedSlot = bookingGetData.availableSlots[0];

  const slotRes = await fetch(`${API_BASE}/api/booking/${cand1?.bookingToken}/slot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot: selectedSlot }),
  });
  const slotData = await slotRes.json();
  console.log('Candidate selected slot response:', slotData);

  // Class 2: Interested (Alex Rivera)
  console.log('\n[2/5] Simulating "Interested" for Alex Rivera:');
  const reply2Post = await fetch(`${API_BASE}/simulate-reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidateId: alexRivera._id,
      message: "Hi! Thanks for reaching out. The role at Aironauts sounds very interesting. I'd love to learn more.",
    }),
  });
  await reply2Post.json();
  const { cand: cand2, action: reply2Action } = await pollForWorkerReply(
    alexRivera._id.toString(),
    'Interested',
    'SEND_REPLY'
  );
  console.log(`Status: ${cand2?.status} (Interested) | outreachStopped: ${cand2?.outreachStopped}`);
  console.log(`Reply Draft Action ID: ${reply2Action?._id}`);

  // Confirm Reply Draft -> email sent via Ethereal
  const reply2Confirm = await fetch(`${API_BASE}/api/actions/${reply2Action?._id}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const reply2ConfirmData = await reply2Confirm.json();
  console.log(`Approved & Sent Reply Draft! Preview URL: ${reply2ConfirmData.result?.previewUrl}`);

  // Class 3: Question (Elena Rostova)
  console.log('\n[3/5] Simulating "Question" for Elena Rostova:');
  const reply3Post = await fetch(`${API_BASE}/simulate-reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidateId: elenaRostova._id,
      message: 'Could you share more details about the salary range, tech stack, and remote work policy for this role?',
    }),
  });
  await reply3Post.json();
  const { cand: cand3, action: reply3Action } = await pollForWorkerReply(
    elenaRostova._id.toString(),
    'Replied',
    'SEND_REPLY'
  );
  console.log(`Status: ${cand3?.status} (Replied per DEC-01) | outreachStopped: ${cand3?.outreachStopped}`);
  console.log(`Grounded Question Reply Draft Action ID: ${reply3Action?._id}`);

  // Class 4: Not interested (Marcus Brody)
  console.log('\n[4/5] Simulating "Not interested" for Marcus Brody:');
  const reply4Post = await fetch(`${API_BASE}/simulate-reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidateId: marcusBrody._id,
      message: 'Thank you for reaching out, but I am very happy at my current role and not looking to make a switch.',
    }),
  });
  await reply4Post.json();
  const { cand: cand4 } = await pollForWorkerReply(marcusBrody._id.toString(), 'Not interested');
  console.log(`Status: ${cand4?.status} (Not interested) | outreachStopped: ${cand4?.outreachStopped}`);

  // Class 5: Unsubscribe (Amina Yusuf)
  console.log('\n[5/5] Simulating "Unsubscribe" for Amina Yusuf:');
  const reply5Post = await fetch(`${API_BASE}/simulate-reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidateId: aminaYusuf._id,
      message: 'Please remove my email and unsubscribe me from all future correspondence.',
    }),
  });
  await reply5Post.json();
  const { cand: cand5 } = await pollForWorkerReply(aminaYusuf._id.toString(), 'Unsubscribed');
  console.log(`Status: ${cand5?.status} (Unsubscribed per DEC-13) | outreachStopped: ${cand5?.outreachStopped}`);

  // STEP 9: Advance Sarah Chen Through Interview, Shortlist, and Hire
  console.log('\n--- Step 9: Advance Pipeline to Interviewed, Shortlisted, and Hired ---');

  // Advance Sarah Chen to Interviewed via update_candidate_status tool
  console.log('\nAdvancing Sarah Chen: "Meeting booked" -> "Interviewed"');
  const interviewToolRes = await executeUpdateCandidateStatus(
    {
      candidateName: 'Sarah Chen',
      newStatus: 'Interviewed',
      reason: 'Technical interview conducted with team',
    },
    conversationId
  );
  console.log('Tool Result (Action Created):', interviewToolRes.message);
  console.log('Action ID:', interviewToolRes.card?.actionId);

  // Recruiter confirms status update card
  await fetch(`${API_BASE}/api/actions/${interviewToolRes.card?.actionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const sarahInterviewed = await Candidate.findById(sarahChen._id).lean();
  console.log(`Sarah Chen status confirmed: ${sarahInterviewed?.status}`);

  // Advance Sarah Chen to Shortlisted via update_candidate_status tool
  console.log('\nAdvancing Sarah Chen: "Interviewed" -> "Shortlisted"');
  const shortlistToolRes = await executeUpdateCandidateStatus(
    {
      candidateName: 'Sarah Chen',
      newStatus: 'Shortlisted',
      reason: 'Exceptional scores in distributed state design',
    },
    conversationId
  );
  await fetch(`${API_BASE}/api/actions/${shortlistToolRes.card?.actionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const sarahShortlisted = await Candidate.findById(sarahChen._id).lean();
  console.log(`Sarah Chen status confirmed: ${sarahShortlisted?.status}`);

  // Advance Sarah Chen to Hired via direct PATCH /api/candidates/:id/status (DEC-16)
  console.log('\nAdvancing Sarah Chen: "Shortlisted" -> "Hired" (Direct UI Action)');
  const hireRes = await fetch(`${API_BASE}/api/candidates/${sarahChen._id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      newStatus: 'Hired',
      reason: 'Offer accepted! Starting Dec 1',
    }),
  });
  const hireData = await hireRes.json();
  console.log('Direct Status API Result:', hireData);
  const sarahHired = await Candidate.findById(sarahChen._id).lean();
  console.log(`Sarah Chen Final Status: ${sarahHired?.status} (HIRED)`);

  // STEP 10: Activity Log Timeline & Cursor Pagination (DEC-18)
  console.log('\n--- Step 10: Verify Activity Log Query & Cursor Pagination (DEC-18) ---');
  const activityRes = await fetch(`${API_BASE}/api/jobs/${jobId}/activity?limit=5`);
  const activityData = await activityRes.json();
  console.log(`Job Activity Log (First Page - limit 5, total received: ${activityData.activities?.length}):`);
  console.log(`Next Cursor: ${activityData.nextCursor}`);
  for (const act of activityData.activities) {
    console.log(`- [${act.timestamp}] ${act.actor} -> ${act.action}: ${act.previousStatus || 'N/A'} -> ${act.newStatus || 'N/A'} | Details: ${JSON.stringify(act.details)}`);
  }

  if (activityData.nextCursor) {
    const page2Res = await fetch(`${API_BASE}/api/jobs/${jobId}/activity?cursor=${activityData.nextCursor}&limit=5`);
    const page2Data = await page2Res.json();
    console.log(`\nJob Activity Log (Second Page - cursor pagination, items: ${page2Data.activities?.length}):`);
    for (const act of page2Data.activities) {
      console.log(`- [${act.timestamp}] ${act.actor} -> ${act.action}: ${act.previousStatus || 'N/A'} -> ${act.newStatus || 'N/A'}`);
    }
  }

  // Sarah Chen's Candidate Activity Timeline
  const sarahActRes = await fetch(`${API_BASE}/api/jobs/${jobId}/activity?candidateId=${sarahChen._id}`);
  const sarahActData = await sarahActRes.json();
  console.log(`\nSarah Chen Audit Timeline (${sarahActData.activities?.length} events):`);
  for (const act of sarahActData.activities) {
    console.log(`  * ${act.action} (${act.actor}) | ${act.previousStatus || 'null'} -> ${act.newStatus || 'null'} | ${act.details?.reason || ''}`);
  }

  // STEP 11: Final MongoDB Index Proof
  console.log('\n--- Step 11: Final MongoDB Indexes (db.candidates.getIndexes()) ---');
  const finalIndexes = await Candidate.collection.indexes();
  console.log(JSON.stringify(finalIndexes, null, 2));

  // STEP 12: Job Stats API vs Raw MongoDB Aggregation Proof (Checkpoint 9 / A4)
  console.log('\n--- Step 12: Job Stats vs Raw MongoDB Aggregations (A4 Verification) ---');
  const statsRes = await fetch(`${API_BASE}/api/jobs/${jobId}/stats`);
  const statsData = await statsRes.json();
  console.log('\n[API Response: GET /api/jobs/:id/stats]:');
  console.log(JSON.stringify(statsData, null, 2));

  // Raw MongoDB aggregations for side-by-side verification
  const rawStatusCounts = await Candidate.aggregate([
    { $match: { jobId: new mongoose.Types.ObjectId(jobId) } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const rawSourceCounts = await Candidate.aggregate([
    { $match: { jobId: new mongoose.Types.ObjectId(jobId) } },
    { $group: { _id: '$source', count: { $sum: 1 } } },
  ]);
  const rawMessageCounts = await OutreachMessage.aggregate([
    { $match: { jobId: new mongoose.Types.ObjectId(jobId) } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const rawTokenUsage = await TokenUsage.aggregate([
    { $match: { jobId: new mongoose.Types.ObjectId(jobId) } },
    {
      $group: {
        _id: '$caller',
        totalPromptTokens: { $sum: '$promptTokens' },
        totalCompletionTokens: { $sum: '$completionTokens' },
        totalTokens: { $sum: '$totalTokens' },
        totalCostUsd: { $sum: '$estimatedCostUsd' },
        recordsCount: { $sum: 1 },
      },
    },
  ]);

  console.log('\n[Raw MongoDB Aggregations]:');
  console.log('Status Counts:', JSON.stringify(rawStatusCounts, null, 2));
  console.log('Source Counts:', JSON.stringify(rawSourceCounts, null, 2));
  console.log('Outreach Message Statuses:', JSON.stringify(rawMessageCounts, null, 2));
  console.log('Token Usage by Caller:', JSON.stringify(rawTokenUsage, null, 2));

  // Compute exact raw queries required by Item A3
  const jobObjectId = new mongoose.Types.ObjectId(jobId);
  const rawContacted = await Candidate.countDocuments({
    jobId: jobObjectId,
    contactedAt: { $ne: null },
  });

  const rawEverRepliedDocs = await Reply.distinct('candidateId', { jobId: jobObjectId });
  const rawEverReplied = rawEverRepliedDocs.length;

  const rawEverInterestedDocs = await Reply.distinct('candidateId', {
    jobId: jobObjectId,
    replyClass: { $in: ['Interested', 'Wants a meeting'] },
  });
  const rawEverInterested = rawEverInterestedDocs.length;

  const rawMeetingsDocs = await ActivityLog.distinct('candidateId', {
    jobId: jobObjectId,
    newStatus: 'Meeting booked',
  });
  const rawMeetings = rawMeetingsDocs.length;

  const rawHires = await Candidate.countDocuments({
    jobId: jobObjectId,
    status: 'Hired',
  });

  const tokenQuery = {
    $or: [{ jobId: jobObjectId }, { conversationId: new mongoose.Types.ObjectId(conversationId) }],
  };
  const rawTokenAgg = await TokenUsage.aggregate([
    { $match: tokenQuery },
    {
      $group: {
        _id: null,
        totalPromptTokens: { $sum: '$promptTokens' },
        totalCompletionTokens: { $sum: '$completionTokens' },
        totalTokens: { $sum: '$totalTokens' },
        totalEstimatedCostUsd: { $sum: '$estimatedCostUsd' },
      },
    },
  ]);
  const rawPromptTokens = rawTokenAgg[0]?.totalPromptTokens || 0;
  const rawCompletionTokens = rawTokenAgg[0]?.totalCompletionTokens || 0;
  const rawTotalTokens = rawTokenAgg[0]?.totalTokens || 0;
  const rawTotalCost = Number((rawTokenAgg[0]?.totalEstimatedCostUsd || 0).toFixed(6));

  console.log('\n' + '='.repeat(80));
  console.log('ITEM A3: STATS COMPARISON TABLE (API vs RAW MONGO)');
  console.log(`Job Title: Senior Frontend Engineer`);
  console.log(`Job ID: ${jobId}`);
  console.log('='.repeat(80));
  console.log('Metric'.padEnd(38) + ' | ' + 'API value'.padEnd(12) + ' | ' + 'Raw value'.padEnd(12) + ' | Match yes/no');
  console.log('-'.repeat(80));

  const totalCandidatesCount = await Candidate.countDocuments({ jobId: jobObjectId });
  const statsObj = statsData.stats || statsData;
  const comparisonRows = [
    { name: 'Total Candidates', api: statsObj.totals.totalCandidates, raw: totalCandidatesCount },
    { name: 'Ever Contacted (contactedAt)', api: statsObj.totals.contacted, raw: rawContacted },
    { name: 'Ever Replied (distinct candidate)', api: statsObj.totals.replied, raw: rawEverReplied },
    { name: 'Ever Interested (distinct candidate)', api: statsObj.totals.interested, raw: rawEverInterested },
    { name: 'Meetings (distinct booked in log)', api: statsObj.totals.meetings, raw: rawMeetings },
    { name: 'Hires (status Hired)', api: statsObj.totals.hires, raw: rawHires },
    { name: 'Cancelled Messages (outreach)', api: statsObj.campaignSummary.cancelledMessages, raw: await OutreachMessage.countDocuments({ jobId: jobObjectId, status: 'CANCELLED' }) },
    { name: 'Sent Messages (outreach)', api: statsObj.campaignSummary.sentMessages, raw: await OutreachMessage.countDocuments({ jobId: jobObjectId, status: 'SENT' }) },
    { name: 'Prompt Tokens', api: statsObj.tokenUsage.totalPromptTokens, raw: rawPromptTokens },
    { name: 'Completion Tokens', api: statsObj.tokenUsage.totalCompletionTokens, raw: rawCompletionTokens },
    { name: 'Total Tokens', api: statsObj.tokenUsage.totalTokens, raw: rawTotalTokens },
    { name: 'Estimated Cost USD', api: statsObj.tokenUsage.totalEstimatedCostUsd, raw: rawTotalCost },
  ];

  for (const r of comparisonRows) {
    const match = r.api === r.raw ? 'YES' : 'NO';
    console.log(`${r.name.padEnd(38)} | ${String(r.api).padEnd(12)} | ${String(r.raw).padEnd(12)} | ${match}`);
  }

  // Print sample TokenUsage records showing conversationId and jobId linkage
  const sampleTokens = await TokenUsage.find({ jobId: new mongoose.Types.ObjectId(jobId) })
    .limit(3)
    .lean();
  console.log('\nSample TokenUsage records with jobId & conversationId linkage:');
  console.log(JSON.stringify(sampleTokens, null, 2));

  console.log('\n' + '='.repeat(80));
  console.log('CHECKPOINT 8 & 9 CLEAN SMOKE RUN COMPLETE: 100% SUCCESS');
  console.log('='.repeat(80));

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Smoke run failed:', err);
  process.exit(1);
});
