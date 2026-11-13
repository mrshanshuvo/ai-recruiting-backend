import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateObject } from 'ai';
import { z } from 'zod';
import { env } from '../config/env';
import { TokenUsage } from '../models';

const extractionSchema = z.object({
  isJobDescription: z
    .boolean()
    .describe('Whether the provided text is an actual job description / job posting (true) or something else (false)'),
  reason: z
    .string()
    .optional()
    .describe('Short explanation of why it is or is not considered a job description'),
  title: z
    .string()
    .optional()
    .nullable()
    .describe('Extracted job title, e.g. Senior Frontend Engineer (null if not a JD or missing)'),
  mustHaveSkills: z
    .array(z.string())
    .default([])
    .describe('Core mandatory skills explicitly stated in text'),
  niceToHaveSkills: z
    .array(z.string())
    .default([])
    .describe('Optional or bonus skills explicitly stated in text'),
  seniority: z
    .string()
    .optional()
    .nullable()
    .describe('Seniority level, e.g. Senior, Lead, Staff, Mid (null if not stated)'),
  location: z
    .string()
    .optional()
    .nullable()
    .describe('Job location, e.g. San Francisco, CA (null if not stated)'),
  salaryRange: z
    .object({
      min: z.number().optional().nullable().describe('Minimum annual base salary in USD'),
      max: z.number().optional().nullable().describe('Maximum annual base salary in USD'),
      currency: z.string().default('USD'),
    })
    .optional()
    .nullable(),
  remotePolicy: z
    .enum(['Remote', 'Hybrid', 'On-site'])
    .optional()
    .nullable()
    .describe('Remote working policy (null if not stated)'),
});

export type ExtractedJobData = z.infer<typeof extractionSchema>;

export async function extractJobFromText(text: string, conversationId?: string): Promise<ExtractedJobData> {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured in environment.');
  }

  const google = createGoogleGenerativeAI({
    apiKey: env.GEMINI_API_KEY,
  });

  const prompt = `You are a recruitment data extraction engine. Analyze the following text and determine whether it is an actual Job Description (JD) / posting.
Set isJobDescription to true ONLY if the text describes an open job vacancy/role. If it is random web content, documentation, an article, or unrelated HTML (e.g. from httpbin), set isJobDescription to false.
Extract the structured attributes according to the schema.
CRITICAL: Do NOT invent or hallucinate any skills, salary, location, or seniority not explicitly mentioned in the text. Missing fields must be null or empty arrays.

<job_description>
${text}
</job_description>`;

  const result = await generateObject({
    model: google(env.LLM_MODEL),
    schema: extractionSchema,
    prompt,
  });

  // Track token usage per ADR-0015 & requirement 4
  if (result.usage) {
    const usageAny = result.usage as any;
    const promptTokens = usageAny.inputTokens ?? usageAny.promptTokens ?? 0;
    const completionTokens = usageAny.outputTokens ?? usageAny.completionTokens ?? 0;
    const totalTokens = usageAny.totalTokens ?? (promptTokens + completionTokens);
    // Estimated cost ($0.075 / 1M input, $0.30 / 1M output)
    const cost = (promptTokens * 0.075 + completionTokens * 0.3) / 1000000;

    await TokenUsage.create({
      conversationId: conversationId ? conversationId : undefined,
      caller: 'agent',
      model: env.LLM_MODEL,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCostUsd: Number(cost.toFixed(6)),
      timestamp: new Date(),
    });
  }

  return result.object;
}

