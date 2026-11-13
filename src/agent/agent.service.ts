import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText, tool, CoreMessage } from 'ai';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { Message, TokenUsage, IMessagePart } from '../models';
import { SYSTEM_PROMPT } from './system-prompt';
import { publishConversationEvent } from '../services/event-bus.service';
import {
  parseAndProposeJobInputSchema,
  executeParseAndProposeJob,
} from './tools/parse-and-propose-job.tool';
import { confirmActionInputSchema, executeConfirmAction } from './tools/confirm-action.tool';
import { cancelActionInputSchema, executeCancelAction } from './tools/cancel-action.tool';
import {
  listJobsInputSchema,
  executeListJobs,
  getJobInputSchema,
  executeGetJob,
} from './tools/job-tools';

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

    const model = google(env.LLM_MODEL);

    // 1. Fetch conversation history
    const historyDocs = await Message.find({ conversationId })
      .sort({ createdAt: 1 })
      .limit(30)
      .lean();

    const coreMessages: CoreMessage[] = [];

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
        parameters: parseAndProposeJobInputSchema,
        execute: async (input) => {
          const res = await executeParseAndProposeJob(input, conversationId);
          toolMessage = res.message || 'I prepared this, please confirm.';
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
        parameters: confirmActionInputSchema,
        execute: async (input) => {
          const res = await executeConfirmAction(input, conversationId);
          toolMessage =
            res.message || (res.success ? 'Confirmed successfully.' : res.error || 'Failed to confirm.');
          return res;
        },
      }),

      cancel_action: tool({
        description:
          'Cancels an active PendingAction. Use when the user says "no", "cancel", or rejects a proposal.',
        parameters: cancelActionInputSchema,
        execute: async (input) => {
          const res = await executeCancelAction(input, conversationId);
          toolMessage =
            res.message || (res.success ? 'Action cancelled.' : res.error || 'Failed to cancel.');
          return res;
        },
      }),

      list_jobs: tool({
        description: 'Lists existing recruitment jobs and their status.',
        parameters: listJobsInputSchema,
        execute: async (input) => {
          const res = await executeListJobs(input);
          toolMessage = res.message || `Found ${res.jobs?.length || 0} jobs.`;
          return res;
        },
      }),

      get_job: tool({
        description: 'Gets full details and criteria for a specific job.',
        parameters: getJobInputSchema,
        execute: async (input) => {
          const res = await executeGetJob(input);
          toolMessage =
            res.message || (res.job ? `Job details for ${res.job.title}` : 'Job not found.');
          return res;
        },
      }),
    };

    // 2. Stream generation with tool calls (single step per turn for safety and confirmation gate)
    const result = await streamText({
      model,
      system: SYSTEM_PROMPT,
      messages: coreMessages,
      tools: agentTools,
      maxSteps: 1,
    });

    for await (const chunk of result.textStream) {
      fullText += chunk;
      await publishConversationEvent(conversationId, 'CHAT_DELTA', {
        messageId: assistantMsgId.toString(),
        delta: chunk,
      });
    }

    // 3. Save assistant message and token usage
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

    // 4. Token usage accounting
    try {
      const usage = await result.usage;
      if (usage) {
        const promptTokens = usage.promptTokens || 0;
        const completionTokens = usage.completionTokens || 0;
        const totalTokens = promptTokens + completionTokens;
        const cost = (promptTokens * 0.075 + completionTokens * 0.3) / 1000000;

        await TokenUsage.create({
          conversationId: new mongoose.Types.ObjectId(conversationId),
          caller: 'agent',
          model: env.LLM_MODEL,
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

    return assistantMsgId.toString();
  }
}
