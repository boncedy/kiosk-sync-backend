# Sprint 1 Technical Requirements & Implementation Specification
**Sprint Goal:** Establish reliable kiosk-to-server connectivity, core database storage, and offline-first data caching with automated synchronization and corruption checks.  
**Total Estimated Effort:** 30 Hours

---

## 1. System Architecture & Technology Stack (Academic Scope)
To ensure practical and rapid development within an academic setting without requiring physical kiosk hardware or paid enterprise infrastructure, the system uses a lightweight simulation architecture:

* **Kiosk Client (Simulator):** Web-based application (HTML/JS or React/Vue) running in a modern browser to simulate kiosk screen interactions and network interruptions.
* **Client-Side Storage:** Browser `IndexedDB` (or `LocalStorage`) to simulate on-device local offline cache.
* **Backend Server:** RESTful API server (Node.js/Express or Python/FastAPI) running locally or on a free cloud tier.
* **Database Hosting:** Cloud-hosted PostgreSQL (via **Supabase** or **Neon.tech** Free Tier) for shared team access, or **SQLite** for local testing.
* **Network Simulation:** Chrome DevTools Network Throttling (`Online` / `Offline` presets) and simulated API response delays.

---

## 2. User Stories & Functional Requirements (Ordered by Priority)

### Priority 1 — ID 01: Connect Kiosk to Server (4 Hours)
**Objective:** Enable the kiosk client to maintain a live connection status with the backend server and gracefully handle network drops.

| Task Description | Owner | Implementation Guideline |
| :--- | :--- | :--- |
| **Implement automated heartbeat ping client on kiosk module** | Ball | Use a JavaScript timer (`setInterval`) to send an HTTP `POST /api/heartbeat` request containing `kiosk_id` and `timestamp` every 10 seconds. |
| **Build server endpoint to receive heartbeat and update kiosk "Online" status registry** | Project | Create the `/api/heartbeat` endpoint. Update the `last_seen` timestamp in the server registry/DB. Mark kiosks as `Offline` if no ping is received within 30 seconds. |
| **Implement connection retry backoff loop and timeout trigger on network drop** | Pun | Wrap client HTTP requests with a timeout (e.g., 5 seconds). On failure, trigger an exponential backoff retry loop (e.g., wait $2\text{ s}, 4\text{ s}, 8\text{ s}$) before marking the connection as dropped. |
| **Create unit and integration tests for heartbeat ping and disconnection timeouts** | Earn | Write automated tests (Jest/Pytest) to verify that normal pings return `200 OK` and simulated timeouts properly trigger the offline state. |

**Acceptance Criteria (DoD):**
* Server accurately reflects `Online` status when the kiosk simulator is running.
* Server status changes to `Offline` within 30 seconds of disconnecting the client.

---

### Priority 2 — ID 02: Store Data into Database Server (6 Hours)
**Objective:** Persist kiosk meter readings and transaction logs reliably into the central relational database without duplicate records.

| Task Description | Owner | Implementation Guideline |
| :--- | :--- | :--- |
| **Design database relational schema for daily logs, meter volumes, and kiosk ID** | Project | Create tables (`kiosks`, `daily_logs`) on Supabase/PostgreSQL with fields: `transaction_id (UUID, PK)`, `kiosk_id`, `meter_volume`, `payload_hash`, `created_at`. |
| **Develop REST API endpoint with payload validation and timestamp generation** | Wuth | Build `POST /api/logs`. Validate required fields (`kiosk_id`, `meter_volume` $\ge 0$) and attach a server-side UTC timestamp before saving. |
| **Implement idempotency check to detect and reject duplicate submissions from retries** | Ball | Check if `transaction_id` already exists in `daily_logs`. If found, return `200 OK` (or `409 Conflict` with safe ignore) without inserting a duplicate row. |
| **Perform load and payload integrity testing for database write operations** | Sour | Use Postman or a test script to send concurrent requests and duplicate payloads, verifying data integrity in the database. |

**Acceptance Criteria (DoD):**
* Valid payloads are stored in the cloud database with accurate timestamps.
* Resending the exact same `transaction_id` multiple times results in only **one** database record.

---

### Priority 3 — ID 14-1: Offline Data Storing Cache (6 Hours)
**Objective:** Allow operators to continue submitting data during network outages by caching records locally on the client device.

| Task Description | Owner | Implementation Guideline |
| :--- | :--- | :--- |
| **Configure client-side storage (IndexedDB / LocalStorage) schema for offline records** | Pun | Initialize a local store/key named `offline_tx_queue` structured to hold an array of pending JSON transaction objects. |
| **Implement local queue to store multiple consecutive offline transactions** | Earn | Build a queue manager (`enqueue`, `dequeue`, `peekAll`) that appends new transactions in chronological order (FIFO) when the server is unreachable. |
| **Build offline status banner on the operator mobile/kiosk interface** | Sour | Create a visual UI banner (e.g., *"Offline Mode: Data saved locally"*) that appears automatically when disconnection is detected. |
| **Test offline form submissions and data retention during simulated network cuts** | Wuth | Switch browser DevTools to `Offline`, submit 5 consecutive forms, refresh the browser, and verify all 5 records remain intact in client storage. |

