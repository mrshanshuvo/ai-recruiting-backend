# Backend - AI Recruiting Co-Worker

Express + TypeScript + Mongoose + BullMQ backend powering the AI Recruiting Co-Worker.

## Run

### Option A: Local Development (Fast HMR without container rebuilds)
1. Start infrastructure (MongoDB and Redis):
   ```bash
   docker compose -f docker-compose.dev.yml up -d
   ```
2. Start API server with hot reload:
   ```bash
   npm run dev:api
   ```
3. Start BullMQ background worker with hot reload:
   ```bash
   npm run dev:worker
   ```

### Option B: Full Docker Compose (Containerized Production/Reviewer Mode)
Run all backend services (`mongo`, `redis`, `api`, `worker`) inside Docker:
```bash
docker compose up --build
```

## Health Check
Verify API, MongoDB, and Redis connectivity:
```bash
curl http://localhost:4000/health
```
Expected response:
```json
{
  "status": "OK",
  "services": {
    "mongo": "connected",
    "redis": "connected"
  }
}
```

