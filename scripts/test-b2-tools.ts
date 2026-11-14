import dotenv from 'dotenv';
dotenv.config();

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, tool } from 'ai';
import { z } from 'zod';
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

const tools = {
  parse_and_propose_job: tool({
    description: 'Analyzes a job description (JD) or intake request and proposes a new job posting. Returns a job_proposal card for human confirmation.',
    parameters: parseAndProposeJobInputSchema,
    execute: async () => ({ success: true }),
  }),
  request_candidate_sourcing: tool({
    description: 'Triggers candidate sourcing across search, fixtures, and external talent sources for a job posting. Use whenever the user asks to source, find, or search candidates for a role/job. jobId is optional.',
    parameters: requestCandidateSourcingInputSchema,
    execute: async () => ({ success: true }),
  }),
  propose_candidate_review: tool({
    description: 'Proposes reviewing and accepting or rejecting candidates in bulk (e.g. "accept the top 3", "accept top 5", "reject everyone below 50"). Accepts decision and topRemainingCount. jobId is optional. Returns a candidate_table card with PendingAction. Requires human confirmation before any candidate status changes.',
    parameters: proposeCandidateReviewInputSchema,
    execute: async () => ({ success: true }),
  }),
  confirm_action: tool({
    description: 'Confirms and executes an active PendingAction. Use ONLY when the user says "yes", "confirm", "proceed", "do it", or approves an active proposed card. NEVER use this tool when the user requests candidate sourcing, emails, or questions.',
    parameters: confirmActionInputSchema,
    execute: async () => ({ success: true }),
  }),
  cancel_action: tool({
    description: 'Cancels an active PendingAction proposal card.',
    parameters: cancelActionInputSchema,
    execute: async () => ({ success: true }),
  }),
  list_jobs: tool({
    description: 'Lists all recruitment jobs in the database. Use ONLY when the recruiter specifically asks to list or see all available jobs (e.g. "list all jobs", "what jobs exist?"). NEVER invoke as a prerequisite lookup for candidates, campaigns, stats, or status updates.',
    parameters: listJobsInputSchema,
    execute: async () => ({ success: true }),
  }),
  get_job: tool({
    description: 'Gets full details and criteria for a specific job from the database.',
    parameters: getJobInputSchema,
    execute: async () => ({ success: true }),
  }),
  find_candidates: tool({
    description: 'Searches candidates in the database filtered by job, status, or name.',
    parameters: findCandidatesInputSchema,
    execute: async () => ({ success: true }),
  }),
  show_candidates: tool({
    description: 'Displays a table of candidates for a job as an interactive candidate_table card in browse mode (sorted by score descending with direct per-row Accept/Reject actions). Use directly whenever the recruiter asks to see, view, or show candidates (e.g. "show me the candidates"). jobId is optional.',
    parameters: showCandidatesInputSchema,
    execute: async () => ({ success: true }),
  }),
  get_campaign: tool({
    description: 'Gets recruitment campaign details and outreach sequence for a job.',
    parameters: getCampaignInputSchema,
    execute: async () => ({ success: true }),
  }),
  propose_campaign: tool({
    description: 'Proposes an outreach email campaign for Accepted candidates of a job. Returns an interactive campaign_preview card with editable subject and body templates. Use directly when the user asks to start/propose an outreach campaign, draft emails, or reach out to candidates (e.g. "create an outreach campaign for accepted candidates"). jobId is optional.',
    parameters: proposeCampaignInputSchema,
    execute: async () => ({ success: true }),
  }),
  pause_campaign: tool({
    description: 'Proposes pausing an active outreach campaign (e.g. "pause the campaign"). Suspends all scheduled follow-up steps. jobId is optional.',
    parameters: pauseCampaignInputSchema,
    execute: async () => ({ success: true }),
  }),
  resume_campaign: tool({
    description: 'Proposes resuming a paused outreach campaign.',
    parameters: resumeCampaignInputSchema,
    execute: async () => ({ success: true }),
  }),
  send_booking_link: tool({
    description: 'Proposes sending an introductory meeting booking link to an interested candidate. Returns an interactive booking_link card. (DEC-19)',
    parameters: sendBookingLinkInputSchema,
    execute: async () => ({ success: true }),
  }),
  propose_reply_draft: tool({
    description: 'Proposes an email reply draft to an inbound candidate message. Returns an interactive reply_draft card with editable subject and body. Use when the recruiter asks to write, draft, or redo a candidate reply.',
    parameters: proposeReplyDraftInputSchema,
    execute: async () => ({ success: true }),
  }),
  update_candidate_status: tool({
    description: 'Proposes advancing or updating a candidate status in the recruitment pipeline (e.g. "mark Maya Sterling as hired", "advance John to Interviewed"). Accepts candidateName directly (or candidateId) and newStatus. Returns an interactive status_update card.',
    parameters: updateCandidateStatusInputSchema,
    execute: async () => ({ success: true }),
  }),
  get_job_stats: tool({
    description: 'Retrieves live pipeline statistics, funnel metrics, reply/interested conversion rates, and token/cost summary for a job. Accepts jobTitle (e.g. "React") or jobId. Returns an interactive stats_summary card. Use directly when the recruiter asks about recruiting progress, status, metrics, or "how is the React job going?".',
    parameters: getJobStatsInputSchema,
    execute: async () => ({ success: true }),
  }),
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function testSentence(sentence: string, expectedTools: string[]): Promise<{ calledTool: string; args: any; ok: boolean }> {
  const google = createGoogleGenerativeAI({
    apiKey: env.GEMINI_API_KEY,
  });

  let response: any;
  try {
    response = await generateText({
      model: google(env.LLM_MODEL),
      maxRetries: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: sentence }],
      tools: tools as any,
    });
  } catch (err: any) {
    const fallback = 'gemini-3.5-flash-lite';
    // Fallback model execution
    response = await generateText({
      model: google(fallback),
      maxRetries: 1,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: sentence }],
      tools: tools as any,
    });
  }

  const firstCall = response.toolCalls?.[0];
  const calledTool = firstCall?.toolName || 'none';
  const args = firstCall?.args || {};
  const ok = expectedTools.includes(calledTool);
  return { calledTool, args, ok };
}

