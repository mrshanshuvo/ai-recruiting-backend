import { Router, Request, Response } from 'express';
import { isMongoConnected } from '../config/db';
import { isRedisConnected } from '../config/redis';

export const healthRouter = Router();

healthRouter.get(['/health', '/api/health'], async (_req: Request, res: Response) => {
  const mongoStatus = isMongoConnected() ? 'connected' : 'disconnected';
  const redisStatus = isRedisConnected() ? 'connected' : 'disconnected';
  const isHealthy = mongoStatus === 'connected' && redisStatus === 'connected';

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'OK' : 'DEGRADED',
    services: {
      mongo: mongoStatus,
      redis: redisStatus,
    },
    timestamp: new Date().toISOString(),
  });
});