**Acceptance Criteria (DoD):**
* UI displays the offline warning banner immediately upon connection loss.
* Multiple transactions submitted while offline persist across page reloads.

---

### Priority 4 — ID 14-2: Offline Data Corrupted Checker (10 Hours)
**Objective:** Prevent corrupted or tampered local cache data from polluting the central database during synchronization.

| Task Description | Owner | Implementation Guideline |
| :--- | :--- | :--- |
| **Create checksum / hash generator for local cached payloads before upload** | Ball | Generate a SHA-256 hash (using Web Crypto API) of the core payload (`transaction_id + kiosk_id + meter_volume`) when caching locally, and attach it as `checksum`. |
| **Build server-side conflict detection mechanism comparing server state with local data** | Project | Before inserting synced records, verify that the incoming meter reading does not conflict with newer existing server state for the same kiosk. |
| **Implement invalid payload isolation and rejection handling** | Wuth | Recompute the SHA-256 hash on the server. If it mismatches the client's `checksum` or fails schema validation, reject the record with `422 Unprocessable Entity` and move it to a client-side `quarantine_queue`. |
| **Write automated edge-case tests for corrupted JSON payloads and schema conflicts** | Earn | Write test cases that intentionally modify cached JSON values in `LocalStorage` before syncing to verify the server rejects corrupted entries. |

**Acceptance Criteria (DoD):**
* Tampered local records fail the checksum check and are rejected by the server.
* Corrupted records are isolated on the client without blocking valid records in the queue from syncing.

---

### Priority 5 — ID 14-3: Offline Data Auto-Sync After Reconnection (4 Hours)
**Objective:** Automatically flush the local offline cache to the server in sequential order once network connectivity is restored.

| Task Description | Owner | Implementation Guideline |
| :--- | :--- | :--- |
| **Implement network listener to detect active cellular/internet reconnection** | Pun | Listen to browser `window.addEventListener('online')` combined with a successful `/api/heartbeat` ping confirmation. |
| **Build automated sequential background dispatcher to push pending records** | Ball | Iterate through `offline_tx_queue` sequentially (`async/await` loop) and send each record to `POST /api/logs`. |
| **Implement server ACK confirmation and mark local records as "Synchronized"** | Sour | Upon receiving HTTP `200/201` ACK from the server, remove the synced item from `offline_tx_queue` (or update status to `Synchronized`) and update the UI counter. |
| **Perform end-to-end sync verification tests under unstable network simulations** | Project | Simulate an end-to-end cycle: Online $\rightarrow$ Offline (submit 3 records) $\rightarrow$ Online $\rightarrow$ Verify all 3 records appear in the database and local queue is cleared. |

**Acceptance Criteria (DoD):**
* Pending offline records automatically sync to the server within 10 seconds of reconnection without manual user intervention.
* Local queue is emptied once all records receive server acknowledgment.

---

## 3. Data Contract & API Specification (Shared Reference)

### 3.1 Heartbeat Endpoint
* **URL:** `POST /api/heartbeat`
* **Request Body:**
```json
{
  "kiosk_id": "KIOSK-001",
  "client_timestamp": "2026-10-14T10:00:00Z"
}
```
* **Response (`200 OK`):**
```json
{
  "status": "ONLINE",
  "server_timestamp": "2026-10-14T10:00:01Z"
}
```

### 3.2 Log Submission & Sync Endpoint
* **URL:** `POST /api/logs`
* **Request Body:**
```json
{
  "transaction_id": "550e8400-e29b-41d4-a716-446655440000",
  "kiosk_id": "KIOSK-001",
  "meter_volume": 125.50,
  "recorded_at": "2026-10-14T10:05:00Z",
  "checksum": "a3f5c8e9b2d1..."
}
```
* **Responses:**
  * `201 Created` / `200 OK`: Record saved or idempotent duplicate acknowledged (`{"ack": true, "status": "SYNCHRONIZED"}`).
  * `422 Unprocessable Entity`: Checksum mismatch or corrupted payload (`{"ack": false, "error": "CORRUPTED_PAYLOAD"}`).

---

## 4. Definition of Done (DoD) for Sprint 1
1. All code is pushed to the shared Git repository and merged via Pull Request.
2. All 5 User Stories (`01`, `02`, `14-1`, `14-2`, `14-3`) pass their unit and integration tests.
3. Database schema is deployed on the shared cloud database (Supabase/Neon) and accessible by all team members.
4. End-to-end offline-to-online simulation works smoothly during live browser demonstration.