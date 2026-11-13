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

### Configuration & LLM Models
Copy `.env.example` to `.env` and set your `GEMINI_API_KEY`:
```bash
cp .env.example .env
```
Default models configured in `.env.example`:
- `LLM_MODEL=gemini-3.5-flash-lite` (Fast, optimized for chat streaming and structured JSON extraction under standard API quotas)
- `LLM_FALLBACK_MODEL=gemini-3.7-flash` (Used for automatic fallback retry if primary encounters 429/503 errors)

> **Note on Model Availability**: Google AI Studio provides varying model names across free and paid tiers. If `gemini-3.5-flash-lite` or `gemini-3.7-flash` are not enabled on your specific Google AI project, standard generally available equivalents such as `gemini-1.5-flash` or `gemini-2.0-flash` can be configured in `.env`.

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

