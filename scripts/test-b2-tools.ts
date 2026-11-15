import dotenv from 'dotenv';
dotenv.config();

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, tool } from 'ai';
import { SYSTEM_PROMPT } from '../src/agent/system-prompt';
import { env } from '../src/config/env';

// Schemas
import { parseAndProposeJobInputSchema } from '../src/agent/tools/parse-and-propose-job.tool';
import { requestCandidateSourcingInputSchema } from '../src/agent/tools/request-candidate-sourcing.tool';
import { proposeCandidateReviewInputSchema } from '../src/agent/tools/propose-candidate-review.tool';
import { confirmActionInputSchema } from '../src/agent/tools/confirm-action.tool';
import { cancelActionInputSchema } from '../src/agent/tools/cancel-action.tool';
import { listJobsInputSchema, getJobInputSchema, findCandidatesInputSchema } from '../src/agent/tools/job-tools';
import { showCandidatesInputSchema } from '../src/agent/tools/show-candidates.tool';
import { getCampaignInputSchema, proposeCampaignInputSchema } from '../src/agent/tools/propose-campaign.tool';
import { pauseCampaignInputSchema, resumeCampaignInputSchema } from '../src/agent/tools/campaign-lifecycle.tool';
import { sendBookingLinkInputSchema } from '../src/agent/tools/booking-link.tool';
import { proposeReplyDraftInputSchema } from '../src/agent/tools/propose-reply-draft.tool';
import { updateCandidateStatusInputSchema } from '../src/agent/tools/update-candidate-status.tool';
import { getJobStatsInputSchema } from '../src/agent/tools/get-job-stats.tool';

/**
 * NOTE ON TOOL EXECUTION:
 * In this isolated tool-selection benchmark script, the tool `execute` handlers are
 * intentional stubs (async (input) => input) designed to evaluate and verify prompt-to-tool
 * routing and argument parsing precision without triggering stateful database mutations,
 * BullMQ job queues, or external API side effects.
 * Real tools with full database/worker side effects run in `agent.service.ts` and the live app.
 */
