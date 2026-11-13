import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateObject } from 'ai';
import { z } from 'zod';
import { env } from '../config/env';
import { TokenUsage } from '../models';

const extractionSchema = z.object({
  title: z.string().describe('Extracted job title, e.g. Senior Frontend Engineer'),
  mustHaveSkills: z.array(z.string()).describe('Core mandatory skills, e.g. ["React", "TypeScript"]'),
  niceToHaveSkills: z.array(z.string()).describe('Optional or bonus skills, e.g. ["GraphQL", "Next.js"]'),
  seniority: z.string().optional().describe('Seniority level, e.g. Senior, Lead, Staff, Mid'),
  location: z.string().optional().describe('Job location, e.g. San Francisco, CA'),
  salaryRange: z
    .object({
      min: z.number().optional().describe('Minimum annual base salary in USD'),
      max: z.number().optional().describe('Maximum annual base salary in USD'),
      currency: z.string().default('USD'),
    })
    .optional(),
  remotePolicy: z
    .enum(['Remote', 'Hybrid', 'On-site'])
    .optional()
    .describe('Remote working policy'),
});

export type ExtractedJobData = z.infer<typeof extractionSchema>;

export async function extractJobFromText(text: string, conversationId?: string): Promise<ExtractedJobData> {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured in environment.');
  }

  const google = createGoogleGenerativeAI({
    apiKey: env.GEMINI_API_KEY,
  });

  const prompt = `You are a recruitment data extraction engine. Analyze the following Job Description (JD) and extract the structured attributes according to the schema.
Do NOT invent or hallucinate any skills or compensation not mentioned in the text.

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
    const promptTokens = result.usage.promptTokens || 0;
    const completionTokens = result.usage.completionTokens || 0;
    const totalTokens = promptTokens + completionTokens;
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

