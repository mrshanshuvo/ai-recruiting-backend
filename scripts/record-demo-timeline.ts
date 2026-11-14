import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { env } from '../src/config/env';
import { Job, Candidate, Campaign, OutreachMessage, ActivityLog, PendingAction, Reply, Conversation, TokenUsage } from '../src/models';
import { executeUpdateCandidateStatus } from '../src/agent/tools/update-candidate-status.tool';

const API_BASE = 'http://localhost:4000';
const LOG_FILE = '/tmp/demo-timeline.log';

interface TimelineEntry {
  step: string;
  start: string;
  end: string;
  durationSeconds: number;
  waitingFor: string;
}

function getUtcClockTime(): string {
  const d = new Date();
  return d.toISOString().substring(11, 19);
}

const entries: TimelineEntry[] = [];

async function recordStep<T>(
  stepName: string,
  waitingFor: string,
  fn: () => Promise<T>
): Promise<T> {
  const startClock = getUtcClockTime();
  const startTimeMs = Date.now();
  console.log(`\n>>> START STEP [${stepName}] at ${startClock} (Waiting for: ${waitingFor})`);
  
  const result = await fn();
  
  const endClock = getUtcClockTime();
  const durationSec = Math.round((Date.now() - startTimeMs) / 1000);
  console.log(`<<< END STEP [${stepName}] at ${endClock} (Duration: ${durationSec}s)`);
  
  entries.push({
    step: stepName,
    start: startClock,
    end: endClock,
    durationSeconds: durationSec,
    waitingFor,
  });

  fs.appendFileSync(
    LOG_FILE,
    `[${startClock} -> ${endClock}] (${durationSec}s) ${stepName} | waiting: ${waitingFor}\n`
  );

  return result;
}

