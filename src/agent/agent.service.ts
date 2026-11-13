import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText, tool, hasToolCall, isStepCount } from 'ai';
import { z } from 'zod';
import mongoose from 'mongoose';
import { env } from '../config/env';
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
  getJobStatsInputSchema,
  executeGetJobStats,
  findCandidatesInputSchema,
  executeFindCandidates,
  getCampaignInputSchema,
  executeGetCampaign,
} from './tools/job-tools';

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
      const rawErr = err?.lastError || err?.cause || err;
      const errorString = `${err?.message || ''} ${rawErr?.message || ''} ${rawErr?.responseBody || ''}`;

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

      if (!isRetryable || attempt === maxRetries) {
        break;
      }

      let backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      const match = errorString.match(/retry in ([0-9.]+)s/i);
      if (match && match[1]) {
        backoffMs = Math.min(Math.ceil(parseFloat(match[1])) * 1000 + 1500, 35000);
      } else if (status === 429) {
        backoffMs = 5000 * attempt;
      }

      console.warn(
        `[AgentService] Primary model ${primaryModel} failed with ${status || 'retryable error'} on attempt ${attempt}. Retrying in ${backoffMs}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  // Fallback model if primary model failed
  if (fallbackModel && fallbackModel.trim() && fallbackModel !== primaryModel) {
    console.warn(
      `[AgentService] Primary model failed after ${maxRetries} attempts. Attempting fallback model: ${fallbackModel}`
    );
    try {
      return await fn(fallbackModel.trim());
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
          'Proposes reviewing and accepting or rejecting candidates in bulk (e.g. "accept top 5", "reject candidates below 50"). Returns a candidate_table card with PendingAction. Requires human confirmation before any candidate status changes.',
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
          'Confirms and executes an active PendingAction. Use when the user says "yes", "confirm", "proceed", "do it", or approves an active proposed card.',
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
        description: 'Lists existing recruitment jobs and their status from the database.',
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

      get_job_stats: tool({
        description: 'Gets pipeline counts and statistics for a specific job.',
        inputSchema: getJobStatsInputSchema,
        execute: async (input: z.infer<typeof getJobStatsInputSchema>) => {
          return executeGetJobStats(input);
        },
      }),

      find_candidates: tool({
        description: 'Searches candidates in the database filtered by job, status, or name.',
        inputSchema: findCandidatesInputSchema,
        execute: async (input: z.infer<typeof findCandidatesInputSchema>) => {
          return executeFindCandidates(input);
        },
      }),

      get_campaign: tool({
        description: 'Gets recruitment campaign details and outreach sequence for a job.',
        inputSchema: getCampaignInputSchema,
        execute: async (input: z.infer<typeof getCampaignInputSchema>) => {
          return executeGetCampaign(input);
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
              hasToolCall('confirm_action'),
              hasToolCall('cancel_action'),
              isStepCount(3),
            ],
          });

          for await (const chunk of result.textStream) {
            fullText += chunk;
            await publishConversationEvent(conversationId, 'CHAT_DELTA', {
              messageId: assistantMsgId.toString(),
              delta: chunk,
            });
          }

          // Token usage accounting
          try {
            const usage = await result.usage;
            if (usage) {
              const usageAny = usage as any;
              const promptTokens = usageAny.inputTokens ?? usageAny.promptTokens ?? 0;
              const completionTokens = usageAny.outputTokens ?? usageAny.completionTokens ?? 0;
              const totalTokens = usageAny.totalTokens ?? promptTokens + completionTokens;
              const cost = (promptTokens * 0.075 + completionTokens * 0.3) / 1000000;

              await TokenUsage.create({
                conversationId: new mongoose.Types.ObjectId(conversationId),
                caller: 'agent',
                model: modelName,
                promptTokens,
                completionTokens,
                totalTokens,
                estimatedCostUsd: Number(cost.toFixed(6)),
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
      const finalText = fullText.trim() || toolMessage || 'I have processed your request.';
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
      const friendlyMessage =
        'I am currently experiencing high demand or connectivity issues with the AI service. Please try your request again in a few moments.';

      parts.unshift({
        type: 'text',
        text: friendlyMessage,
      });

      await publishConversationEvent(conversationId, 'CHAT_DELTA', {
        messageId: assistantMsgId.toString(),
        delta: friendlyMessage,
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
