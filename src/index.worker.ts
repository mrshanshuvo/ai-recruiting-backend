import { env } from './config/env';
import { connectDB } from './config/db';
import { connectRedis } from './config/redis';

async function startWorker(): Promise<void> {
  try {
    console.log('[Worker Process] Initializing BullMQ worker process...');
    await connectDB();
    await connectRedis();

    console.log(`[Worker Process] Worker process started successfully in ${env.NODE_ENV} mode.`);
    console.log(`[Worker Process] LLM Max Concurrency set to: ${env.WORKER_LLM_MAX_CONCURRENCY}`);
    console.log(`[Worker Process] Sourcing, scoring, sending, and reply queues ready for job consumption.`);

    const shutdown = async (signal: string) => {
      console.log(`[Worker Process] Received ${signal}. Gracefully shutting down...`);
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    console.error('[Worker Process] Fatal worker error:', error);
    process.exit(1);
  }
}

startWorker();

