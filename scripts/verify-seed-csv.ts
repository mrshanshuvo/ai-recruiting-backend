import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { Job, Candidate, Message } from '../src/models';
import { env } from '../src/config/env';

const API_BASE = 'http://localhost:4000';

async function main() {
  await mongoose.connect(env.MONGO_URI);
  console.log('--- Testing Seed CSV Upload ---');

  // 1. Create a clean job in MongoDB
  const job = await Job.create({
    title: 'Staff Distributed Systems Engineer (CSV Seed Test)',
    rawDescription: 'Testing seed CSV upload with duplicate and no-email candidates.',
    mustHaveSkills: ['React', 'TypeScript', 'Distributed Systems'],
    seniority: 'Staff',
    location: 'Remote',
    remotePolicy: 'Remote',
    status: 'OPEN',
  });
  console.log('Created test job:', job._id.toString());

  // 2. Create a conversation via API
  const convRes = await fetch(`${API_BASE}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const conversationId = (await convRes.json()).conversationId;
  console.log('Created conversation:', conversationId);

  // 3. Upload the 12-row seed CSV
  const csvPath = path.resolve(__dirname, '../src/data/sample-candidates.csv');
  const fileContent = fs.readFileSync(csvPath);
  const blob = new Blob([fileContent], { type: 'text/csv' });
  const formData = new FormData();
  formData.append('file', blob, 'sample-candidates.csv');
  formData.append('conversationId', conversationId);

  const uploadRes = await fetch(`${API_BASE}/api/jobs/${job._id}/candidates/upload-csv`, {
    method: 'POST',
    body: formData,
  });
  const uploadJson = await uploadRes.json();
  console.log('\n--- HTTP Response from CSV Upload ---');
  console.log(JSON.stringify(uploadJson, null, 2));

  // 4. Fetch the chat message generated in conversation
  const msgsRes = await fetch(`${API_BASE}/api/chat/messages/${conversationId}`);
  const messages = (await msgsRes.json()).messages;
  console.log('\n--- Chat Message in Conversation ---');
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const p of m.parts || []) {
        if (p.type === 'text') console.log(`[Assistant]: ${p.text}`);
      }
    }
  }

  // 5. Fetch candidates in DB
  const cands = await Candidate.find({ jobId: job._id }).lean();
  console.log(`\n--- DB Results (${cands.length} total candidates stored in DB for this job) ---`);
  for (const c of cands) {
    console.log(`- ${c.fullName} | Email: ${c.email || 'NO EMAIL'} | Status: ${c.status} | EmailStatus: ${c.emailStatus} | Source: ${c.source}`);
  }

  await mongoose.disconnect();
}

main().catch(console.error);
