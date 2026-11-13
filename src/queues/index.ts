import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis';

// Duplicate connection for BullMQ queues
const queueConnection = redisConnection.duplicate();

export const SOURCING_QUEUE_NAME = 'sourcing-queue';
export const SCORING_QUEUE_NAME = 'scoring-queue';
export const OUTREACH_SEND_QUEUE_NAME = 'outreach-send-queue';
export const REPLY_PROCESSING_QUEUE_NAME = 'reply-processing-queue';

export const sourcingQueue = new Queue(SOURCING_QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

export const scoringQueue = new Queue(SCORING_QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

export const outreachSendQueue = new Queue(OUTREACH_SEND_QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

export const replyProcessingQueue = new Queue(REPLY_PROCESSING_QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

export async function getQueueMetrics() {
  const [sourcingCounts, scoringCounts, outreachCounts, replyCounts] = await Promise.all([
    sourcingQueue.getJobCounts('waiting', 'active', 'completed', 'failed'),
    scoringQueue.getJobCounts('waiting', 'active', 'completed', 'failed'),
    outreachSendQueue.getJobCounts('waiting', 'active', 'completed', 'failed'),
    replyProcessingQueue.getJobCounts('waiting', 'active', 'completed', 'failed'),
  ]);

  return {
    sourcing: sourcingCounts,
    scoring: scoringCounts,
    outreach: outreachCounts,
    reply: replyCounts,
  };
}

