import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText, tool, hasToolCall, isStepCount } from 'ai';
import { z } from 'zod';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { calculateEstimatedCostUsd } from '../config/pricing.config';
import { Message, TokenUsage, IMessagePart } from '../models';
import { SYSTEM_PROMPT } from './system-prompt';
import { publishConversationEvent } from '../services/event-bus.service';
import {
  parseAndProposeJobInputSchema,
  executeParseAndProposeJob,
} from './tools/parse-and-propose-job.tool';
import {
  requestCandidateSourcingInputSchema,
  executeRequestCandidateSourcing,
} from './tools/request-candidate-sourcing.tool';
import {
  proposeCandidateReviewInputSchema,
  executeProposeCandidateReview,
} from './tools/propose-candidate-review.tool';
import { confirmActionInputSchema, executeConfirmAction } from './tools/confirm-action.tool';
import { cancelActionInputSchema, executeCancelAction } from './tools/cancel-action.tool';
import {
  listJobsInputSchema,
  executeListJobs,
  getJobInputSchema,
  executeGetJob,
  findCandidatesInputSchema,
  executeFindCandidates,
  getCampaignInputSchema,
  executeGetCampaign,
} from './tools/job-tools';
import {
  showCandidatesInputSchema,
  executeShowCandidates,
} from './tools/show-candidates.tool';
import {
  proposeCampaignInputSchema,
  executeProposeCampaign,
} from './tools/propose-campaign.tool';
import {
  pauseCampaignInputSchema,
  executePauseCampaign,
  resumeCampaignInputSchema,
  executeResumeCampaign,
} from './tools/campaign-lifecycle.tool';
import {
  sendBookingLinkInputSchema,
  executeSendBookingLink,
} from './tools/booking-link.tool';
import {
  proposeReplyDraftInputSchema,
  executeProposeReplyDraft,
} from './tools/propose-reply-draft.tool';
import {
  updateCandidateStatusInputSchema,
  executeUpdateCandidateStatus,
} from './tools/update-candidate-status.tool';
import {
  getJobStatsInputSchema,
  executeGetJobStats,
} from './tools/get-job-stats.tool';

export const REGISTERED_TOOL_NAMES = [
  'parse_and_propose_job',
  'request_candidate_sourcing',
  'propose_candidate_review',
  'confirm_action',
  'cancel_action',
  'list_jobs',
  'get_job',
  'find_candidates',
  'show_candidates',
  'get_campaign',
  'propose_campaign',
  'pause_campaign',
  'resume_campaign',
  'send_booking_link',
  'propose_reply_draft',
  'update_candidate_status',
  'get_job_stats',
] as const;

export type RegisteredToolName = typeof REGISTERED_TOOL_NAMES[number];

