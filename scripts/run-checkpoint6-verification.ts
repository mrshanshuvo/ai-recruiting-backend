import mongoose from 'mongoose';
import { env } from '../src/config/env';

const API_BASE = 'http://localhost:4000';

async function main() {
  await mongoose.connect(env.MONGO_URI);
  console.log('Connected to MongoDB via Mongoose');
  console.log('====================================================');
  console.log('CHECKPOINT 6 LIVE END-TO-END OUTREACH VERIFICATION');
  console.log('====================================================');

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
  console.log('Job Proposal PendingAction ID:', jobActionId);

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
  console.log('Sourcing Proposal PendingAction ID:', sourceActionId);

  await fetch(`${API_BASE}/api/actions/${sourceActionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  console.log('Sourcing confirmed. Waiting for background scoring...');

  // Poll until candidates are scored
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

  console.log('\n--- Step 4: Accept 3 Candidates with Valid Emails ---');
  const validEmailCandidates = candidates
    .filter((c: any) => c.email && c.emailStatus === 'valid')
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 3);

  console.log(`Selected ${validEmailCandidates.length} high-scoring candidates to accept:`);
  for (const c of validEmailCandidates) {
    console.log(`- ${c.fullName} (${c._id}) | Score: ${c.score} | Email: ${c.email}`);
    await fetch(`${API_BASE}/api/candidates/${c._id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newStatus: 'Accepted', reason: 'Qualified for outreach campaign' }),
    });
  }

  console.log('Waiting 25s for Gemini rate limit cooldown...');
  await new Promise((r) => setTimeout(r, 25000));

  console.log('\n--- Step 5: Propose Outreach Campaign in Chat ---');
  console.log('Sending chat message: "Draft an outreach campaign for the accepted candidates."');
  await fetch(`${API_BASE}/api/chat/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId,
      text: 'Draft an outreach campaign for the accepted candidates.',
    }),
  });

  const msgsRes3 = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
  const msgs3 = (await msgsRes3.json()).messages;
  const assistantMsg3 = msgs3[msgs3.length - 1];

  let campaignActionId: string | undefined;
  let campaignPayload: any = null;

  for (const p of assistantMsg3.parts || []) {
    if (p.type === 'text') console.log('[Assistant Text]:', p.text);
    if (p.type === 'card' && p.card.cardType === 'campaign_preview') {
      console.log('[Card Type]:', p.card.cardType);
      console.log('[Card Status]:', p.card.status);
      console.log('[Action ID]:', p.card.actionId);
      campaignActionId = p.card.actionId;
      campaignPayload = p.card.payload;
    }
  }

  console.log(`Enrolled Recipient Count in Proposal: ${campaignPayload?.recipientCount}`);
  console.log(`Steps in Sequence: ${campaignPayload?.steps?.length}`);
  for (const s of campaignPayload?.steps || []) {
    console.log(`  - Step ${s.stepIndex} (${s.delayDays === 0 ? 'Day 0' : `Day ${s.delayDays}`}): "${s.subject}"`);
  }

  console.log('\n--- Step 6: Confirmation Gate Check - Verify DB State BEFORE Confirm ---');
  const { execSync } = await import('child_process');
  const checkBefore = execSync(
    `docker exec -i recruiting_mongo_dev mongosh --quiet ai-recruiting-co-worker --eval "
      const campaigns = db.campaigns.countDocuments({ jobId: ObjectId('${jobId}') });
      const outreach = db.outreachmessages.countDocuments({ jobId: ObjectId('${jobId}') });
      print(JSON.stringify({ campaigns, outreach }));
    "`
  ).toString();
  console.log('Database state BEFORE confirm (Gate Verification):', checkBefore.trim());

  console.log('\n--- Step 7: Edit Subject Line via Autosave (DEC-17) ---');
  const updatedSteps = [...campaignPayload.steps];
  updatedSteps[0].subject = 'Staff Distributed Systems Engineer - Leading Real-Time Infrastructure at Aironauts';
  const patchRes = await fetch(`${API_BASE}/api/actions/${campaignActionId}/payload`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      editedPayload: {
        ...campaignPayload,
        steps: updatedSteps,
      },
    }),
  });
  console.log('Autosaved payload status:', patchRes.status);

  console.log('Waiting 10s cooldown before confirmation...');
  await new Promise((r) => setTimeout(r, 10000));

  console.log('\n--- Step 8: Confirm Campaign via "Approve & Send" Button / Chat ---');
  console.log('Sending chat confirmation: "Approve & Send"');
  await fetch(`${API_BASE}/api/chat/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, text: 'Approve & Send' }),
  });

  const msgsRes4 = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
  const msgs4 = (await msgsRes4.json()).messages;
  const assistantMsg4 = msgs4[msgs4.length - 1];
  console.log('Assistant Confirmation Reply:');
  for (const p of assistantMsg4.parts || []) {
    if (p.type === 'text') console.log('[Assistant Text]:', p.text);
  }

  console.log('\n--- Step 9: Verify Campaign Creation & Step 0 Sending in DB ---');
  // Wait 8 seconds for Step 0 BullMQ execution and email delivery
  await new Promise((r) => setTimeout(r, 8000));

  const checkAfter = execSync(
    `docker exec -i recruiting_mongo_dev mongosh --quiet ai-recruiting-co-worker --eval "
      const campaign = db.campaigns.findOne({ jobId: ObjectId('${jobId}') });
      const steps = db.campaignsteps.find({ campaignId: campaign._id }).toArray();
      const messages = db.outreachmessages.find({ campaignId: campaign._id }).toArray();
      print(JSON.stringify({
        campaign: { id: campaign._id, name: campaign.name, status: campaign.status },
        stepsCount: steps.length,
        messages: messages.map(m => ({
          toEmail: m.toEmail,
          stepIndex: m.stepIndex,
          status: m.status,
          sentAt: m.sentAt,
          previewUrl: m.previewUrl,
          subject: m.subject
        }))
      }, null, 2));
    "`
  ).toString();
  console.log('Database state AFTER confirm:');
  console.log(checkAfter);

  console.log('\n--- Step 10: Verify Candidate Status Transitioned to "Contacted" ---');
  const candsContacted = execSync(
    `docker exec -i recruiting_mongo_dev mongosh --quiet ai-recruiting-co-worker --eval "
      const cands = db.candidates.find({ jobId: ObjectId('${jobId}'), status: 'Contacted' }).toArray();
      print(JSON.stringify(cands.map(c => ({
        fullName: c.fullName,
        email: c.email,
        status: c.status,
        contactedAt: c.contactedAt
      })), null, 2));
    "`
  ).toString();
  console.log('Contacted Candidates in DB:');
  console.log(candsContacted);

  console.log('\n--- Step 11: Verify Accelerated Sequence (Day 3 Follow-Up in Demo Mode) ---');
  if (env.OUTREACH_STEP_DELAY_UNIT === 'seconds') {
    console.log('OUTREACH_STEP_DELAY_UNIT is "seconds" (demo mode). Waiting 6 seconds for Day 3 follow-up job to trigger...');
    await new Promise((r) => setTimeout(r, 6000));

    const checkStep1 = execSync(
      `docker exec -i recruiting_mongo_dev mongosh --quiet ai-recruiting-co-worker --eval "
        const messages = db.outreachmessages.find({ stepIndex: 1 }).toArray();
        print(JSON.stringify(messages.map(m => ({
          toEmail: m.toEmail,
          stepIndex: m.stepIndex,
          status: m.status,
          sentAt: m.sentAt,
          previewUrl: m.previewUrl
        })), null, 2));
      "`
    ).toString();
    console.log('Step 1 Follow-Up Messages execution in DB:');
    console.log(checkStep1);
  }

  console.log('\n--- Step 12: Verify Campaign Pause & Resume Controls ---');
  const campObj = JSON.parse(
    execSync(
      `docker exec -i recruiting_mongo_dev mongosh --quiet ai-recruiting-co-worker --eval "
        const camp = db.campaigns.findOne({ jobId: ObjectId('${jobId}') });
        print(JSON.stringify({ id: camp._id.toString() }));
      "`
    ).toString()
  );
  const campId = campObj.id;

  // Pause
  const pausePropRes = await (await import('../src/agent/tools/campaign-lifecycle.tool')).executePauseCampaign(
    { campaignId: campId },
    conversationId
  );
  console.log('Pause Proposal Action ID:', pausePropRes.card.actionId);
  await (await import('../src/services/pending-action.service')).PendingActionService.confirmAction(
    pausePropRes.card.actionId,
    conversationId
  );

  const pausedStatus = execSync(
    `docker exec -i recruiting_mongo_dev mongosh --quiet ai-recruiting-co-worker --eval "
      const camp = db.campaigns.findOne({ _id: ObjectId('${campId}') });
      print(camp.status);
    "`
  ).toString().trim();
  console.log('Campaign status after pause:', pausedStatus);

  // Resume
  const resumePropRes = await (await import('../src/agent/tools/campaign-lifecycle.tool')).executeResumeCampaign(
    { campaignId: campId },
    conversationId
  );
  console.log('Resume Proposal Action ID:', resumePropRes.card.actionId);
  await (await import('../src/services/pending-action.service')).PendingActionService.confirmAction(
    resumePropRes.card.actionId,
    conversationId
  );

  const resumedStatus = execSync(
    `docker exec -i recruiting_mongo_dev mongosh --quiet ai-recruiting-co-worker --eval "
      const camp = db.campaigns.findOne({ _id: ObjectId('${campId}') });
      print(camp.status);
    "`
  ).toString().trim();
  console.log('Campaign status after resume:', resumedStatus);

  console.log('====================================================');
  console.log('CHECKPOINT 6 VERIFICATION COMPLETE');
  console.log('====================================================');
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(console.error);

