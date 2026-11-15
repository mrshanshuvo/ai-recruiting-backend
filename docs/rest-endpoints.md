# REST API Specification

- **Purpose**: Definitive HTTP REST interface specifications, route mappings, request payloads, response bodies, and HTTP status codes.
- **Status**: Final
- **Last updated**: 2026-11-13

---

## 0. Authentication Note (Decision [DEC-10](../99-open-questions.md))

All API endpoints are unauthenticated and open. The system operates as a single-recruiter local workspace. No authentication headers or session cookies are required for local evaluation.

---

## 1. Chat & Conversation Endpoints

### 1.1. Create Conversation Session (Decision [DEC-22](../99-open-questions.md))
Creates a new conversation record in MongoDB, creates an initial welcome assistant message, and returns the conversation ID and static greeting.
- **Method & Path**: `POST /api/conversations`
- **Request Body**: `{}` (empty JSON object)
- **Response**: `201 Created`
  ```json
  {
    "success": true,
    "conversationId": "654c1a2b3c4d5e6f7a8b9c0e",
    "greeting": {
      "messageId": "654c1a2b3c4d5e6f7a8b9c0f",
      "text": "Hello! I am your AI recruiting co-worker. How can I help you source, screen, or reach out to candidates today?"
    }
  }
  ```

### 1.2. Send Chat Message
Dispatches a user message to the conversational agent.
- **Method & Path**: `POST /api/chat/message`
- **Request Body**:
  ```json
  {
    "conversationId": "654c1a2b3c4d5e6f7a8b9c0e",
    "text": "Please create a job for a Senior React Engineer in San Francisco"
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "messageId": "654c1a2b3c4d5e6f7a8b9c11",
    "conversationId": "654c1a2b3c4d5e6f7a8b9c0e"
  }
  ```

### 1.3. Get Conversation History
Loads persistent chat history on page reload.
- **Method & Path**: `GET /api/chat/messages/:conversationId`
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "messages": [
      {
        "_id": "654c1a2b3c4d5e6f7a8b9c11",
        "role": "assistant",
        "parts": [
          { "type": "text", "text": "I parsed your job description. Please review and confirm:" },
          {
            "type": "card",
            "card": {
              "cardType": "job_confirmation",
              "actionId": "654c1a2b3c4d5e6f7a8b9c12",
              "status": "pending",
              "payload": { "title": "Senior React Engineer", "location": "San Francisco" }
            }
          }
        ],
        "createdAt": "2026-11-13T11:20:00.000Z"
      }
    ]
  }
  ```

---

## 2. Confirmation Gate Endpoints

> [!NOTE]
> All editing, payload precedence (`editedPayload || payload`), and confirmation execution behaviors are governed by [Edit and confirm rules](../02-architecture/confirmation-gate.md#3-edit-and-confirm-rules).

### 2.1. Confirm Pending Action
Authorizes execution of a proposed action (Decision [DEC-07](../99-open-questions.md)). See [Edit and confirm rules](../02-architecture/confirmation-gate.md#3-edit-and-confirm-rules).
- **Method & Path**: `POST /api/actions/:id/confirm`
- **Request Body**: (Optional `modifiedPayload`; if present, validated and saved into `editedPayload` before execution per [Edit and confirm rules](../02-architecture/confirmation-gate.md#3-edit-and-confirm-rules))
  ```json
  {
    "modifiedPayload": {
      "salaryRange": { "min": 150000, "max": 190000, "currency": "USD" }
    }
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "actionId": "654c1a2b3c4d5e6f7a8b9c12",
    "status": "EXECUTED",
    "result": { "jobId": "654c1a2b3c4d5e6f7a8b9c0d" }
  }
  ```

### 2.2. Cancel Pending Action
Rejects and invalidates a proposed action.
- **Method & Path**: `POST /api/actions/:id/cancel`
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "actionId": "654c1a2b3c4d5e6f7a8b9c12",
    "status": "CANCELLED"
  }
  ```

