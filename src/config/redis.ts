import Redis from 'ioredis';
import { env } from './env';

export const redisConnection = new Redis(env.REDIS_URI, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
});

redisConnection.on('connect', () => {
  console.log('[Redis] Connected successfully');
});

redisConnection.on('error', (err) => {
  console.error('[Redis] Connection error:', err.message);
});

export async function connectRedis(): Promise<void> {
  if (redisConnection.status === 'wait') {
    await redisConnection.connect();
  }
}

export function isRedisConnected(): boolean {
  return redisConnection.status === 'ready' || redisConnection.status === 'connect';
}

