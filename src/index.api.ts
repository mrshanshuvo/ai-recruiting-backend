import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import { connectDB } from './config/db';
import { connectRedis } from './config/redis';
import { healthRouter } from './routes/health.route';

const app = express();

app.use(cors({
  origin: env.CORS_ORIGIN,
  credentials: true,
}));
app.use(express.json());

// Health check endpoint (GET /health)
app.use(healthRouter);

// Fallback error handler
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[API Error]', err);
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: err instanceof Error ? err.message : 'An unexpected error occurred',
    },
  });
});

async function startServer(): Promise<void> {
  try {
    await connectDB();
    await connectRedis();

    app.listen(env.PORT, () => {
      console.log(`[API Server] Running on http://localhost:${env.PORT}`);
      console.log(`[API Server] CORS enabled for ${env.CORS_ORIGIN}`);
    });
  } catch (error) {
    console.error('[API Server] Fatal startup error:', error);
    process.exit(1);
  }
}

startServer();

export { app };

