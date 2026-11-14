import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  PUBLIC_FRONTEND_URL: z.string().default('http://localhost:5173'),
  MONGO_URI: z.string().default('mongodb://localhost:27017/ai-recruiting-co-worker'),
  REDIS_URI: z.string().default('redis://localhost:6379'),
  GEMINI_API_KEY: z.string().optional().default(''),
  LLM_MODEL: z.string().default('gemini-3.1-flash-lite'),
  LLM_FALLBACK_MODEL: z.string().optional().default('gemini-3.7-flash'),
  WORKER_LLM_MAX_CONCURRENCY: z.coerce.number().default(3),
  SERPER_API_KEY: z.string().optional().default(''),
  DAILY_SEND_LIMIT: z.coerce.number().default(50),
  OUTREACH_STEP_DELAY_UNIT: z.enum(['seconds', 'days']).default('seconds'),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().optional().default(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
export type Env = z.infer<typeof envSchema>;