### 2.3. Autosave Edited Action Payload (Decision [DEC-17](../99-open-questions.md))
Autosaves inline card edits per [Edit and confirm rules](../02-architecture/confirmation-gate.md#3-edit-and-confirm-rules). Updates `PendingAction.editedPayload` while status is `PENDING`.
- **Method & Path**: `PATCH /api/actions/:id/payload`
- **Request Body**:
  ```json
  {
    "editedPayload": {
      "subject": "Updated Subject Line",
      "body": "Updated email body text..."
    }
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "actionId": "654c1a2b3c4d5e6f7a8b9c12",
    "status": "PENDING"
  }
  ```

---

## 3. Job Endpoints

### 3.1. List Jobs
- **Method & Path**: `GET /api/jobs`
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "jobs": [
      {
        "_id": "654c1a2b3c4d5e6f7a8b9c0d",
        "title": "Senior React Engineer",
        "seniority": "Senior",
        "status": "OPEN"
      }
    ]
  }
  ```

### 3.2. Get Job Details & Stats (Checkpoint 9 / DEC-18)
- **Method & Path**: `GET /api/jobs/:id/stats`
- **Current Distribution vs Ever-Reached Definition (DEC-20)**:
  - **Current Status Distribution (`currentStatusCounts`)**: Represents the exact number of candidates currently sitting in each of the 12 pipeline stages right now (`Sourced`, `Accepted`, `Rejected`, `Contacted`, `Replied`, `Interested`, `Not interested`, `Unsubscribed`, `Meeting booked`, `Interviewed`, `Shortlisted`, `Hired`). The sum of all counts equals `totalCandidates`. All 12 keys are guaranteed to be present (defaulting to `0`).
  - **Milestone Totals (`everReached`)**: Cumulative number of unique candidates who have ever reached key milestones in the funnel, even if they later advanced (e.g. from `Interested` to `Meeting booked`, `Hired`, or `Unsubscribed`):
    - `totalCandidates`: Total unique candidates sourced and ingested for this job.
    - `contacted`: Candidates who were ever contacted (`contactedAt != null` or advanced past `Accepted`).
    - `replied`: Candidates who ever sent an inbound reply (verified via `Reply` model or `ActivityLog`).
    - `interested`: Candidates who ever expressed interest or requested a meeting (`Reply.replyClass` in `['Interested', 'Wants a meeting']` or `ActivityLog` transition to `Interested`/`Meeting booked`).
    - `meetings`: Candidates who ever reached `Meeting booked` (`status === 'Meeting booked'` or `meetingSlot != null` or `ActivityLog` transition to `Meeting booked`).
    - `hires`: Candidates currently in status `Hired`.
  - `rates`:
    - `replyRate`: `replied / contacted`. If `contacted === 0`, safely returns `"n/a"`.
    - `interestedRate`: `ever interested / contacted`. If `contacted === 0`, safely returns `"n/a"`.
  - `sourceBreakdown`: Breakdown of candidate profiles discovered by `sourceMode` (`serper`, `fixture`, `csv`).
  - `campaignSummary`: Total campaigns for this job, total sent outreach messages, total pending/queued outreach jobs, total cancelled messages, and campaign active/paused state.
  - `tokenUsage`: Aggregated LLM token consumption (`promptTokens`, `completionTokens`, `totalTokens`) and `estimatedCostUsd` ($0.075 / 1M prompt, $0.30 / 1M completion for Gemini Flash-Lite), broken down by caller (`agent`, `worker:scoring`, `worker:reply-classification`, `worker:drafting`).
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "stats": {
      "jobId": "654c1a2b3c4d5e6f7a8b9c0d",
      "jobTitle": "Senior Frontend Engineer (React & TypeScript)",
      "everReached": {
        "totalCandidates": 20,
        "contacted": 12,
        "replied": 6,
        "interested": 4,
        "meetings": 3,
        "hires": 1
      },
      "rates": {
        "replyRate": 0.5,
        "replyRateFormatted": "50.0%",
        "interestedRate": 0.3333,
        "interestedRateFormatted": "33.3%"
      },
      "currentStatusCounts": {
        "Sourced": 5,
        "Accepted": 3,
        "Rejected": 0,
        "Contacted": 2,
        "Replied": 1,
        "Interested": 1,
        "Not interested": 1,
        "Unsubscribed": 1,
        "Meeting booked": 2,
        "Interviewed": 2,
        "Shortlisted": 1,
        "Hired": 1
      },
      "sourceBreakdown": {
        "fixture": 10,
        "csv": 10,
        "serper": 0
      },
      "campaignSummary": {
        "campaignsCount": 1,
        "sentMessages": 12,
        "queuedMessages": 0,
        "cancelledMessages": 2,
        "isPaused": false
      },
      "tokenUsage": {
        "totalPromptTokens": 42500,
        "totalCompletionTokens": 6200,
        "totalTokens": 48700,
        "totalEstimatedCostUsd": 0.005048,
        "byCaller": {
          "agent": { "promptTokens": 15000, "completionTokens": 2000, "totalTokens": 17000, "estimatedCostUsd": 0.001725 },
          "worker:scoring": { "promptTokens": 20000, "completionTokens": 2500, "totalTokens": 22500, "estimatedCostUsd": 0.002250 },
          "worker:reply-classification": { "promptTokens": 7500, "completionTokens": 1700, "totalTokens": 9200, "estimatedCostUsd": 0.001073 }
        }
      }
    }
  }
  ```

  *Note on Costs*: Google AI Studio Gemini API free-tier usage costs $0.00 USD out of pocket. The USD cost estimates tracked in MongoDB and returned here represent enterprise-tier capacity rate governance ($0.075 / 1M prompt, $0.30 / 1M completion).

