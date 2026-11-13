import fs from 'fs';
import path from 'path';

const API_BASE = 'http://localhost:4000';

async function main() {
  console.log('=== Step 1: Create Conversation ===');
  const convRes = await fetch(`${API_BASE}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const convData = await convRes.json();
  console.log('Conversation:', convData);
  const conversationId = convData.conversationId;

  console.log('\n=== Step 2: Post Seed JD to Chat ===');
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

  const msgRes = await fetch(`${API_BASE}/api/chat/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, text: seedJd }),
  });
  const msgData = await msgRes.json();
  console.log('Assistant response to JD post:');
  console.dir(msgData, { depth: 5 });

  // Fetch latest messages in conversation to find the card
  const convMsgsRes = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
  const convMsgsData = await convMsgsRes.json();
  const allMsgs = convMsgsData.messages || [];

  console.log('Fetched messages from conversation:');
  console.dir(allMsgs, { depth: 5 });

  let jobActionId: string | undefined;
  for (const m of allMsgs.slice().reverse()) {
    if (m.role === 'assistant' && m.parts) {
      for (const part of m.parts) {
        if (part.type === 'card' && part.card && (part.card.actionId || part.card.pendingActionId)) {
          jobActionId = part.card.actionId || part.card.pendingActionId;
          break;
        }
      }
      if (jobActionId) break;
    }
  }

  if (!jobActionId) {
    console.error('ERROR: No pendingActionId found in card response!');
    process.exit(1);
  }
  console.log('Found Job Proposal PendingAction ID:', jobActionId);

  console.log('\n=== Step 3: Confirm Job Creation ===');
  const confirmRes = await fetch(`${API_BASE}/api/actions/${jobActionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const confirmData = await confirmRes.json();
  console.log('Confirm Response:', confirmData);
  const jobId = confirmData.result?.jobId || confirmData.data?.result?.jobId || confirmData.result?._id;
  console.log('Confirmed Job ID:', jobId);

  console.log('\n=== Step 4: Propose Candidate Sourcing ===');
  const sourceMsgRes = await fetch(`${API_BASE}/api/chat/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, text: 'Please source 10 candidates for this job.' }),
  });
  const sourceMsgData = await sourceMsgRes.json();
  console.log('Assistant response to Sourcing request:');
  console.dir(sourceMsgData, { depth: 5 });

  // Fetch latest messages in conversation to find the sourcing card
  const sourceMsgsRes = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
  const sourceMsgsData = await sourceMsgsRes.json();
  const allSourceMsgs = sourceMsgsData.messages || [];

  let sourceActionId: string | undefined;
  for (const m of allSourceMsgs.slice().reverse()) {
    if (m.role === 'assistant' && m.parts) {
      for (const part of m.parts) {
        if (part.type === 'card' && part.card && (part.card.actionId || part.card.pendingActionId)) {
          sourceActionId = part.card.actionId || part.card.pendingActionId;
          break;
        }
      }
      if (sourceActionId) break;
    }
  }

  if (!sourceActionId) {
    console.error('ERROR: No pendingActionId found for sourcing proposal!');
    process.exit(1);
  }
  console.log('Found Sourcing PendingAction ID:', sourceActionId);

  console.log('\n=== Step 5: Confirm Sourcing ===');
  const confirmSourceRes = await fetch(`${API_BASE}/api/actions/${sourceActionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const confirmSourceData = await confirmSourceRes.json();
  console.log('Confirm Sourcing Response:', confirmSourceData);

  console.log('\n=== Step 6: Polling for Sourcing & Scoring Completion ===');
  let scoringDone = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const candsRes = await fetch(`${API_BASE}/api/jobs/${jobId}/candidates?limit=20`);
    const candsData = await candsRes.json();
    const cands = candsData.candidates || [];
    const scoredCount = cands.filter((c: any) => c.scoreStatus === 'scored' || c.scoreStatus === 'failed').length;
    console.log(`Poll ${i + 1}: ${cands.length} candidates in DB, ${scoredCount} scored/failed`);

    if (cands.length >= 10 && scoredCount >= 10) {
      scoringDone = true;
      console.log('All 10 candidates scored successfully!');
      console.log('\nSample scored candidates:');
      for (const cand of cands.slice(0, 5)) {
        console.log(`- ${cand.fullName} (${cand.currentTitle} @ ${cand.currentCompany}): Score=${cand.score}, Reasoning="${cand.scoreReasoning || cand.scoreRationale}"`);
      }
      break;
    }
  }

  if (!scoringDone) {
    console.warn('Timed out waiting for all 10 candidates to be scored.');
  }

  console.log('\n=== Step 7: Checking Assistant Scoring Summary Message ===');
  const convHistoryRes = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
  const convHistoryData = await convHistoryRes.json();
  const messages = convHistoryData.messages || [];
  console.log('All Conversation Messages:');
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'text') {
        console.log(`[${m.role}] ${p.text}`);
      } else if (p.type === 'card') {
        console.log(`[${m.role} CARD: ${p.card.type}] PendingAction=${p.card.pendingActionId} Status=${p.card.status}`);
      }
    }
  }

  console.log('\n=== Step 8: Upload Seed CSV (sample-candidates.csv) ===');
  const csvPath = path.resolve(__dirname, '../src/data/sample-candidates.csv');
  const csvContent = fs.readFileSync(csvPath);

  const formData = new FormData();
  formData.append('file', new Blob([csvContent], { type: 'text/csv' }), 'sample-candidates.csv');

  const uploadRes = await fetch(`${API_BASE}/api/jobs/${jobId}/candidates/upload-csv?conversationId=${conversationId}`, {
    method: 'POST',
    body: formData,
  });
  const uploadData = await uploadRes.json();
  console.log('CSV Upload HTTP Response:');
  console.dir(uploadData, { depth: 5 });

  console.log('\n=== Step 9: Check Conversation for CSV Ingestion Chat Message ===');
  const updatedHistoryRes = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
  const updatedHistoryData = await updatedHistoryRes.json();
  const updatedMsgs = updatedHistoryData.messages || [];
  const lastMsg = updatedMsgs[updatedMsgs.length - 1];
  console.log('Latest Message in Conversation:');
  console.dir(lastMsg, { depth: 5 });
}

main().catch(console.error);
