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

### System Preflight Check
Before running tests, recording demos, or starting services, verify all infrastructure and configuration dependencies:
```bash
npm run preflight
# or
bash scripts/preflight.sh
```
The script validates 7 operational checks:
1. API health endpoint responsiveness (`http://localhost:4000/health`)
2. Background BullMQ queue worker running (`recruiting_worker` container or local process)
3. Redis connectivity (`PONG`)
4. MongoDB connectivity (`adminCommand ping`)
5. `GEMINI_API_KEY` configured and present
6. Configured LLM model availability in Google Gemini `ListModels` API
7. Ethereal mail DNS resolution

### Configuration & LLM Models
Copy `.env.example` to `.env` and set your `GEMINI_API_KEY`:
```bash
cp .env.example .env
```
Default models configured in `.env.example`:
- `LLM_MODEL=gemini-3.1-flash-lite` (Fast, optimized for chat streaming and structured JSON extraction under standard API quotas)
- `LLM_FALLBACK_MODEL=gemini-3.7-flash` (Used for automatic fallback retry if primary encounters 429/503 errors)

> **Note on Model Availability**: Google AI Studio provides varying model names across free and paid tiers. If `gemini-3.5-flash-lite` or `gemini-3.7-flash` are not enabled on your specific Google AI project, standard generally available equivalents such as `gemini-1.5-flash` or `gemini-2.0-flash` can be configured in `.env`.

### Gemini API Limits & Rate-Limit Mitigation
Google AI Studio's Free Tier enforces a strict rate limit of **15 requests per minute (RPM)** per project. In an autonomous recruiting system where sourcing 10 candidates generates 10 scoring LLM calls plus chat and parsing turns, bursts can quickly exhaust the 60-second rolling quota.

The backend mitigates this via four architectural layers:
1. **Concurrency Control (`WORKER_LLM_MAX_CONCURRENCY=3`)**: The BullMQ scoring worker throttles parallel LLM requests with an internal semaphore, preventing batch explosions.
2. **Fallback Model (`LLM_FALLBACK_MODEL`)**: If the primary model encounters repeated 429 quota exhaustion or 503 high demand, requests automatically switch to the configured fallback model.
3. **Adaptive Retry with Exact Backoff**: When Google returns a `429 RESOURCE_EXHAUSTED` with `Please retry in X.Xs` or `Xms`, the client regex-extracts the exact seconds/milliseconds and sleeps before retrying.
4. **Test Sleep Windows**: The end-to-end verification scripts include intentional 25s cooling intervals between heavy 10-candidate scoring batches and subsequent chat turns to allow the rolling 1-minute 15-RPM quota window to slide forward without triggering rate limits.

**Performance Timing (Last Live Run)**:
From posting the raw seed JD to receiving the first delivered outreach email with live Ethereal preview URLs took **~80 seconds** end-to-end (including 25s rate-limit cooling interval, 10s confirmation cooldown, 10 LLM scoring calls, and BullMQ worker email dispatch).

### Candidate Sourcing: Serper API vs. Fixture Mode
The background sourcing worker supports dual discovery modes:
1. **Live Serper Google Search**: Set `SERPER_API_KEY=your_key` in `.env`. The worker queries the Serper Google Search API using the Boolean search queries approved in the confirmation card, parses public LinkedIn candidate profiles, and marks them with `sourceMode: "serper"`.
2. **Deterministic Fixture Fallback (Default)**: If `SERPER_API_KEY` is left blank or omitted, the worker automatically loads realistic candidate fixtures from `src/data/candidate-fixtures.json`. Candidates are marked with `sourceMode: "fixture"`, and the frontend displays a distinctive "demo data" badge. Evaluators can test full sourcing and scoring pipelines without a paid search API key.

## Trade-offs

### Personalization Strategy: Template Generation + Grounded Openings vs. Full LLM Email Generation
The outreach engine pairs AI-crafted campaign templates with code-governed, strictly grounded personal openings rather than generating 100% bespoke emails per candidate:
1. **Zero Hallucination Safety**: Grounding the candidate's personal opening (1–2 sentences) strictly in verified stored candidate data (`currentTitle`, `currentCompany`, `skills`, `snippet`) guarantees that the AI never invents projects, talks, articles, unverified employers, or fictitious years of experience. When stored candidate data is thin, no personal claim is fabricated and the email falls back safely to the clean template.
2. **Predictable Recruiter Review**: The recruiter reviews and edits the core campaign sequence (Day 0, Day 3, Day 7) once in the campaign preview card, rather than having to read and verify 50–100 completely disparate full email bodies.
3. **Latency & Token Efficiency**: Single-pass template generation with candidate opening extraction dramatically reduces API calls and avoids exhausting rolling RPM quotas during candidate outreach proposals.

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

---

## Testing & Verification Architecture