export async function executeWithRetry<T>(
  fn: (modelName: string) => Promise<T>,
  primaryModel: string,
  fallbackModel?: string
): Promise<T> {
  const maxRetries = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(primaryModel);
    } catch (err: any) {
      lastError = err;
      const rawErr = err?.lastError || err?.cause || (err?.errors && err.errors[0]) || err;
      const errorsStr = Array.isArray(err?.errors)
        ? err.errors.map((e: any) => `${e?.message || ''} ${e?.responseBody || ''}`).join(' ')
        : '';
      const errorString = `${err?.message || ''} ${rawErr?.message || ''} ${rawErr?.responseBody || ''} ${errorsStr}`;

      const status =
        rawErr?.status ||
        rawErr?.statusCode ||
        err?.status ||
        err?.statusCode ||
        (errorString.includes('503') ? 503 : undefined) ||
        (errorString.includes('429') ? 429 : undefined);

      const isRetryable =
        status === 503 ||
        status === 429 ||
        errorString.includes('high demand') ||
        errorString.includes('quota') ||
        errorString.includes('RESOURCE_EXHAUSTED');

      const isDailyExhausted = errorString.includes('per day') || errorString.includes('daily');

      if (isDailyExhausted || !isRetryable || attempt === maxRetries) {
        if (isDailyExhausted) {
          console.warn(`[AgentService] Primary model ${primaryModel} daily quota exhausted. Falling back immediately.`);
        }
        break;
      }

      let backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      const match = errorString.match(/retry in ([0-9.]+)\s*(s|ms)?/i);
      if (match && match[1]) {
        const val = parseFloat(match[1]);
        const unit = match[2]?.toLowerCase() || 's';
        const ms = unit === 'ms' ? val : val * 1000;
        backoffMs = Math.min(Math.ceil(ms) + 2000, 45000);
      } else if (status === 429) {
        backoffMs = 12000 * attempt;
      }

      console.warn(
        `[AgentService] Primary model ${primaryModel} failed with ${status || 'retryable error'} on attempt ${attempt}. Retrying in ${backoffMs}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  // Fallback model chain if primary model failed
  const candidateFallbacks = Array.from(
    new Set(['gemini-3.5-flash-lite', fallbackModel?.trim(), 'gemini-2.5-flash-lite'].filter(Boolean))
  ) as string[];

  for (const modelCandidate of candidateFallbacks) {
    if (modelCandidate === primaryModel) continue;
    console.warn(
      `[AgentService] Primary model failed after ${maxRetries} attempts. Attempting fallback model: ${modelCandidate}`
    );
    try {
      return await fn(modelCandidate);
    } catch (fallbackErr) {
      lastError = fallbackErr;
    }
  }

  throw lastError;
}

export class AgentService {
  public static async runTurn(conversationId: string, userText: string): Promise<string> {
    if (!env.GEMINI_API_KEY) {
      throw new Error(
        'GEMINI_API_KEY is not configured in environment. Please add your GEMINI_API_KEY to apps/backend/.env.'
      );
    }

    const google = createGoogleGenerativeAI({
      apiKey: env.GEMINI_API_KEY,
    });

    // 1. Fetch conversation history
    const historyDocs = await Message.find({ conversationId })
      .sort({ createdAt: 1 })
      .limit(30)
      .lean();

    const coreMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const doc of historyDocs) {
      const partsText: string[] = [];
      for (const part of doc.parts) {
        if (part.type === 'text' && part.text) {
          partsText.push(part.text);
        } else if (part.type === 'card' && part.card) {
          partsText.push(
            `[Card: ${part.card.cardType}, ActionId: ${part.card.actionId}, Status: ${part.card.status}, Details: ${JSON.stringify(part.card.payload)}]`
          );
        }
      }
      const combinedText = partsText.join('\n');

      if (doc.role === 'user') {
        coreMessages.push({ role: 'user', content: combinedText || '...' });
      } else if (doc.role === 'assistant') {
        coreMessages.push({ role: 'assistant', content: combinedText || '...' });
      }
    }

    // Add current user turn
    coreMessages.push({ role: 'user', content: userText });

    const assistantMsgId = new mongoose.Types.ObjectId();
    const parts: IMessagePart[] = [];
    let fullText = '';
    let toolMessage = '';

    // Define agent tools
    const agentTools = {
      parse_and_propose_job: tool({
        description:
          'Parses a Job Description (from raw text or a public URL) and proposes creating a job via an interactive job_confirmation card. Always use this when the user shares a JD or asks to create/propose a job.',
        inputSchema: parseAndProposeJobInputSchema,
        execute: async (input: z.infer<typeof parseAndProposeJobInputSchema>) => {
          const res = await executeParseAndProposeJob(input, conversationId);
          toolMessage = res.message || res.error || 'I prepared this, please confirm.';
          if (res.card) {
            parts.push({
              type: 'card',
              card: res.card as any,
            });
            await publishConversationEvent(conversationId, 'CHAT_PART', {
              messageId: assistantMsgId.toString(),
              partIndex: parts.length - 1,
              part: {
                type: 'card',
                card: res.card as any,
              },
            });
          }
          return res;
        },
      }),

      request_candidate_sourcing: tool({
        description:
          'Proposes sourcing candidates for a specific job via an interactive sourcing_confirmation card. Inputs: jobId (required ObjectId of existing job), targetCount (optional 1-50, default 10), and optional searchQueries.',
        inputSchema: requestCandidateSourcingInputSchema,
        execute: async (input: z.infer<typeof requestCandidateSourcingInputSchema>) => {
          const res = await executeRequestCandidateSourcing(input, conversationId);
          toolMessage = res.message || res.error || 'I prepared candidate sourcing, please confirm.';
          if (res.card) {
            parts.push({
              type: 'card',
              card: res.card as any,
            });
            await publishConversationEvent(conversationId, 'CHAT_PART', {
              messageId: assistantMsgId.toString(),
              partIndex: parts.length - 1,
              part: {
                type: 'card',
                card: res.card as any,
              },
            });
          }
          return res;
        },
      }),

      propose_candidate_review: tool({
        description:
          'Proposes reviewing and accepting or rejecting candidates in bulk (e.g. "accept the top 3", "accept top 5", "reject everyone below 50"). Accepts decision and topRemainingCount. jobId is optional. Returns a candidate_table card with PendingAction. Requires human confirmation before any candidate status changes.',
        inputSchema: proposeCandidateReviewInputSchema,
        execute: async (input: z.infer<typeof proposeCandidateReviewInputSchema>) => {
          const res = await executeProposeCandidateReview(input, conversationId);
          toolMessage = res.message || res.error || 'I prepared candidate review, please confirm.';
          if (res.card) {
            parts.push({
              type: 'card',
              card: res.card as any,
            });
            await publishConversationEvent(conversationId, 'CHAT_PART', {
              messageId: assistantMsgId.toString(),
              partIndex: parts.length - 1,
              part: {
                type: 'card',
                card: res.card as any,
              },
            });
          }
          return res;
        },
      }),

      confirm_action: tool({
        description:
          'Confirms and executes an active PendingAction. Use ONLY when the user says "yes", "confirm", "proceed", "do it", or approves an active proposed card. NEVER use this tool when the user requests candidate sourcing, emails, or questions.',
        inputSchema: confirmActionInputSchema,
        execute: async (input: z.infer<typeof confirmActionInputSchema>) => {
          const res = await executeConfirmAction(input, conversationId);
          toolMessage =
            res.message || (res.success ? 'Confirmed successfully.' : res.error || 'Failed to confirm.');
          return res;
        },
      }),

      cancel_action: tool({
        description:
          'Cancels an active PendingAction. Use when the user says "no", "cancel", or rejects a proposal.',
        inputSchema: cancelActionInputSchema,
        execute: async (input: z.infer<typeof cancelActionInputSchema>) => {
          const res = await executeCancelAction(input, conversationId);
          toolMessage =
            res.message || (res.success ? 'Action cancelled.' : res.error || 'Failed to cancel.');
          return res;
        },
      }),

      list_jobs: tool({
        description:
          'Lists all recruitment job postings in the database. Use ONLY when the recruiter specifically asks to list or see available job openings (e.g. "what open roles are there?"). NEVER use when asking about candidates, applicants, or people, and NEVER invoke as a prerequisite lookup.',
        inputSchema: listJobsInputSchema,
        execute: async (input: z.infer<typeof listJobsInputSchema>) => {
          return executeListJobs(input);
        },
      }),

      get_job: tool({
        description: 'Gets full details and criteria for a specific job from the database.',
        inputSchema: getJobInputSchema,
        execute: async (input: z.infer<typeof getJobInputSchema>) => {
          return executeGetJob(input);
        },
      }),

      find_candidates: tool({
        description: 'Searches candidates in the database filtered by job, status, or name.',
        inputSchema: findCandidatesInputSchema,
        execute: async (input: z.infer<typeof findCandidatesInputSchema>) => {
          return executeFindCandidates(input);
        },
      }),

      show_candidates: tool({
        description:
          'Displays candidate profiles for a job as an interactive candidate_table card in browse mode (sorted by score descending with direct per-row Accept/Reject actions). Use when the recruiter asks to see, view, inspect, or review candidates or applicants. jobId is optional.',
        inputSchema: showCandidatesInputSchema,
        execute: async (input: z.infer<typeof showCandidatesInputSchema>) => {
          const res = await executeShowCandidates(input);
          if (res.card) {
            parts.push({
              type: 'card',
              card: res.card as any,
            });
            await publishConversationEvent(conversationId, 'CHAT_PART', {
              messageId: assistantMsgId.toString(),
              partIndex: parts.length - 1,
              part: {
                type: 'card',
                card: res.card as any,
              },
            });
          }
          return res;
        },
      }),

      get_campaign: tool({
        description:
          'Retrieves outreach campaign details and email templates for a job. Use ONLY when the user explicitly asks to view or inspect campaign sequence details.',
        inputSchema: getCampaignInputSchema,
        execute: async (input: z.infer<typeof getCampaignInputSchema>) => {
          return executeGetCampaign(input);
        },
      }),

      propose_campaign: tool({
        description:
          'Proposes an outreach email campaign for Accepted candidates of a job. Returns an interactive campaign_preview card with editable subject and body templates. Use directly when the user asks to start/propose an outreach campaign, draft emails, or reach out to candidates (e.g. "create an outreach campaign for accepted candidates"). jobId is optional.',
        inputSchema: proposeCampaignInputSchema,
        execute: async (input: z.infer<typeof proposeCampaignInputSchema>) => {
          console.log('[AgentService] propose_campaign execute called with input:', input);
          const res = await executeProposeCampaign(input, conversationId);
          console.log('[AgentService] propose_campaign execute returned:', res.success, res.error);
          toolMessage = res.message || res.error || 'I prepared an outreach proposal, please confirm.';
          if (res.card) {
            parts.push({
              type: 'card',
              card: res.card as any,
            });
            await publishConversationEvent(conversationId, 'CHAT_PART', {
              messageId: assistantMsgId.toString(),
              partIndex: parts.length - 1,
              part: {
                type: 'card',
                card: res.card as any,
              },
            });
          }
          return res;
        },
      }),

      pause_campaign: tool({
        description:
          'Proposes pausing an active outreach campaign or stopping/suspending outreach emails. Suspends all scheduled follow-up steps. Use whenever the user asks to pause, stop, hold, or suspend outreach emails or campaigns.',
        inputSchema: pauseCampaignInputSchema,
        execute: async (input: z.infer<typeof pauseCampaignInputSchema>) => {
          const res = await executePauseCampaign(input, conversationId);
          toolMessage = res.message || res.error || 'I prepared to pause the campaign, please confirm.';
          if (res.card) {
            parts.push({
              type: 'card',
              card: res.card as any,
            });
            await publishConversationEvent(conversationId, 'CHAT_PART', {
              messageId: assistantMsgId.toString(),
              partIndex: parts.length - 1,
              part: {
                type: 'card',
                card: res.card as any,
              },
            });
          }
          return res;
        },
      }),

      resume_campaign: tool({
        description: 'Proposes resuming a paused outreach campaign.',
        inputSchema: resumeCampaignInputSchema,
        execute: async (input: z.infer<typeof resumeCampaignInputSchema>) => {
          const res = await executeResumeCampaign(input, conversationId);
          toolMessage = res.message || res.error || 'I prepared to resume the campaign, please confirm.';
          if (res.card) {
            parts.push({
              type: 'card',
              card: res.card as any,
            });
            await publishConversationEvent(conversationId, 'CHAT_PART', {
              messageId: assistantMsgId.toString(),
              partIndex: parts.length - 1,
              part: {
                type: 'card',
                card: res.card as any,
              },
            });
          }
          return res;
        },
      }),

      send_booking_link: tool({
        description:
          'Proposes sending an introductory meeting booking link to an interested candidate. Returns an interactive booking_link card. (DEC-19)',
        inputSchema: sendBookingLinkInputSchema,
        execute: async (input: z.infer<typeof sendBookingLinkInputSchema>) => {
          const res = await executeSendBookingLink(input, conversationId);
          toolMessage = res.message || res.error || 'I prepared the booking link proposal, please confirm.';
          if (res.card) {
            parts.push({
              type: 'card',
              card: res.card as any,
            });
            await publishConversationEvent(conversationId, 'CHAT_PART', {
              messageId: assistantMsgId.toString(),
              partIndex: parts.length - 1,
              part: {
                type: 'card',
                card: res.card as any,
              },
            });
          }
          return res;
        },
      }),

      propose_reply_draft: tool({
        description:
          'Proposes an email reply draft to an inbound candidate message. Returns an interactive reply_draft card with editable subject and body. Use when the recruiter asks to write, draft, or redo a candidate reply.',
        inputSchema: proposeReplyDraftInputSchema,
        execute: async (input: z.infer<typeof proposeReplyDraftInputSchema>) => {
          const res = await executeProposeReplyDraft(input, conversationId);
          toolMessage = res.message || res.error || 'I prepared the reply draft, please review and confirm.';
          if (res.card) {
            parts.push({
              type: 'card',
              card: res.card as any,
            });
            await publishConversationEvent(conversationId, 'CHAT_PART', {
              messageId: assistantMsgId.toString(),
              partIndex: parts.length - 1,
              part: {
                type: 'card',
                card: res.card as any,
              },
            });
          }
          return res;
        },
      }),

      update_candidate_status: tool({
        description:
          'Proposes advancing or updating a candidate status in the recruitment pipeline (e.g. "mark Maya Sterling as hired", "advance John to Interviewed"). Accepts candidateName directly (or candidateId) and newStatus. Returns an interactive status_update card.',
        inputSchema: updateCandidateStatusInputSchema,
        execute: async (input: z.infer<typeof updateCandidateStatusInputSchema>) => {
          const res = await executeUpdateCandidateStatus(input, conversationId);
          toolMessage = res.message || res.error || 'I prepared the status update, please confirm.';
          if (res.card) {
            parts.push({
              type: 'card',
              card: res.card as any,
            });
            await publishConversationEvent(conversationId, 'CHAT_PART', {
              messageId: assistantMsgId.toString(),
              partIndex: parts.length - 1,
              part: {
                type: 'card',
                card: res.card as any,
              },
            });
          }
          return res;
        },
      }),

      get_job_stats: tool({
        description:
          'Retrieves live pipeline statistics, funnel metrics, reply/interested conversion rates, and token/cost summary for a job. Accepts jobTitle (e.g. "React") or jobId. Returns an interactive stats_summary card. Use directly when the recruiter asks about recruiting progress, status, metrics, or "how is the React job going?".',
        inputSchema: getJobStatsInputSchema,
        execute: async (input: z.infer<typeof getJobStatsInputSchema>) => {
          const res = await executeGetJobStats(input, conversationId);
          toolMessage = res.message || res.error || 'Here are the live job stats:';
          if (res.card) {
            parts.push({
              type: 'card',
              card: res.card as any,
            });
            await publishConversationEvent(conversationId, 'CHAT_PART', {
              messageId: assistantMsgId.toString(),
              partIndex: parts.length - 1,
              part: {
                type: 'card',
                card: res.card as any,
              },
            });
          }
          return res;
        },
      }),
    };

    try {
      await executeWithRetry(
        async (modelName) => {
          const model = google(modelName);

          const result = streamText({
            model,
            system: SYSTEM_PROMPT,
            messages: coreMessages as any,
            tools: agentTools as any,
            stopWhen: [
              hasToolCall('parse_and_propose_job'),
              hasToolCall('request_candidate_sourcing'),
              hasToolCall('propose_candidate_review'),
              hasToolCall('propose_campaign'),
              hasToolCall('pause_campaign'),
              hasToolCall('resume_campaign'),
              hasToolCall('send_booking_link'),
              hasToolCall('propose_reply_draft'),
              hasToolCall('update_candidate_status'),
              hasToolCall('get_job_stats'),
              hasToolCall('confirm_action'),
              hasToolCall('cancel_action'),
              isStepCount(3),
            ],
            onStepFinish: (step) => {
              console.log('[AgentService StepFinish]', {
                text: step.text,
                toolCalls: step.toolCalls?.map((t: any) => ({
                  name: t.toolName,
                  input: t.input || t.args,
                  invalid: (t as any).invalid,
                  error: (t as any).error?.message || (t as any).error,
                })),
                toolResults: step.toolResults?.map((r: any) => ({ name: r.toolName, result: (r as any).output ?? r.result })),
              });
            },
          });

          for await (const chunk of result.textStream) {
            fullText += chunk;
            await publishConversationEvent(conversationId, 'CHAT_DELTA', {
              messageId: assistantMsgId.toString(),
              delta: chunk,
            });
          }

          // Await result.response and result.steps to ensure all tool executions complete
          await result.response;
          try {
            if ((result as any).steps) {
              await (result as any).steps;
            }
          } catch (_) {}

          // Token usage accounting
          try {
            const usage = await result.usage;
            if (usage) {
              const usageAny = usage as any;
              const promptTokens = usageAny.inputTokens ?? usageAny.promptTokens ?? 0;
              const completionTokens = usageAny.outputTokens ?? usageAny.completionTokens ?? 0;
              const totalTokens = usageAny.totalTokens ?? promptTokens + completionTokens;
              const cost = calculateEstimatedCostUsd(modelName, promptTokens, completionTokens);

              await TokenUsage.create({
                conversationId: new mongoose.Types.ObjectId(conversationId),
                caller: 'agent',
                model: modelName,
                promptTokens,
                completionTokens,
                totalTokens,
                estimatedCostUsd: cost,
                timestamp: new Date(),
              });
            }
          } catch (e) {
            console.warn('[AgentService] Could not record token usage:', e);
          }
        },
        env.LLM_MODEL,
        env.LLM_FALLBACK_MODEL
      );

      // Save assistant message
      const defaultText = parts.some((p) => p.type === 'card')
        ? 'I prepared this, please confirm.'
        : 'I have processed your request.';
      const finalText = fullText.trim() || toolMessage || defaultText;
      parts.unshift({
        type: 'text',
        text: finalText,
      });

      if (!fullText.trim() && finalText) {
        await publishConversationEvent(conversationId, 'CHAT_DELTA', {
          messageId: assistantMsgId.toString(),
          delta: finalText,
        });
      }

      // Publish card parts over SSE so frontend receives them live
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].type === 'card') {
          await publishConversationEvent(conversationId, 'CHAT_PART', {
            messageId: assistantMsgId.toString(),
            partIndex: i,
            part: parts[i],
          });
        }
      }

      await Message.create({
        _id: assistantMsgId,
        conversationId,
        role: 'assistant',
        parts,
        createdAt: new Date(),
      });

      return assistantMsgId.toString();
    } catch (error) {
      console.error('[AgentService.runTurn Error]', error);
      const rawErrorMsg = (error as any)?.message || String(error);
      const isRateLimit =
        rawErrorMsg.includes('429') ||
        rawErrorMsg.includes('RESOURCE_EXHAUSTED') ||
        rawErrorMsg.includes('quota') ||
        rawErrorMsg.toLowerCase().includes('rate limit');

      const errorMessage = isRateLimit
        ? 'AI service is temporarily rate-limited. Please retry your request in a few moments.'
        : `AI Error: ${rawErrorMsg}`;

      parts.unshift({
        type: 'text',
        text: errorMessage,
      });

      await publishConversationEvent(conversationId, 'CHAT_DELTA', {
        messageId: assistantMsgId.toString(),
        delta: errorMessage,
      });

      await Message.create({
        _id: assistantMsgId,
        conversationId,
        role: 'assistant',
        parts,
        createdAt: new Date(),
      });

      return assistantMsgId.toString();
    }
  }
}
