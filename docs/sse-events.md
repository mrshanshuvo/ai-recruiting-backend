# Server-Sent Events (SSE) Contracts

- **Purpose**: Definitive event naming conventions, JSON payloads, and client handling semantics for the real-time event stream.
- **Status**: Final
- **Last updated**: 2026-11-13

---

## 1. Stream Endpoint & Handshake

- **Endpoint**: `GET /api/chat/stream/:conversationId`
- **Transport**: HTTP Server-Sent Events (`text/event-stream`)
- **Framing**: Each event follows standard SSE format:
  ```text
  event: <EVENT_TYPE>
  data: <JSON_STRING>
  id: <INCREMENTAL_ID>
  \n\n
  ```

---

## 2. Event Catalog

### 2.1. `CHAT_DELTA`
Emits incremental conversational text tokens from the LLM agent during response generation.
- **Data Payload**:
  ```json
  {
    "messageId": "654c1a2b3c4d5e6f7a8b9c11",
    "delta": "Here are "
  }
  ```
- **Client Behavior**: Appends `delta` to the in-flight assistant message bubble.

---

### 2.2. `CHAT_PART`
Emits a completed part of a chat message (either complete markdown text block or an interactive card).
- **Data Payload**:
  ```json
  {
    "messageId": "654c1a2b3c4d5e6f7a8b9c11",
    "partIndex": 1,
    "part": {
      "type": "card",
      "card": {
        "cardType": "candidate_table",
        "actionId": "654c1a2b3c4d5e6f7a8b9c12",
        "status": "pending",
        "payload": {
          "jobId": "654c1a2b3c4d5e6f7a8b9c0d",
          "candidates": [...]
        }
      }
    }
  }
  ```
- **Client Behavior**: Inserts the rendered card component into the active message thread.

---

### 2.3. `SOURCING_PROGRESS`
Pushes live candidate discovery and scoring telemetry from background workers.
- **Data Payload**:
  ```json
  {
    "jobId": "654c1a2b3c4d5e6f7a8b9c0d",
    "found": 23,
    "scored": 15,
    "total": 23,
    "status": "IN_PROGRESS"
  }
  ```
- **Client Behavior**: Updates the animated progress indicator inside the active chat thread ("Found 23, scored 15...").

---

### 2.4. `CARD_UPDATED`
Notifies the UI when a `PendingAction` transitions state (e.g. confirmed via button or chat).
- **Data Payload**:
  ```json
  {
    "actionId": "654c1a2b3c4d5e6f7a8b9c12",
    "status": "confirmed",
    "result": {
      "jobId": "654c1a2b3c4d5e6f7a8b9c0d",
      "jobTitle": "Senior React Engineer"
    }
  }
  ```
- **Client Behavior**: Updates the card's visual state to `confirmed`, displays a green checkmark badge, and disables all interactive submission buttons.

---

### 2.5. `CANDIDATE_STATUS_CHANGED`
Pushed whenever a candidate's pipeline status changes (via UI button, chat command, or worker reply triage).
- **Data Payload**:
  ```json
  {
    "candidateId": "654c1a2b3c4d5e6f7a8b9c10",
    "jobId": "654c1a2b3c4d5e6f7a8b9c0d",
    "previousStatus": "Contacted",
    "newStatus": "Replied",
    "actor": "worker"
  }
  ```
- **Client Behavior**: Updates the candidate row in review tables, updates pipeline badges, and invalidates React Query dashboard cache.

---

### 2.6. `CAMPAIGN_PROGRESS`
Emits real-time outreach dispatch metrics.
- **Data Payload**:
  ```json
  {
    "campaignId": "654c1a2b3c4d5e6f7a8b9c20",
    "sentCount": 12,
    "totalCount": 12,
    "dailyRemaining": 38,
    "status": "COMPLETED"
  }
  ```
- **Client Behavior**: Updates the campaign preview card to show dispatch completion status.
