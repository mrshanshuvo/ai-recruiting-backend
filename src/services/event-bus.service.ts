import Redis from 'ioredis';
import { env } from '../config/env';

// Dedicated publisher for Redis Pub/Sub
export const redisPublisher = new Redis(env.REDIS_URI, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

redisPublisher.connect().catch((err) => {
  console.error('[EventBus Publisher] Connection error:', err.message);
});

export interface ConversationEvent {
  type: string;
  payload: Record<string, unknown>;
}

export async function publishConversationEvent(
  conversationId: string,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  const channel = `conversation:${conversationId}`;
  const message = JSON.stringify({ type: eventType, payload });
  await redisPublisher.publish(channel, message);
}

export function createConversationSubscriber(
  conversationId: string,
  onEvent: (eventType: string, data: Record<string, unknown>) => void
): { close: () => Promise<void> } {
  const subscriber = new Redis(env.REDIS_URI, {
    maxRetriesPerRequest: null,
  });

  const channel = `conversation:${conversationId}`;

  subscriber.subscribe(channel, (err) => {
    if (err) {
      console.error(`[EventBus Subscriber] Failed to subscribe to ${channel}:`, err.message);
    }
  });

  subscriber.on('message', (_chan, msg) => {
    try {
      const parsed = JSON.parse(msg) as ConversationEvent;
      onEvent(parsed.type, parsed.payload);
    } catch (e) {
      console.error('[EventBus Subscriber] Failed to parse Redis message:', e);
    }
  });

  return {
    close: async () => {
      try {
        await subscriber.unsubscribe(channel);
        subscriber.disconnect();
      } catch (err) {
        console.error('[EventBus Subscriber] Error closing subscriber:', err);
      }
    },
  };
}