The backend test suite is cleanly partitioned into deterministic local integration tests and live LLM validation suites:

### 1. Deterministic Unit & Integration Tests (`npm test`)
- **Execution Command**:
  ```bash
  npm test
  ```
- **Characteristics**:
  - 100% deterministic, zero network dependencies, LLM calls mocked.
  - Fully functional with an **EMPTY `GEMINI_API_KEY`** (requires only local MongoDB and Redis).
  - Covers candidate status state machine transitions, unsubscribe protocol (13 tests), booking token security and slot selection, confirmation gate lifecycle, SSRF defense, sourcing deduplication, and recruitment metrics math.

### 2. Live LLM Verification Tests (`npm run test:live`)
- **Execution Command**:
  ```bash
  npm run test:live
  ```
- **Characteristics**:
  - Executes directly against the configured live Gemini model (`LLM_MODEL=gemini-3.1-flash-lite`).
  - Verifies live prompt injection defenses, XML delimiter isolation (`<untrusted_candidate_reply>`), hostile candidate snippets, and untrusted external link handling with zero mocks.

---

## AI Inference Pricing & Cost Governance

Model inference costs are managed dynamically in `src/config/pricing.config.ts` per Decision DEC-18 and ADR-0015:
- **Gemini 3.1 Flash-Lite**: $0.075 / 1M prompt tokens, $0.30 / 1M completion tokens.
- **Gemini 3.7 Flash**: $0.15 / 1M prompt tokens, $0.60 / 1M completion tokens.

*Note*: In reality, Google AI Studio / Gemini free-tier usage costs $0.00 USD out of pocket. The dollar values tracked in MongoDB and displayed on the dashboard are explicit enterprise rate estimates for transparency and capacity governance.

---

## Honest Architecture Evaluation

### What is Done
- **Autonomous Conversational Agent**: Complete Vercel AI SDK integration streaming tokens via Server-Sent Events (SSE).
- **8 Pending Action Confirmation Cards**: Human-in-the-loop gates for mutating actions with autosave via `PATCH /api/actions/:id/payload`.
- **Asynchronous BullMQ Pipelines**: 4 dedicated workers for sourcing discovery, candidate scoring, multi-step email outreach sequences, and inbound reply triage.
- **Strict 12-Stage Pipeline State Machine**: Governed transitions with validation, 422 rejections for illegal jumps, and immutable `ActivityLog` audit records.
- **Defensive LLM Prompt Engineering**: XML delimiter isolation (`<untrusted_candidate_reply>`, `<untrusted_candidate_profile>`), system instruction boundaries, and `needsReview: true` fallback protocols.
- **Strictly Grounded Personalization**: Candidate openings in outreach emails derived exclusively from verified stored fields without fabrication.
- **Full Unsubscribe & Cancellation Protocol**: Automatic cancellation of pending follow-ups with reason tracking (`replied` | `unsubscribed`) and pause/resume lifecycle compliance.
- **Dynamic Slot Booking Engine**: Generation of 5 business days x 3 UTC slots with cryptographic token validation.
- **Multi-Container Topology (DEC-08)**: Self-contained backend compose (`apps/backend/docker-compose.yml`) and full-stack compose (`deployments/docker-compose.yml`).

### What is Mocked
- **Email Delivery**: Uses Nodemailer Ethereal test account by default (with preview URLs), falling back to console logger if offline, or production SMTP when configured.
- **Candidate Sourcing**: Defaults to 10 realistic deterministic fixtures (`src/data/candidate-fixtures.json`) when `SERPER_API_KEY` is not provided.
- **Candidate Reply Ingestion**: Simulated via `POST /simulate-reply` endpoint rather than an incoming IMAP/webhook email daemon.

### What is Skipped
- **Bidirectional Google Calendar OAuth Sync**: Replaced with self-hosted booking link and dynamic slot reservation per ADR-0008.
- **Multi-Tenant User Management & RBAC**: Single recruiter persona per session without database auth tables.

### Trade-offs
- **Grounded Openings vs 100% LLM Email Generation**: Used pre-approved sequence templates with grounded personal openings (1–2 sentences) to guarantee zero hallucinations and maintain recruiter reviewability.
- **BullMQ Delayed Jobs vs External Schedulers**: Follow-up emails use BullMQ delayed jobs with configurable delay unit (`seconds` in demo, `days` in production) for immediate observability without complex cron dependencies.

### Known Issues
- **Free Tier RPM Limits**: Google AI Studio enforces 15 RPM per project; bulk scoring 10+ candidates concurrently requires semaphore throttling (`WORKER_LLM_MAX_CONCURRENCY=3`) and inter-turn cooling windows.
- **Delayed Message State on Sudden Shutdown**: If Redis is forcibly terminated (`SIGKILL`) while delayed outreach jobs are waiting, in-memory delayed timers rely on BullMQ job recovery on startup.