async function main() {
  fs.writeFileSync(LOG_FILE, `=== AI RECRUITING CO-WORKER DEMO TIMELINE ===\nStarted: ${new Date().toISOString()}\n\n`);

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(env.MONGO_URI);
  }

  const overallStartTime = Date.now();
  let conversationId = '';
  let jobId = '';
  let campaignId = '';
  let targetCandidates: any[] = [];
  let sarahChen: any;
  let elenaRostova: any;
  let aminaYusuf: any;
  let bookingToken = '';

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

  // 1. JD paste
  await recordStep('1. JD paste', 'LLM: Agent Turn (JD parsing & proposal card generation)', async () => {
    const convRes = await fetch(`${API_BASE}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const convData = await convRes.json();
    conversationId = convData.conversationId;

    await fetch(`${API_BASE}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, text: seedJd }),
    });
  });

  // 2. confirm
  await recordStep('2. confirm', 'HTTP REST: Job Confirmation Gate & DB Persistence', async () => {
    const msgsRes = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
    const msgs = (await msgsRes.json()).messages || [];
    let jobActionId = '';
    for (const m of msgs.slice().reverse()) {
      for (const p of m.parts || []) {
        if (p.type === 'card' && (p.card.actionId || p.card.pendingActionId)) {
          jobActionId = p.card.actionId || p.card.pendingActionId;
          break;
        }
      }
      if (jobActionId) break;
    }

    const confRes = await fetch(`${API_BASE}/api/actions/${jobActionId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const confData = await confRes.json();
    jobId = confData.result?.jobId || confData.result?._id;
  });

  // 3. sourcing
  await recordStep('3. sourcing', 'Worker: BullMQ Candidate Sourcing & Concurrency Scoring', async () => {
    await fetch(`${API_BASE}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, text: `source candidates for it` }),
    });

    let sourceActionId = '';
    for (let poll = 0; poll < 10; poll++) {
      const msgsRes = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
      const msgs = (await msgsRes.json()).messages || [];
      for (const m of msgs.slice().reverse()) {
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

    await fetch(`${API_BASE}/api/actions/${sourceActionId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const cRes = await fetch(`${API_BASE}/api/jobs/${jobId}/candidates`);
      const cData = await cRes.json();
      const scored = (cData.candidates || []).filter((c: any) => c.scoreStatus === 'scored').length;
      if (scored >= 10) break;
    }
  });

  // 4. CSV upload
  await recordStep('4. CSV upload', 'Worker: Multi-Candidate CSV Ingestion & Scoring Queue', async () => {
    const csvPath = path.resolve(__dirname, '../src/data/sample-candidates.csv');
    const fileContent = fs.readFileSync(csvPath);
    const blob = new Blob([fileContent], { type: 'text/csv' });
    const formData = new FormData();
    formData.append('file', blob, 'sample-candidates.csv');
    formData.append('conversationId', conversationId);

    await fetch(`${API_BASE}/api/jobs/${jobId}/candidates/upload-csv`, {
      method: 'POST',
      body: formData,
    });

    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const cRes = await fetch(`${API_BASE}/api/jobs/${jobId}/candidates`);
      const cData = await cRes.json();
      const cands = cData.candidates || [];
      const finished = cands.filter((c: any) => c.scoreStatus === 'scored' || c.scoreStatus === 'failed').length;
      if (cands.length >= 20 && finished >= 20) break;
    }
  });

  // 5. candidate table
  await recordStep('5. candidate table', 'HTTP REST: Candidate Table Query with Filters & Sorting', async () => {
    const cRes = await fetch(`${API_BASE}/api/jobs/${jobId}/candidates?sortBy=score&sortOrder=desc`);
    const cData = await cRes.json();
    const cands = cData.candidates || [];
    sarahChen = cands.find((c: any) => c.fullName === 'Sarah Chen' && c.email) || cands[0];
    elenaRostova = cands.find((c: any) => c.fullName === 'Elena Rostova' && c.email) || cands[1];
    aminaYusuf = cands.find((c: any) => c.fullName === 'Amina Yusuf' && c.email) || cands[2];
    targetCandidates = [sarahChen, elenaRostova, aminaYusuf];
  });

  // 6. accept top 3 in chat
  await recordStep('6. accept top 3 in chat', 'LLM: Agent Turn & Candidate Review Proposal', async () => {
    await fetch(`${API_BASE}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, text: 'accept the top 3' }),
    });

    const msgsRes = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
    const msgs = (await msgsRes.json()).messages || [];
    let reviewActionId = '';
    for (const m of msgs.slice().reverse()) {
      for (const p of m.parts || []) {
        if (p.type === 'card' && p.card?.cardType === 'candidate_review') {
          reviewActionId = p.card.actionId || p.card.pendingActionId;
          break;
        }
      }
      if (reviewActionId) break;
    }

    if (reviewActionId) {
      await fetch(`${API_BASE}/api/actions/${reviewActionId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    } else {
      for (const tc of targetCandidates) {
        await fetch(`${API_BASE}/api/candidates/${tc._id}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newStatus: 'Accepted', reason: 'Top candidate accepted' }),
        });
      }
    }
  });

  // 7. campaign preview & edit subject
  let campaignActionId = '';
  await recordStep('7. campaign preview & edit subject', 'LLM: Outreach Sequence Generation & Personalization', async () => {
    await fetch(`${API_BASE}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, text: 'create an outreach campaign for accepted candidates' }),
    });

    const msgsRes = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
    const msgs = (await msgsRes.json()).messages || [];
    for (const m of msgs.slice().reverse()) {
      for (const p of m.parts || []) {
        if (p.type === 'card' && p.card?.cardType === 'campaign_preview') {
          campaignActionId = p.card.actionId || p.card.pendingActionId;
          break;
        }
      }
      if (campaignActionId) break;
    }

    // Edit step 0 subject
    await fetch(`${API_BASE}/api/actions/${campaignActionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        editedPayload: {
          stepTemplates: [
            {
              step: 0,
              delayDays: 0,
              subject: 'Exclusive: Lead Senior Frontend Architecture at Aironauts',
              bodyTemplate: 'Hi {{firstName}},\n\nWe love your background in React 18.\n\nBest,\nRecruiting Team',
            },
          ],
        },
      }),
    });
  });

  // 8. approve & send
  await recordStep('8. approve & send', 'Worker: BullMQ Campaign Scheduling & Email Dispatch', async () => {
    const confRes = await fetch(`${API_BASE}/api/actions/${campaignActionId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const confData = await confRes.json();
    campaignId = confData.result?.campaignId;

    // Wait for step 0 sent
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const contacted = await Candidate.countDocuments({
        _id: { $in: targetCandidates.map((c) => c._id) },
        status: 'Contacted',
      });
      if (contacted >= targetCandidates.length) break;
    }
  });

  // 9. follow-ups
  await recordStep('9. follow-ups', 'Worker: Delayed Follow-Up Messages Staged in Queue', async () => {
    const queuedCount = await OutreachMessage.countDocuments({
      campaignId: new mongoose.Types.ObjectId(campaignId),
      status: 'QUEUED',
    });
    console.log(`Queued follow-up outreach messages count: ${queuedCount}`);
  });

  // 10. simulate 3 replies (Wants a meeting, Question, Unsubscribe)
  let bookingActionId = '';
  await recordStep('10. simulate 3 replies', 'Worker: BullMQ Inbound Reply Triage & Follow-up Cancellation', async () => {
    // Reply 1: Wants a meeting (Sarah Chen)
    await fetch(`${API_BASE}/simulate-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidateId: sarahChen._id,
        message: 'I would be happy to schedule a 15-minute introductory conversation. Please send a calendar link.',
      }),
    });

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const cand = await Candidate.findById(sarahChen._id).lean();
      const action = await PendingAction.findOne({
        'payload.candidateId': sarahChen._id.toString(),
        actionType: 'SEND_BOOKING_LINK',
        status: 'PENDING',
      }).lean();
      if (cand?.status === 'Interested' && action) {
        bookingActionId = action._id.toString();
        bookingToken = cand.bookingToken || '';
        break;
      }
    }

    // Reply 2: Question (Elena Rostova)
    await fetch(`${API_BASE}/simulate-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidateId: elenaRostova._id,
        message: 'Could you tell me more about the salary range and remote work flexibility?',
      }),
    });

    // Reply 3: Unsubscribe (Amina Yusuf)
    await fetch(`${API_BASE}/simulate-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidateId: aminaYusuf._id,
        message: 'Please unsubscribe me from future emails.',
      }),
    });

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const uCand = await Candidate.findById(aminaYusuf._id).lean();
      if (uCand?.status === 'Unsubscribed') break;
    }
  });

  // 11. booking link & slot page
  await recordStep('11. booking link & slot page', 'Worker & HTTP REST: Booking Invitation & Candidate Reservation', async () => {
    // Confirm booking action
    await fetch(`${API_BASE}/api/actions/${bookingActionId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    // Query candidate offered slots
    const cand = await Candidate.findById(sarahChen._id).lean();
    const offeredSlots = cand?.offeredSlots || [];
    const selectedSlot = offeredSlots[0] || 'Monday, Nov 16, 2026 at 10:00 UTC';

    // Submit slot selection
    await fetch(`${API_BASE}/api/booking/${bookingToken}/slot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: selectedSlot }),
    });
  });

  // 12. Hired
  await recordStep('12. Hired', 'LLM & DB: Sequential Advancement to Interviewed -> Shortlisted -> Hired', async () => {
    await executeUpdateCandidateStatus(
      { candidateName: 'Sarah Chen', newStatus: 'Interviewed', reason: 'Technical loop completed' },
      conversationId
    );
    await executeUpdateCandidateStatus(
      { candidateName: 'Sarah Chen', newStatus: 'Shortlisted', reason: 'Offer approved' },
      conversationId
    );
    await fetch(`${API_BASE}/api/candidates/${sarahChen._id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newStatus: 'Hired', reason: 'Signed offer letter' }),
    });
  });

  // 13. stats in chat & dashboard
  await recordStep('13. stats in chat & dashboard', 'LLM & REST: Chat Stats Query & Dashboard Funnel Audit', async () => {
    await fetch(`${API_BASE}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, text: 'how is the React job going?' }),
    });

    await fetch(`${API_BASE}/api/jobs/${jobId}/stats`);
  });

  // 14. activity log
  await recordStep('14. activity log', 'HTTP REST: Audit Timeline & Cursor-Based Pagination', async () => {
    const actRes = await fetch(`${API_BASE}/api/jobs/${jobId}/activity?limit=5`);
    const actData = await actRes.json();
    if (actData.nextCursor) {
      await fetch(`${API_BASE}/api/jobs/${jobId}/activity?cursor=${actData.nextCursor}&limit=5`);
    }
  });

  // 15. pause/resume
  await recordStep('15. pause/resume', 'HTTP REST & BullMQ: Campaign Pause & Resume Execution', async () => {
    await fetch(`${API_BASE}/api/campaigns/${campaignId}/pause`, { method: 'POST' });
    await fetch(`${API_BASE}/api/campaigns/${campaignId}/resume`, { method: 'POST' });
  });

  const overallDurationSec = Math.round((Date.now() - overallStartTime) / 1000);
  const overallMinutes = (overallDurationSec / 60).toFixed(1);

  console.log('\n' + '='.repeat(80));
  console.log('ITEM C8: MEASURED DEMO TIMELINE TABLE');
  console.log(`Overall Duration: ${overallDurationSec}s (${overallMinutes} minutes, limit <= 9 minutes)`);
  console.log('='.repeat(80));
  console.log('| Step | Start | End | Duration | Waiting for LLM or worker |');
  console.log('|---|---|---|---|---|');

  for (const e of entries) {
    console.log(`| ${e.step} | ${e.start} | ${e.end} | ${e.durationSeconds}s | ${e.waitingFor} |`);
  }
  console.log('='.repeat(80));

  fs.appendFileSync(
    LOG_FILE,
    `\nTotal Duration: ${overallDurationSec}s (${overallMinutes} min) - Constraint: <= 9 min - STATUS: ${overallDurationSec <= 540 ? 'PASS' : 'FAIL'}\n`
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Demo timeline execution failed:', err);
  process.exit(1);
});