const tools = {
  parse_and_propose_job: tool({
    description: 'Analyzes a job description (JD) or intake request and proposes a new job posting. Returns a job_proposal card for human confirmation.',
    inputSchema: parseAndProposeJobInputSchema,
    execute: async (inp) => inp,
  }),
  request_candidate_sourcing: tool({
    description: 'Triggers candidate sourcing across search, fixtures, and external talent sources for a job posting. Use whenever the user asks to source, find, or search candidates or people for a role or job.',
    inputSchema: requestCandidateSourcingInputSchema,
    execute: async (inp) => inp,
  }),
  propose_candidate_review: tool({
    description: 'Proposes reviewing and accepting or rejecting candidates in bulk (e.g. approve or accept the top N, reject everyone below score). Accepts decision (accept or reject) and topRemainingCount. Requires human confirmation.',
    inputSchema: proposeCandidateReviewInputSchema,
    execute: async (inp) => inp,
  }),
  confirm_action: tool({
    description: 'Confirms and executes an active PendingAction. Use ONLY when the user approves or confirms an active proposed card.',
    inputSchema: confirmActionInputSchema,
    execute: async (inp) => inp,
  }),
  cancel_action: tool({
    description: 'Cancels an active PendingAction proposal card.',
    inputSchema: cancelActionInputSchema,
    execute: async (inp) => inp,
  }),
  list_jobs: tool({
    description:
      'Lists all recruitment job postings in the database. Use ONLY when the recruiter specifically asks to list or see available job openings (e.g. "what open roles are there?"). NEVER use when asking about candidates, applicants, or people, and NEVER invoke as a prerequisite lookup.',
    inputSchema: listJobsInputSchema,
    execute: async (inp) => inp,
  }),
  get_job: tool({
    description: 'Gets full details and criteria for a specific job from the database.',
    inputSchema: getJobInputSchema,
    execute: async (inp) => inp,
  }),
  find_candidates: tool({
    description: 'Searches candidates in the database filtered by job, status, or name.',
    inputSchema: findCandidatesInputSchema,
    execute: async (inp) => inp,
  }),
  show_candidates: tool({
    description:
      'Displays candidate profiles for a job as an interactive candidate_table card in browse mode (sorted by score descending with direct per-row Accept/Reject actions). Use when the recruiter asks to see, view, inspect, or review candidates or applicants. jobId is optional.',
    inputSchema: showCandidatesInputSchema,
    execute: async (inp) => inp,
  }),
  get_campaign: tool({
    description:
      'Retrieves outreach campaign details and email templates for a job. Use ONLY when the user explicitly asks to view or inspect campaign sequence details.',
    inputSchema: getCampaignInputSchema,
    execute: async (inp) => inp,
  }),
  propose_campaign: tool({
    description: 'Proposes an outreach email campaign for Accepted candidates of a job. Returns an interactive campaign_preview card. Use directly when the user asks to start an outreach campaign, draft emails, or email the accepted candidates.',
    inputSchema: proposeCampaignInputSchema,
    execute: async (inp) => inp,
  }),
  pause_campaign: tool({
    description:
      'Proposes pausing an active outreach campaign or stopping/suspending outreach emails. Suspends all scheduled follow-up steps. Use whenever the user asks to pause, stop, hold, or suspend outreach emails or campaigns.',
    inputSchema: pauseCampaignInputSchema,
    execute: async (inp) => inp,
  }),
  resume_campaign: tool({
    description: 'Proposes resuming a paused outreach campaign.',
    inputSchema: resumeCampaignInputSchema,
    execute: async (inp) => inp,
  }),
  send_booking_link: tool({
    description: 'Proposes sending an introductory meeting booking link to an interested candidate.',
    inputSchema: sendBookingLinkInputSchema,
    execute: async (inp) => inp,
  }),
  propose_reply_draft: tool({
    description: 'Proposes an email reply draft to an inbound candidate message.',
    inputSchema: proposeReplyDraftInputSchema,
    execute: async (inp) => inp,
  }),
  update_candidate_status: tool({
    description: 'Proposes advancing or updating a candidate status in the recruitment pipeline (e.g. marking someone as hired, advancing to Interviewed or Shortlisted). Accepts candidateName directly and newStatus. Returns an interactive status_update card.',
    inputSchema: updateCandidateStatusInputSchema,
    execute: async (inp) => inp,
  }),
  get_job_stats: tool({
    description: 'Retrieves live pipeline statistics, funnel metrics, reply rate, interested conversion rates, and token/cost summary for a job. Use directly when the recruiter asks about recruiting progress, status, metrics, reply rate, or job performance.',
    inputSchema: getJobStatsInputSchema,
    execute: async (inp) => inp,
  }),
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function testSentence(sentence: string, expectedTools: string[]): Promise<{ calledTool: string; input: any; ok: boolean }> {
  const google = createGoogleGenerativeAI({
    apiKey: env.GEMINI_API_KEY,
  });

  const primaryModel = env.LLM_MODEL || 'gemini-flash-lite-latest';
  const candidateModels = Array.from(new Set([primaryModel, 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite-preview']));

  let response: any;
  let lastErr: any;
  for (const m of candidateModels) {
    try {
      response = await generateText({
        model: google(m),
        maxRetries: 1,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: sentence }],
        tools: tools as any,
      });
      break;
    } catch (err: any) {
      lastErr = err;
      await delay(1000);
    }
  }

  if (!response) {
    throw lastErr || new Error('All model candidates failed');
  }

  const firstCall = response.toolCalls?.[0];
  const calledTool = firstCall?.toolName || 'none';
  // In ai 4.x / 5.x / 7.x, arguments are stored in .input
  const input = firstCall?.input ?? (firstCall as any)?.args ?? {};
  const ok = expectedTools.includes(calledTool);
  return { calledTool, input, ok };
}

async function run() {
  console.log(`Testing tool selection with model: ${env.LLM_MODEL}`);
  console.log('Script path: apps/backend/scripts/test-b2-tools.ts');
  console.log('Execution Mode: Tool definitions use stubbed execute handlers (pure intent & argument resolution)');
  console.log('----------------------------------------------------------------------');

  const testCases: Array<{ sentence: string; expected: string[]; count: number }> = [
    { sentence: 'go find people for this role', expected: ['request_candidate_sourcing'], count: 3 },
    { sentence: 'who do we have so far', expected: ['show_candidates'], count: 3 },
    { sentence: 'approve the best five', expected: ['propose_candidate_review'], count: 3 },
    { sentence: 'email the accepted ones', expected: ['propose_campaign'], count: 3 },
    { sentence: 'Priya got the job', expected: ['update_candidate_status'], count: 3 },
    { sentence: 'what is our reply rate', expected: ['get_job_stats'], count: 3 },
    { sentence: 'stop the emails for now', expected: ['pause_campaign'], count: 3 },
  ];

  console.log('| Sentence | Expected Tool | Called Tool (with arguments) | OK |');
  console.log('|---|---|---|---|');

  for (const tc of testCases) {
    for (let i = 1; i <= tc.count; i++) {
      try {
        const res = await testSentence(tc.sentence, tc.expected);
        const inputStr = JSON.stringify(res.input);
        console.log(`| "${tc.sentence}" (run ${i}/${tc.count}) | ${tc.expected.join(' or ')} | ${res.calledTool} input: ${inputStr} | ${res.ok ? 'OK' : 'FAIL'} |`);
      } catch (err: any) {
        console.log(`| "${tc.sentence}" (run ${i}/${tc.count}) | ${tc.expected.join(' or ')} | ERROR: ${err.message} | FAIL |`);
      }
      await delay(1000);
    }
  }
  console.log('----------------------------------------------------------------------');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
