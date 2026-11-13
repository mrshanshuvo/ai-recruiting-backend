import mongoose from 'mongoose';
import { env } from '../src/config/env';
import { classifyReplyWithLLM, ReplyClassType } from '../src/workers/reply.worker';

interface EvalTestCase {
  id: number;
  expectedClass: ReplyClassType;
  text: string;
}

const testCases: EvalTestCase[] = [
  // 1. Interested (2 cases)
  {
    id: 1,
    expectedClass: 'Interested',
    text: "Hi there, thank you for reaching out! The Staff Distributed Systems Engineer position at Aironauts sounds very exciting. I'd love to learn more about the team and what you are building.",
  },
  {
    id: 2,
    expectedClass: 'Interested',
    text: 'Thanks for the email! I am currently open to exploring senior technical opportunities and would be glad to hear more details about this role.',
  },

  // 2. Not interested (2 cases)
  {
    id: 3,
    expectedClass: 'Not interested',
    text: 'Thanks for thinking of me, but I am very happy with my current team and not looking to make a switch right now. Best of luck with the search!',
  },
  {
    id: 4,
    expectedClass: 'Not interested',
    text: "I appreciate you reaching out, but this role doesn't quite align with my career goals at this time. I will have to pass.",
  },

  // 3. Question (2 cases)
  {
    id: 5,
    expectedClass: 'Question',
    text: 'Hi, thanks for reaching out. Could you share what the expected salary range and remote work flexibility are for this role before we discuss?',
  },
  {
    id: 6,
    expectedClass: 'Question',
    text: 'What primary technologies, languages, and messaging architectures does your data streaming infrastructure rely on?',
  },

  // 4. Wants a meeting (2 cases)
  {
    id: 7,
    expectedClass: 'Wants a meeting',
    text: 'I would be glad to speak with you! Could you please send over a link to schedule a 15-minute introductory chat on my calendar?',
  },
  {
    id: 8,
    expectedClass: 'Wants a meeting',
    text: "Sounds great. I'm available this Thursday afternoon between 2pm and 5pm EST if you want to book some time to talk.",
  },

  // 5. Unsubscribe (2 cases)
  {
    id: 9,
    expectedClass: 'Unsubscribe',
    text: 'Please unsubscribe me from your outreach and remove my email address from your database immediately.',
  },
  {
    id: 10,
    expectedClass: 'Unsubscribe',
    text: 'Stop sending me recruiting emails. Take me off your contact list and do not email me again.',
  },
];

async function main() {
  console.log('='.repeat(80));
  console.log('INBOUND REPLY CLASSIFIER EVALUATION (REAL LLM / TEMPERATURE 0)');
  console.log(`Model: ${env.LLM_MODEL} | Fallback: ${env.LLM_FALLBACK_MODEL}`);
  console.log('='.repeat(80));

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(env.MONGO_URI);
  }

  const results: Array<{
    id: number;
    expected: string;
    predicted: string;
    passed: boolean;
    reason: string;
    text: string;
  }> = [];

  const jobTitle = 'Staff Distributed Systems Engineer';

  for (const testCase of testCases) {
    process.stdout.write(`Evaluating Test Case ${testCase.id}/10 [${testCase.expectedClass}]... `);
    try {
      const classification = await classifyReplyWithLLM(jobTitle, testCase.text);
      const passed = classification.replyClass === testCase.expectedClass;
      results.push({
        id: testCase.id,
        expected: testCase.expectedClass,
        predicted: classification.replyClass,
        passed,
        reason: classification.reason,
        text: testCase.text,
      });
      console.log(passed ? 'PASS' : `FAIL (Got: ${classification.replyClass})`);
      // Short cooling sleep to protect RPM quota
      await new Promise((r) => setTimeout(r, 1200));
    } catch (err: any) {
      console.error(`ERROR:`, err.message);
      results.push({
        id: testCase.id,
        expected: testCase.expectedClass,
        predicted: 'ERROR',
        passed: false,
        reason: err.message,
        text: testCase.text,
      });
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('EVALUATION RESULTS TABLE');
  console.log('='.repeat(80));
  console.log(
    'ID | Expected Class     | Predicted Class    | Status | Short Reason'
  );
  console.log('-'.repeat(80));

  let passCount = 0;
  for (const r of results) {
    if (r.passed) passCount++;
    const idStr = String(r.id).padEnd(2);
    const expStr = r.expected.padEnd(18);
    const predStr = r.predicted.padEnd(18);
    const statusStr = r.passed ? 'PASS  ' : 'FAIL  ';
    const reasonTrunc = r.reason.length > 35 ? r.reason.slice(0, 32) + '...' : r.reason;
    console.log(`${idStr} | ${expStr} | ${predStr} | ${statusStr} | ${reasonTrunc}`);
  }

  console.log('='.repeat(80));
  const accuracy = (passCount / testCases.length) * 100;
  console.log(`TOTAL SCORE: ${passCount}/${testCases.length} (${accuracy.toFixed(1)}% Accuracy)`);
  console.log(`PASS CRITERION: >= 9/10 (90%) -> ${passCount >= 9 ? 'SUCCESS' : 'FAILED'}`);
  console.log('='.repeat(80));

  await mongoose.disconnect();

  if (passCount < 9) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error during evaluation:', err);
  process.exit(1);
});
