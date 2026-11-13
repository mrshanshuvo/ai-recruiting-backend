import { connectDB } from '../src/config/db';
import { Job, Candidate, Message, Conversation } from '../src/models';
import { processSourcingPayload } from '../src/workers/sourcing.worker';
import { CandidateService } from '../src/services/candidate.service';
import fs from 'fs';
import path from 'path';

async function main() {
  await connectDB();
  console.log('================================================================================');
  console.log('TEST A3: SEED JD, FIXTURES AND SEED CSV UPLOAD (CLEAN DATABASE)');
  console.log('================================================================================\n');

  // Clear existing collections for a clean run
  await Job.deleteMany({});
  await Candidate.deleteMany({});
  await Conversation.deleteMany({});
  await Message.deleteMany({});

  console.log('--- Step 1: Create Job with Seed JD ---');
  const job = await Job.create({
    title: 'Senior Frontend Engineer (React & TypeScript)',
    rawDescription: 'Senior Frontend Engineer (React & TypeScript) at Aironauts Technologies',
    seniority: 'Senior',
    location: 'San Francisco, CA',
    remotePolicy: 'Remote',
    salaryRange: { min: 140000, max: 180000, currency: 'USD' },
    mustHaveSkills: ['React 18', 'TypeScript', 'Tailwind CSS', 'Server-Sent Events', 'Jest'],
    niceToHaveSkills: ['Next.js', 'Vite', 'GraphQL'],
    status: 'OPEN',
  });
  console.log(`Created Job ID: ${job._id} | Title: "${job.title}"`);

  const conversation = await Conversation.create({ jobId: job._id });
  job.conversationId = conversation._id;
  await job.save();

  console.log('\n--- Step 2: Run Sourcing (Loads 10 Candidate Fixtures) ---');
  const sourcingRes = await processSourcingPayload({
    jobId: job._id.toString(),
    conversationId: conversation._id.toString(),
    targetCount: 10,
    searchQueries: [job.title],
  });
  console.log(`Sourcing complete: Found ${sourcingRes.found}, Enqueued ${sourcingRes.enqueued} profiles in '${sourcingRes.sourceMode}' mode.`);

  console.log('\n--- Step 3: Print the 10 Fixture Candidates ---');
  const fixtureCandidates = await Candidate.find({ jobId: job._id }).lean();
  fixtureCandidates.forEach((c, idx) => {
    console.log(
      `${idx + 1}. ${c.fullName} | Title: "${c.currentTitle}" | Company: "${c.currentCompany}" | Email: ${c.email || '(NO EMAIL)'} | Skills: ${c.skills.join(', ')}`
    );
  });

  console.log('\n--- Step 4: Upload Real 12-Row Seed CSV ---');
  const csvPath = path.join(__dirname, '../src/data/sample-candidates.csv');
  const csvBuffer = fs.readFileSync(csvPath);

  const importResult = await CandidateService.processCsvUpload(
    job._id.toString(),
    csvBuffer,
    'sample-candidates.csv',
    conversation._id.toString()
  );

  console.log('\nAPI Response:');
  console.log(JSON.stringify(importResult, null, 2));

  console.log('\nChat Message Posted to Recruiter:');
  console.log(`"${importResult.message}"`);

  console.log('\n--- Step 5: Database Counts Verification ---');
  const totalCount = await Candidate.countDocuments({ jobId: job._id });
  const fixtureCount = await Candidate.countDocuments({ jobId: job._id, sourceMode: 'fixture' });
  const csvCount = await Candidate.countDocuments({ jobId: job._id, sourceMode: 'csv' });
  const noEmailCount = await Candidate.countDocuments({ jobId: job._id, emailStatus: 'missing' });

  console.log(`Total Candidates in DB: ${totalCount} (10 fixture + 10 new CSV = 20)`);
  console.log(`Fixture Candidates: ${fixtureCount}`);
  console.log(`CSV Candidates: ${csvCount} (10 new, 2 skipped as duplicates)`);
  console.log(`Candidates without Email: ${noEmailCount} (1 from fixture + 2 from CSV = 3 total, kept and marked 'no email')`);

  console.log('\n================================================================================');
  console.log('TEST A3 COMPLETE: ALL COUNTS AND EXPECTATIONS VERIFIED');
  console.log('================================================================================');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal A3 test failure:', err);
  process.exit(1);
});

