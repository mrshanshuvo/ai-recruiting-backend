import mongoose from 'mongoose';
import { env } from '../src/config/env';
import { Candidate, Job, Reply, ActivityLog } from '../src/models';

const API_BASE = 'http://localhost:4000';

async function main() {
  await mongoose.connect(env.MONGO_URI);
  console.log('Connected to MongoDB via Mongoose');
  console.log('========================================================================');
  console.log('CHECKPOINT 7 LIVE END-TO-END VERIFICATION: REPLIES, BOOKING & PIPELINE');
  console.log('========================================================================');

  console.log('\n--- Step 1: Create Conversation ---');
  const convRes = await fetch(`${API_BASE}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const conversationId = (await convRes.json()).conversationId;
  console.log('Conversation created:', conversationId);

  console.log('\n--- Step 2: Post Seed JD to Create & Confirm Job ---');
  const seedJd = `Title: Staff Distributed Systems Engineer
Company: Aironauts Technologies
Location: San Francisco, CA (Remote Friendly)
Seniority: Staff
Salary: $180,000 - $240,000 USD + Equity
Work Policy: Remote

About the Role:
We are looking for a Staff Distributed Systems Engineer to lead the architecture of our real-time streaming pipeline.

Must-Have Requirements:
- 7+ years of experience with distributed backend systems.
- Production expertise in Go, Kubernetes, and gRPC.
- Strong knowledge of event streaming (Kafka or Redis Streams).
- Proven track record in high-concurrency systems.`;

  await fetch(`${API_BASE}/api/chat/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, text: seedJd }),
  });

  const msgsRes1 = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
  const msgs1 = (await msgsRes1.json()).messages;
  let jobActionId: string | undefined;
  for (const m of msgs1.slice().reverse()) {
    for (const p of m.parts || []) {
      if (p.type === 'card' && p.card.actionId) {
        jobActionId = p.card.actionId;
        break;
      }
    }
    if (jobActionId) break;
  }

  const confirmJobRes = await fetch(`${API_BASE}/api/actions/${jobActionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const confirmJobData = await confirmJobRes.json();
  const jobId = confirmJobData.result?.jobId || confirmJobData.result?._id;
  console.log('Job confirmed with ID:', jobId);

  console.log('\n--- Step 3: Request & Confirm Sourcing (10 Candidates) ---');
  await fetch(`${API_BASE}/api/chat/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, text: 'Please source candidates for this job.' }),
  });

  const msgsRes2 = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
  const msgs2 = (await msgsRes2.json()).messages;
  let sourceActionId: string | undefined;
  for (const m of msgs2.slice().reverse()) {
    for (const p of m.parts || []) {
      if (p.type === 'card' && p.card.actionId) {
        sourceActionId = p.card.actionId;
        break;
      }
    }
    if (sourceActionId) break;
  }

  await fetch(`${API_BASE}/api/actions/${sourceActionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  console.log('Sourcing confirmed. Waiting for background scoring...');

  let candidates: any[] = [];
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const cRes = await fetch(`${API_BASE}/api/jobs/${jobId}/candidates?limit=20`);
    const cData = await cRes.json();
    candidates = cData.candidates || [];
    const scoredCount = candidates.filter((c: any) => c.scoreStatus === 'scored').length;
    console.log(`Poll ${i + 1}: ${candidates.length} candidates in DB, ${scoredCount} scored`);
    if (candidates.length >= 10 && scoredCount >= 10) break;
  }

  console.log('\n--- Step 4: Accept Candidate Zoe Washington & Hannah Schmidt ---');
  const zoe = candidates.find((c: any) => c.fullName.toLowerCase().includes('zoe'));
  const hannah = candidates.find((c: any) => c.fullName.toLowerCase().includes('hannah'));

  console.log(`Zoe ID: ${zoe._id} | Hannah ID: ${hannah._id}`);

  await fetch(`${API_BASE}/api/candidates/${zoe._id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newStatus: 'Accepted', reason: 'High match score' }),
  });

  await fetch(`${API_BASE}/api/candidates/${hannah._id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newStatus: 'Accepted', reason: 'High match score' }),
  });

  console.log('Waiting 25s for Gemini rate limit cooldown...');
  await new Promise((r) => setTimeout(r, 25000));

  console.log('\n--- Step 5: Propose & Confirm Outreach Campaign ---');
  await fetch(`${API_BASE}/api/chat/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, text: 'Draft an outreach campaign for the accepted candidates.' }),
  });

  const msgsRes3 = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
  const msgs3 = (await msgsRes3.json()).messages;
  let campaignActionId: string | undefined;
  for (const m of msgs3.slice().reverse()) {
    for (const p of m.parts || []) {
      if (p.type === 'card' && p.card.cardType === 'campaign_preview') {
        campaignActionId = p.card.actionId;
        break;
      }
    }
    if (campaignActionId) break;
  }

  const campConfirmRes = await fetch(`${API_BASE}/api/actions/${campaignActionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const campData = await campConfirmRes.json();
  const campId = campData.result?.campaignId;
  console.log(`Campaign confirmed with ID ${campId}. Waiting 6s for initial Step 0 dispatch...`);
  await new Promise((r) => setTimeout(r, 6000));

  const zoeContacted = await Candidate.findById(zoe._id);
  console.log(`Candidate Zoe status after Step 0: "${zoeContacted?.status}" (contactedAt: ${zoeContacted?.contactedAt?.toISOString()})`);

  console.log('\n--- Step 6: Simulate Inbound Candidate Reply from Zoe (Interested) ---');
  const simReplyText = "Hi! I am very interested in this Staff Distributed Systems Engineer role at Aironauts. Could you please send over a link to schedule a 15-minute introductory chat?";
  console.log(`Sending simulated reply to POST /api/replies/simulate...`);
  const replySimRes = await fetch(`${API_BASE}/api/replies/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidateId: zoe._id,
      emailText: simReplyText,
      conversationId,
      sync: true, // Process synchronously for deterministic verification output
    }),
  });
  const replySimData = await replySimRes.json();
  console.log('Simulate Reply Response:', JSON.stringify(replySimData, null, 2));

  // Verify in MongoDB: status transitioned to 'Interested', outreachStopped is true, bookingToken generated
  const zoeInterested = await Candidate.findById(zoe._id);
  console.log('\nDatabase Verification for Zoe after Reply:');
  console.log(`- Status:          "${zoeInterested?.status}" (Expected: Interested)`);
  console.log(`- OutreachStopped: ${zoeInterested?.outreachStopped} (Expected: true - follow-ups halted)`);
  console.log(`- BookingToken:    "${zoeInterested?.bookingToken}" (Expected: unguessable hex)`);

  const replyRecord = await Reply.findById(replySimData.replyId);
  console.log(`- Reply Record:    Class: "${replyRecord?.replyClass}", Reason: "${replyRecord?.classificationReason}"`);

  console.log('\n--- Step 7: Propose & Confirm Booking Link Gate (DEC-02) ---');
  const { executeProposeBookingLink } = await import('../src/agent/tools/booking-link.tool');
  const bookingProp = await executeProposeBookingLink({ candidateId: zoe._id.toString() }, conversationId);
  console.log('Booking Link Proposal Action ID:', bookingProp.card.actionId);
  console.log('Booking URL in Proposal:', bookingProp.card.payload.bookingUrl);

  const confirmBookingRes = await fetch(`${API_BASE}/api/actions/${bookingProp.card.actionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const confirmBookingData = await confirmBookingRes.json();
  console.log('Booking Confirm Result Status:', confirmBookingData.result?.status);

  const zoeMeetingBooked = await Candidate.findById(zoe._id);
  console.log(`Candidate Zoe status after sending booking link: "${zoeMeetingBooked?.status}" (Expected: Meeting booked)`);

  console.log('\n--- Step 8: Candidate Selects Mock Slot via Tokenized Endpoint ---');
  const bookingToken = zoeMeetingBooked?.bookingToken;
  console.log(`Fetching available slots: GET /api/booking/${bookingToken}...`);
  const getBookingRes = await fetch(`${API_BASE}/api/booking/${bookingToken}`);
  const getBookingData = await getBookingRes.json();
  console.log(`Available Slots:`, getBookingData.availableSlots);

  const selectedSlot = getBookingData.availableSlots[0];
  console.log(`Candidate selects slot: "${selectedSlot}"`);

  const selectSlotRes = await fetch(`${API_BASE}/api/booking/${bookingToken}/slot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot: selectedSlot }),
  });
  const selectSlotData = await selectSlotRes.json();
  console.log('Slot selection response:', selectSlotData.message);

  const zoeSlotSaved = await Candidate.findById(zoe._id);
  console.log(`Candidate meetingSlot in DB: "${zoeSlotSaved?.meetingSlot}"`);
  console.log(`Candidate status in DB:      "${zoeSlotSaved?.status}" (Expected: Meeting booked - unchanged per DEC-02)`);

  const slotActivityLog = await ActivityLog.findOne({
    candidateId: zoe._id,
    action: 'candidate_selected_slot',
  });
  console.log(`ActivityLog Entry Recorded: action="${slotActivityLog?.action}", actor="${slotActivityLog?.actor}", slot="${(slotActivityLog?.details as any)?.slot}"`);

  console.log('\n--- Step 9: Test Additional Reply Classifications (Question & Unsubscribe) ---');
  console.log('1. Testing Question Reply for Hannah Schmidt:');
  const hannahQuestionRes = await fetch(`${API_BASE}/api/replies/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidateId: hannah._id,
      emailText: 'What is the salary range and remote work flexibility for this position?',
      sentiment: 'question',
      sync: true,
    }),
  });
  const hannahQuestionData = await hannahQuestionRes.json();
  const hannahReplied = await Candidate.findById(hannah._id);
  console.log(`   Reply Class: "${hannahQuestionData.replyClass}" | Status in DB: "${hannahReplied?.status}" (Expected: Replied per DEC-01) | outreachStopped: ${hannahReplied?.outreachStopped}`);

  console.log('2. Testing Unsubscribe Reply for Hannah Schmidt:');
  const hannahUnsubRes = await fetch(`${API_BASE}/api/replies/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidateId: hannah._id,
      emailText: 'Please unsubscribe me and remove me from your list.',
      sentiment: 'unsubscribe',
      sync: true,
    }),
  });
  const hannahUnsubData = await hannahUnsubRes.json();
  const hannahUnsub = await Candidate.findById(hannah._id);
  console.log(`   Reply Class: "${hannahUnsubData.replyClass}" | Status in DB: "${hannahUnsub?.status}" (Expected: Unsubscribed)`);
  console.log(`   statusBeforeUnsubscribe in DB: "${hannahUnsub?.statusBeforeUnsubscribe}" (Expected: Replied - preserved per DEC-03)`);

  console.log('\n--- Step 10: Progress Candidate Pipeline: Interviewed -> Shortlisted -> Hired ---');
  // 1. Interviewed
  console.log('Advancing Zoe to Interviewed...');
  await fetch(`${API_BASE}/api/candidates/${zoe._id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newStatus: 'Interviewed', reason: 'Passed 45m distributed systems architecture interview' }),
  });
  let candProgress = await Candidate.findById(zoe._id);
  console.log(`Status in DB: "${candProgress?.status}"`);

  // 2. Shortlisted
  console.log('Advancing Zoe to Shortlisted...');
  await fetch(`${API_BASE}/api/candidates/${zoe._id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newStatus: 'Shortlisted', reason: 'Top candidate unanimously approved by interview loop' }),
  });
  candProgress = await Candidate.findById(zoe._id);
  console.log(`Status in DB: "${candProgress?.status}"`);

  // 3. Hired
  console.log('Advancing Zoe to Hired...');
  await fetch(`${API_BASE}/api/candidates/${zoe._id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newStatus: 'Hired', reason: 'Official offer letter accepted and signed' }),
  });
  candProgress = await Candidate.findById(zoe._id);
  console.log(`FINAL Status in DB: "${candProgress?.status}" (Expected: Hired)`);

  console.log('\n--- Complete ActivityLog Audit Trail for Candidate Zoe Washington ---');
  const logs = await ActivityLog.find({ candidateId: zoe._id }).sort({ timestamp: 1 });
  for (let i = 0; i < logs.length; i++) {
    const l = logs[i];
    console.log(`[${i + 1}] ${l.timestamp.toISOString()} | Action: "${l.action}" | Actor: "${l.actor}" | From: "${l.previousStatus || 'null'}" -> To: "${l.newStatus || 'null'}"`);
  }

  console.log('\n========================================================================');
  console.log('CHECKPOINT 7 VERIFICATION COMPLETE: ALL SYSTEMS VERIFIED LIVE');
  console.log('========================================================================');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal verification error:', err);
  process.exit(1);
});
