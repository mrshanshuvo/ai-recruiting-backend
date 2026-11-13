import mongoose from 'mongoose';

const API_BASE = 'http://localhost:4000';

async function main() {
  console.log('====================================================');
  console.log('CHECKPOINT 5 LIVE VERIFICATION');
  console.log('====================================================');

  console.log('\n--- Step 1: Create Conversation ---');
  const convRes = await fetch(`${API_BASE}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const convData = await convRes.json();
  const conversationId = convData.conversationId;
  console.log('Conversation created:', conversationId);

  console.log('\n--- Step 2: Post Seed JD to Create Job ---');
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
      if (p.type === 'card' && (p.card.actionId || p.card.pendingActionId)) {
        jobActionId = p.card.actionId || p.card.pendingActionId;
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

  console.log('\n--- Step 3: Request & Confirm Sourcing ---');
  await fetch(`${API_BASE}/api/chat/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, text: 'Please source 10 candidates for this job.' }),
  });

  const msgsRes2 = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
  const msgs2 = (await msgsRes2.json()).messages;
  let sourceActionId: string | undefined;
  for (const m of msgs2.slice().reverse()) {
    for (const p of m.parts || []) {
      if (p.type === 'card' && (p.card.actionId || p.card.pendingActionId)) {
        sourceActionId = p.card.actionId || p.card.pendingActionId;
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

  // Poll until 10 candidates are scored
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

  console.log('Waiting 10s for Gemini RPM window to refresh...');
  await new Promise((r) => setTimeout(r, 10000));

  console.log('\n--- Step 4: Show Candidates in Chat (find_candidates) ---');
  const showRes = await fetch(`${API_BASE}/api/chat/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, text: 'What candidates do we have for Senior Frontend Engineer?' }),
  });
  const showData = await showRes.json();
  console.log('Chat message sent:', showData);

  const msgsRes3 = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
  const msgs3 = (await msgsRes3.json()).messages;
  const assistantMsg3 = msgs3[msgs3.length - 1];
  console.log('Assistant Chat Reply (showing real candidates from DB):');
  for (const p of assistantMsg3.parts || []) {
    if (p.type === 'text') console.log(p.text);
  }

  console.log('\n--- Step 5: Direct Button Action (DEC-16) - Accept 2 Candidates ---');
  // Choose candidates 1 and 2 (e.g. highest scored)
  const sorted = [...candidates].sort((a, b) => (b.score || 0) - (a.score || 0));
  const cand1 = sorted[0];
  const cand2 = sorted[1];
  console.log(`Candidate 1 to Accept: ${cand1.fullName} (${cand1._id}), Score=${cand1.score}`);
  console.log(`Candidate 2 to Accept: ${cand2.fullName} (${cand2._id}), Score=${cand2.score}`);

  const patchRes1 = await fetch(`${API_BASE}/api/candidates/${cand1._id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newStatus: 'Accepted', reason: 'Direct review from candidate table card' }),
  });
  const patchData1 = await patchRes1.json();
  console.log('PATCH Candidate 1 Response:', patchData1);

  const patchRes2 = await fetch(`${API_BASE}/api/candidates/${cand2._id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newStatus: 'Accepted', reason: 'Direct review from candidate table card' }),
  });
  const patchData2 = await patchRes2.json();
  console.log('PATCH Candidate 2 Response:', patchData2);

  console.log('\n--- Step 6: Bulk Chat Action - Accept Top 3 Sourced Candidates ---');
  console.log('Waiting 12 seconds for Gemini rate limit cooldown...');
  await new Promise((r) => setTimeout(r, 12000));
  console.log('Sending chat command: "Please accept the top 3 remaining candidates for this job."');
  await fetch(`${API_BASE}/api/chat/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId,
      text: 'Please accept the top 3 remaining candidates for this job.',
    }),
  });

  const msgsRes4 = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
  const msgs4 = (await msgsRes4.json()).messages;
  const assistantMsg4 = msgs4[msgs4.length - 1];
  console.log('Assistant Bulk Review Proposal Reply:');
  let bulkActionId: string | undefined;
  for (const p of assistantMsg4.parts || []) {
    if (p.type === 'text') console.log('Text:', p.text);
    if (p.type === 'card') {
      console.log('Card Type:', p.card.cardType);
      console.log('Card Status:', p.card.status);
      console.log('Action ID:', p.card.actionId);
      console.log('Target Candidates:', p.card.payload?.candidateIds);
      bulkActionId = p.card.actionId;
    }
  }

  console.log('\n--- Step 7: Confirmation Gate Check - Verify DB State BEFORE Confirm ---');
  const candsBeforeConfirm = (await (await fetch(`${API_BASE}/api/jobs/${jobId}/candidates?limit=20`)).json()).candidates;
  console.log('Candidate statuses BEFORE confirm:');
  for (const c of candsBeforeConfirm) {
    console.log(`- ${c.fullName}: Status = "${c.status}"`);
  }

  console.log('\n--- Step 8: Confirm Bulk Action in Chat ("confirm") ---');
  await fetch(`${API_BASE}/api/chat/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, text: 'confirm' }),
  });

  const msgsRes5 = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
  const msgs5 = (await msgsRes5.json()).messages;
  const assistantMsg5 = msgs5[msgs5.length - 1];
  console.log('Assistant Confirmation Reply:');
  for (const p of assistantMsg5.parts || []) {
    if (p.type === 'text') console.log(p.text);
  }

  console.log('\n--- Step 9: Verify DB State AFTER Confirm ---');
  const candsAfterConfirm = (await (await fetch(`${API_BASE}/api/jobs/${jobId}/candidates?limit=20`)).json()).candidates;
  console.log('Candidate statuses AFTER confirm:');
  const acceptedList: string[] = [];
  for (const c of candsAfterConfirm) {
    console.log(`- ${c.fullName}: Status = "${c.status}"`);
    if (c.status === 'Accepted') acceptedList.push(c.fullName);
  }
  console.log(`Total Accepted Candidates now: ${acceptedList.length} (${acceptedList.join(', ')})`);

  console.log('\n--- Step 10: Direct Button Action (DEC-16) - Reject One Candidate ---');
  const candToReject = candsAfterConfirm.find((c: any) => c.status === 'Sourced');
  console.log(`Candidate to Reject: ${candToReject.fullName} (${candToReject._id})`);
  const rejectRes = await fetch(`${API_BASE}/api/candidates/${candToReject._id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newStatus: 'Rejected', reason: 'Candidate lacks required SSE streaming experience' }),
  });
  const rejectData = await rejectRes.json();
  console.log('PATCH Reject Response:', rejectData);

  console.log('\n--- Step 11: Print MongoDB ActivityLog Entries ---');
  const mongoScript = `
    const logs = db.activitylogs.find({ jobId: ObjectId('${jobId}') }).sort({ timestamp: 1 }).toArray();
    print(JSON.stringify(logs, null, 2));
  `;
  const { execSync } = await import('child_process');
  const mongoOut = execSync(
    `docker exec -i recruiting_mongo_dev mongosh --quiet ai-recruiting-co-worker --eval "${mongoScript}"`
  ).toString();
  console.log('ActivityLog entries from MongoDB:');
  console.log(mongoOut);

  console.log('====================================================');
  console.log('CHECKPOINT 5 VERIFICATION COMPLETE');
  console.log('====================================================');
}

main().catch(console.error);