### 3.3. Get Job Activity Log (Decision [DEC-18](../99-open-questions.md))
Returns a cursor-paginated timeline of events for a job, optionally filtered to a specific candidate.
- **Method & Path**: `GET /api/jobs/:id/activity?candidateId=&limit=&cursor=`
- **Query Parameters**:
  - `candidateId` (optional): Filter events to a specific candidate.
  - `limit` (optional): Number of records per page (default: 20, max: 100).
  - `cursor` (optional): Activity record ID (`_id`) for cursor-based pagination.
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "activities": [
      {
        "_id": "654c1a2b3c4d5e6f7a8b9c99",
        "jobId": "654c1a2b3c4d5e6f7a8b9c0d",
        "candidateId": "654c1a2b3c4d5e6f7a8b9c10",
        "eventType": "CANDIDATE_STATUS_CHANGED",
        "details": {
          "previousStatus": "Interested",
          "newStatus": "Meeting booked",
          "reason": "Recruiter approved booking link email"
        },
        "createdAt": "2026-11-13T12:00:00.000Z"
      }
    ],
    "nextCursor": "654c1a2b3c4d5e6f7a8b9c88"
  }
  ```

---

## 4. Candidate Endpoints

### 4.1. List Candidates for Job
- **Method & Path**: `GET /api/jobs/:id/candidates?status=Accepted`
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "candidates": [
      {
        "_id": "654c1a2b3c4d5e6f7a8b9c10",
        "fullName": "Sarah Chen",
        "email": "sarah.chen@example.com",
        "score": 92,
        "scoreStatus": "scored",
        "scoreReason": "Strong React/TypeScript experience",
        "status": "Accepted",
        "source": "search"
      }
    ]
  }
  ```

### 4.2. Upload Candidates CSV (Decision [DEC-16](../99-open-questions.md))
Direct recruiter upload. Bypasses confirmation gate because it is an explicit human action.
- **Method & Path**: `POST /api/jobs/:id/candidates/upload-csv`
- **Content-Type**: `multipart/form-data`
- **Form Fields**:
  - `file`: CSV file (required)
  - `conversationId`: Optional conversation ID. If provided, the backend inserts an assistant chat message summarizing the upload in the chat feed.
- **Response**: `201 Created`
  ```json
  {
    "success": true,
    "importedCount": 15,
    "deduplicatedCount": 2,
    "jobId": "654c1a2b3c4d5e6f7a8b9c0d",
    "summary": "Imported 15 candidates (2 duplicates skipped)"
  }
  ```

### 4.3. Update Candidate Status
Direct status mutation from UI controls (dropdown or drawer action). Bypasses confirmation gate (Decision [DEC-16](../99-open-questions.md)).
- **Method & Path**: `PATCH /api/candidates/:id/status`
- **Request Body**:
  ```json
  {
    "newStatus": "Hired",
    "reason": "Recruiter approved final offer"
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "candidateId": "654c1a2b3c4d5e6f7a8b9c10",
    "previousStatus": "Shortlisted",
    "newStatus": "Hired"
  }
  ```

---

## 5. Booking Endpoints (Decisions [DEC-02](../99-open-questions.md), [DEC-19](../99-open-questions.md))

Candidate-facing mock booking endpoints using an unguessable 24-byte hex booking token (`Candidate.bookingToken`).

### 5.1. Get Booking Page Details
Loads candidate and job details for the booking slot picker view.
- **Method & Path**: `GET /api/booking/:token`
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "candidateName": "Sarah Chen",
    "jobTitle": "Senior React Engineer",
    "status": "Meeting booked",
    "meetingSlot": null,
    "availableSlots": [
      "2026-11-18T14:00:00.000Z",
      "2026-11-18T16:00:00.000Z",
      "2026-11-19T10:00:00.000Z",
      "2026-11-19T15:00:00.000Z"
    ]
  }
  ```

### 5.2. Select Booking Slot
Submits the candidate's chosen meeting slot. Stores `meetingSlot` on the candidate and writes an ActivityLog entry. Does not change candidate status (the status was already set to `Meeting booked` when the link was sent).
- **Method & Path**: `POST /api/booking/:token/slot`
- **Request Body**:
  ```json
  {
    "slot": "2026-11-18T14:00:00.000Z"
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "candidateId": "654c1a2b3c4d5e6f7a8b9c10",
    "meetingSlot": "2026-11-18T14:00:00.000Z",
    "status": "Meeting booked"
  }
  ```

---

## 6. Reply Simulation Endpoint (Decision [DEC-15](../99-open-questions.md))

Simulates an inbound candidate email response. Route is strictly `POST /simulate-reply` (no `/api` prefix, exactly per assignment).
- **Method & Path**: `POST /simulate-reply`
- **Request Body**:
  ```json
  {
    "candidateId": "654c1a2b3c4d5e6f7a8b9c10",
    "message": "Hi! I would love to meet and discuss this role. When are you free?"
  }
  ```
- **Response**: `202 Accepted`
  ```json
  {
    "success": true,
    "message": "Reply enqueued for triage",
    "candidateId": "654c1a2b3c4d5e6f7a8b9c10"
  }
  ```

---

## 7. Standard Error Response Shape

All errors return a uniform JSON format:
```json
{
  "success": false,
  "error": {
    "code": "INVALID_STATE_TRANSITION",
    "message": "Cannot transition candidate directly from Sourced to Hired.",
    "details": { "allowedTransitions": ["Accepted", "Rejected"] }
  }
}
```