async function run() {
  console.log(`Testing tool selection with model: ${env.LLM_MODEL}`);
  console.log('Script path: apps/backend/scripts/test-b2-tools.ts');
  console.log('----------------------------------------------------------------------');

  const testCases: Array<{ sentence: string; expected: string[]; count: number }> = [
    { sentence: 'source candidates for it', expected: ['request_candidate_sourcing'], count: 5 },
    { sentence: 'show me the candidates', expected: ['show_candidates'], count: 3 },
    { sentence: 'accept the top 3', expected: ['propose_candidate_review'], count: 3 },
    { sentence: 'create an outreach campaign for accepted candidates', expected: ['propose_campaign'], count: 3 },
    { sentence: 'mark Maya Sterling as hired', expected: ['update_candidate_status'], count: 3 },
    { sentence: 'how is the React job going?', expected: ['get_job_stats'], count: 3 },
    { sentence: 'pause the campaign', expected: ['pause_campaign'], count: 3 },
  ];

  console.log('| Sentence | Expected Tool | Called Tool (with arguments) | OK |');
  console.log('|---|---|---|---|');

  for (const tc of testCases) {
    for (let i = 1; i <= tc.count; i++) {
      try {
        const res = await testSentence(tc.sentence, tc.expected);
        const argsStr = JSON.stringify(res.args);
        console.log(`| "${tc.sentence}" (run ${i}/${tc.count}) | ${tc.expected.join(' or ')} | ${res.calledTool} args: ${argsStr} | ${res.ok ? 'OK' : 'FAIL'} |`);
      } catch (err: any) {
        console.log(`| "${tc.sentence}" (run ${i}/${tc.count}) | ${tc.expected.join(' or ')} | ERROR: ${err.message} | FAIL |`);
      }
      await delay(1000); // 1s delay
    }
  }
  console.log('----------------------------------------------------------------------');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
