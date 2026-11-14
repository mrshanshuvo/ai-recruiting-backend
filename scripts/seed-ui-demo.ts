/**
 * -----------------------------------------------------------------------------
 * DEVELOPMENT-ONLY SEED SCRIPT (DEC-18 / ADR-0010)
 *
 * NOTICE: This script generates entirely FAKE candidate data, synthetic token
 * records, and mock communication logs strictly for local UI layout inspection.
 * It is NOT part of clean-slate automated testing or production runtime.
 * -----------------------------------------------------------------------------
 */

import mongoose from 'mongoose';
import { env } from '../src/config/env';
import { Job, Candidate, Conversation, Message, OutreachMessage, Campaign, CampaignStep, ActivityLog, TokenUsage } from '../src/models';
import candidateFixtures from '../src/data/candidate-fixtures.json';

async function seed() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(env.MONGO_URI);
  }

  console.log('Seeding demo database for UI inspection...');

  // 1. Create Conversation
  const conversation = await Conversation.create({
    title: 'Senior Frontend Engineer Recruitment',
  });

  // 2. Create Job
  const job = await Job.create({
    title: 'Senior Frontend Engineer (React & TypeScript)',
    department: 'Engineering',
    location: 'San Francisco, CA (Remote Friendly)',
    remotePolicy: 'Remote',
    seniority: 'Senior',
    rawDescription: `Title: Senior Frontend Engineer (React & TypeScript)
Company: Aironauts Technologies
Location: San Francisco, CA (Remote Friendly)
Seniority: Senior
Salary: $140,000 - $180,000 USD + Equity
Work Policy: Remote`,
    mustHaveSkills: ['React 18', 'TypeScript', 'Tailwind CSS', 'Server-Sent Events'],
    niceToHaveSkills: ['Next.js', 'Vite', 'GraphQL'],
    salaryRange: {
      min: 140000,
      max: 180000,
      currency: 'USD',
    },
    status: 'OPEN',
    conversationId: conversation._id,
  });

  conversation.jobId = job._id;
  await conversation.save();

  // 3. Insert 10 Candidate Fixtures
  const insertedCandidates = [];
  for (let i = 0; i < candidateFixtures.length; i++) {
    const f = candidateFixtures[i];
    const status = i === 0 ? 'Contacted' : i === 1 ? 'Accepted' : 'Sourced';
    const c = await Candidate.create({
      jobId: job._id,
      fullName: f.fullName,
      email: f.email || undefined,
      normalizedEmail: f.email ? f.email.toLowerCase().trim() : undefined,
      emailStatus: f.email ? 'valid' : 'missing',
      profileUrl: f.profileUrl,
      normalizedProfileUrl: f.profileUrl.toLowerCase().trim(),
      source: 'search',
      sourceMode: 'fixture',
      currentTitle: f.currentTitle,
      currentCompany: f.currentCompany,
      location: f.location,
      skills: f.skills,
      snippet: f.summary,
      score: 95 - i * 3,
      scoreReason: `Strong match for ${job.title}`,
      scoreStatus: 'scored',
      scoreMissingInfo: [],
      missingInfo: [],
      status,
      contactedAt: status === 'Contacted' ? new Date() : undefined,
      outreachStopped: false,
    });
    insertedCandidates.push(c);
  }

  // 4. Create Campaign & OutreachMessage for Liam Vance (Contacted)
  const campaign = await Campaign.create({
    jobId: job._id,
    conversationId: conversation._id,
    name: 'Outreach Sequence - Senior Frontend',
    status: 'ACTIVE',
    targetCandidateCount: 1,
    dailyLimit: 50,
  });

  const step0 = await CampaignStep.create({
    campaignId: campaign._id,
    stepIndex: 0,
    delayDays: 0,
    subjectTemplate: `Opportunity: Senior Frontend Engineer at Aironauts Technologies`,
    bodyTemplate: `Hi {{candidate.firstName}},\n\n{{personalOpening}}\n\nWe are looking for a Senior Frontend Engineer to lead UI architecture at Aironauts Technologies.\n\nBest,\nAironauts Recruiting`,
  });

  const liam = insertedCandidates[0];
  await OutreachMessage.create({
    jobId: job._id,
    candidateId: liam._id,
    campaignId: campaign._id,
    campaignStepId: step0._id,
    stepIndex: 0,
    toEmail: liam.email || 'liam.vance@example.com',
    status: 'SENT',
    subject: `Opportunity: Senior Frontend Engineer at Aironauts Technologies`,
    body: `Hi Liam,\n\nI noticed your architectural frontend work at Acme Cloud Systems and was really impressed by your depth with React 18, TypeScript, and Server-Sent Events.\n\nWe are looking for a Senior Frontend Engineer to lead UI architecture at Aironauts Technologies.\n\nBest,\nAironauts Recruiting`,
    personalOpening: 'I noticed your architectural frontend work at Acme Cloud Systems and was really impressed by your depth with React 18, TypeScript, and Server-Sent Events.',
    sentAt: new Date(),
  });

  // 5. Create Candidate Table Card Message in Conversation
  const cardRows = insertedCandidates.map((c) => ({
    id: c._id.toString(),
    candidateId: c._id.toString(),
    name: c.fullName,
    fullName: c.fullName,
    title: c.currentTitle,
    company: c.currentCompany,
    score: c.score,
    status: c.status,
    email: c.email,
    profileUrl: c.profileUrl,
    skills: c.skills,
    location: c.location,
  }));

  await Message.create({
    conversationId: conversation._id,
    role: 'user',
    content: 'Please show me the candidates for this role.',
  });

  await Message.create({
    conversationId: conversation._id,
    role: 'assistant',
    content: `Here are the top candidates sourced for the Senior Frontend Engineer position:`,
    parts: [
      {
        type: 'text',
        text: `Here are the top candidates sourced for the Senior Frontend Engineer position:`,
      },
      {
        type: 'card',
        card: {
          cardType: 'candidate_table',
          payload: {
            title: `Candidates for Senior Frontend Engineer`,
            candidates: cardRows,
            mode: 'browse',
            jobId: job._id.toString(),
          },
        },
      },
    ],
  });

  // 6. Log Initial Activity
  await ActivityLog.create({
    jobId: job._id,
    candidateId: liam._id,
    actor: 'system',
    action: 'outreach_sent',
    previousStatus: 'Accepted',
    newStatus: 'Contacted',
    details: {
      stepIndex: 0,
      subject: `Opportunity: Senior Frontend Engineer at Aironauts Technologies`,
    },
    timestamp: new Date(),
  });

  // 7. Insert TokenUsage Records for this Job & Conversation
  await TokenUsage.create({
    jobId: job._id,
    conversationId: conversation._id,
    caller: 'agent',
    model: 'gemini-3.1-flash-lite',
    promptTokens: 4200,
    completionTokens: 850,
    totalTokens: 5050,
    estimatedCostUsd: Number(((4200 * 0.075 + 850 * 0.3) / 1000000).toFixed(6)),
    timestamp: new Date(),
  });

  await TokenUsage.create({
    jobId: job._id,
    conversationId: conversation._id,
    caller: 'worker:scoring',
    model: 'gemini-3.1-flash-lite',
    promptTokens: 12500,
    completionTokens: 1800,
    totalTokens: 14300,
    estimatedCostUsd: Number(((12500 * 0.075 + 1800 * 0.3) / 1000000).toFixed(6)),
    timestamp: new Date(),
  });

  await TokenUsage.create({
    jobId: job._id,
    conversationId: conversation._id,
    caller: 'worker:reply-classification',
    model: 'gemini-3.1-flash-lite',
    promptTokens: 3100,
    completionTokens: 420,
    totalTokens: 3520,
    estimatedCostUsd: Number(((3100 * 0.075 + 420 * 0.3) / 1000000).toFixed(6)),
    timestamp: new Date(),
  });

  console.log(`\nSeed successful!`);
  console.log(`Job ID: ${job._id}`);
  console.log(`Conversation ID: ${conversation._id}`);
  console.log(`Liam Vance ID: ${liam._id}`);
  console.log(`Total Candidates: ${insertedCandidates.length}`);

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('Seed error:', err);
  process.exit(1);
});
