# Sprint 1 Test Results & Verification Report

**Project:** Nam Sa-ard Water Kiosk System (Backend Server)  
**Sprint Goal:** Establish reliable kiosk-to-server connectivity, core database storage, and offline-first data caching with automated synchronization and corruption checks.  
**Status:** ✅ **ALL PASS (100% Pass Rate)**

---

## 1. Executive Summary

All automated test suites and live browser verification scenarios for Sprint 1 have been executed and verified. The system satisfies 100% of the functional requirements and Definition of Done (DoD) criteria defined across all 5 user stories:

| Story ID | Description | Automated Tests | Live Simulation | Status |
| :--- | :--- | :---: | :---: | :---: |
| **Story 01** | Connect Kiosk to Server & Heartbeat Tracking | ✅ Passed (12 tests) | ✅ Verified | **READY** |
| **Story 02** | Store Data into Database & Idempotency | ✅ Passed (28 tests) | ✅ Verified | **READY** |
| **Story 14-1** | Offline Data Storing Cache (`offline_tx_queue`) | ✅ Passed (15 tests) | ✅ Verified | **READY** |
| **Story 14-2** | Offline Data Corrupted Checker (SHA-256 & Quarantine) | ✅ Passed (42 tests) | ✅ Verified | **READY** |
| **Story 14-3** | Offline Auto-Sync Under Unstable Network | ✅ Passed (46 tests) | ✅ Verified | **READY** |

---

## 2. Automated Test Execution Summary

### 2.1 Overall Test Metrics

```text
================================================================================
Test Category         Suites Passed   Tests Passed   Failed   Execution Time
================================================================================
Server Unit Tests     8 / 8 suites    109 passed     0 fail   ~1.6 seconds
Server E2E Tests      5 / 5 suites     37 passed     0 fail   ~202 seconds (Supabase Cloud)
Client Unit Tests     5 / 5 suites    106 passed     0 fail   ~0.14 seconds
Code Quality (Lint)   28 files        0 warnings     0 errors ~0.19 seconds
================================================================================
Total Automated Tests:                252 passed     0 fail   100% Passing
================================================================================
```

---

## 3. Detailed Test Suite Breakdown

### 3.1 Story 14-3: Offline Auto-Sync Under Unstable Network (`test/offline-sync.e2e-spec.ts`)
Executes an end-to-end integration loop using a live fault-injecting proxy (`NetworkSimulator`) and reference client (`KioskSimulator`) against the real NestJS server and PostgreSQL database:

| # | Test Scenario | Expected Behavior | Result |
| :-: | :--- | :--- | :---: |
| 1 | **DoD Spec Cycle** (`Online` $\rightarrow$ `Offline` (3 logs) $\rightarrow$ `Online`) | All 3 records persist to DB and local queue empties within 10s without manual action | ✅ PASS |
| 2 | **Page Reload / Client Crash While Offline** | Records persist across browser reloads via `localStorage` and sync on reconnect | ✅ PASS |
| 3 | **False `online` Event / Captive Portal** | Dispatcher holds queue until confirmed by a successful `/api/kiosk/heartbeat` ping | ✅ PASS |
| 4 | **Lost ACK Response (Idempotency)** | Server stores record; connection drops before ACK; client retries; server returns 409; client marks synced without duplicate DB rows | ✅ PASS |
| 5 | **Flapping Network Link** | Intermittent connection cycling during sync; no records lost, queue completes FIFO sync | ✅ PASS |
| 6 | **Lossy & High-Latency Network** | Random 25% packet drop, 15% 503 error, and jitter; backoff retries succeed | ✅ PASS |
| 7 | **Stalled Link (Blackhole / Timeout)** | Hanging requests trigger 1500ms client timeout and recover once link restores | ✅ PASS |
| 8 | **Corrupted Payload Quarantine (Story 14-2)** | Tampered cache entries rejected with HTTP 422; quarantined without blocking subsequent valid entries | ✅ PASS |
| 9 | **Non-ACK Response (Captive Portal 200)** | Response returning 200 without server ACK is not marked synchronized | ✅ PASS |
| 10 | **Reused Transaction Conflict (Story 14-2)** | Same transactionId reused with different payload is rejected and quarantined | ✅ PASS |

### 3.2 Story 02 & 14-2: Payload Integrity & Write Operations (`test/payload-integrity.e2e-spec.ts`)
| Test Case | Description | Result |
| :--- | :--- | :---: |
| `Valid Ingestion` | Valid telemetry payload with SHA-256 `v1` checksum writes to database and returns HTTP 201 | ✅ PASS |
| `DB Bit-for-bit Verification` | Reads row directly from database to verify volume, timestamp, and checksum match exactly | ✅ PASS |
| `Null Checksum Support` | Backwards compatibility with payloads without optional checksum | ✅ PASS |
| `Validation Rejections` | Missing `transactionId`, missing `kioskId`, negative/zero volume, invalid ISO date rejected with HTTP 400 | ✅ PASS |
| `Whitelist Stripping` | Malicious injected fields (`maliciousAdminFlag`, `extraInjectedData`) stripped by ValidationPipe | ✅ PASS |
| `Foreign Key Integrity` | Logs referencing non-existent kiosk rejected with HTTP 404; no orphan records created | ✅ PASS |
| `Idempotency Protection` | Duplicate submission with same `transactionId` rejected with HTTP 409 Conflict | ✅ PASS |

### 3.3 Story 02: High-Concurrency & Load Testing (`test/load.e2e-spec.ts`)
Simulates concurrent write bursts to measure throughput, latency, and database integrity:
* **Total Requests:** 100 writes
* **Concurrency Level:** 10 concurrent workers
* **Success Rate:** 100% (100 / 100 successful writes, 0 failures)
* **Average Latency:** ~2660 ms (Cloud Supabase transaction pooler)
* **Race Condition Test:** 10 simultaneous parallel requests with the identical `transactionId` $\rightarrow$ Exactly 1 succeeds (HTTP 201), remaining 9 safely acknowledged/rejected (HTTP 409 Conflict), exactly 1 record created in database.

### 3.4 Story 01: Heartbeat & Status Registry (`test/kiosk-heartbeat.e2e-spec.ts`)
* Normal heartbeat updates kiosk to `ONLINE` with current UTC timestamp.
* **Proactive Background Sweeper (`onModuleInit`):** Sweeper runs every 5 seconds in background. If a kiosk stops sending pings for > 30 seconds, it automatically transitions status in the database (Supabase) to `OFFLINE` without waiting for manual API calls.
* If `getKioskStatus()` is queried, it also evaluates heartbeat timeliness and returns accurate `ONLINE`/`OFFLINE` status.

---

## 4. Live Browser Demonstration & Simulation Guide

This procedure outlines the exact manual acceptance testing steps for live demonstration (Sprint 1 DoD #4).

### 4.1 Service Ports
* **Backend API Server:** `http://localhost:3001`
* **Frontend Kiosk Operator:** `http://localhost:3000`

### 4.2 Step-by-Step Simulation Procedure

```text
[Step 1: Online] ──▶ [Step 2: Switch Offline] ──▶ [Step 3: Submit & Refresh] ──▶ [Step 4: Tamper Payload] ──▶ [Step 5: Reconnect & Verify]
```

1. **Step 1 — Verify Online Baseline:**
   - Open browser at `http://localhost:3000`.
   - Observe status banner: Green indicator **`Online`** with latest Heartbeat timestamp.
   - Enter `10.5` liters and submit $\rightarrow$ Alert: *"Transaction submitted successfully!"*, row persisted to Supabase `daily_logs`.

2. **Step 2 — Simulate Network Cut:**
   - Open Chrome DevTools (`F12`) $\rightarrow$ Navigate to **Network** tab.
   - Change throttling from *No throttling* to **`Offline`**.
   - Observe status banner updates immediately to: **`Offline Mode — Data saved locally`**.

3. **Step 3 — Submit Offline Records & Verify Retention:**
   - Submit 3 consecutive readings: `15.0`, `22.5`, `31.0`.
   - Each submission alerts: *"Offline Mode: Transaction saved to local queue."*
   - Counter displays: **`Pending entries: 3`**.
   - Press `F5` to reload the page while still offline $\rightarrow$ **Pending entries remains 3** (data retention verified).
   - Inspect DevTools $\rightarrow$ **Application** $\rightarrow$ **Local Storage** $\rightarrow$ `offline_tx_queue`: Verify JSON array contains all 3 objects with `checksum` field.

4. **Step 4 — Test Tampered Record Quarantine (Story 14-2):**
   - In DevTools Local Storage, edit the 2nd record (`meter_volume` from `22.5` to `9999`) without modifying its `checksum`.

5. **Step 5 — Restore Connectivity & Verify Auto-Sync (Story 14-3):**
   - Switch DevTools Network back to **`No throttling`** (Online).
   - Kiosk automatically detects reconnection, confirms via Heartbeat, and triggers background sequential dispatch.
   - Valid records (`15.0` and `31.0`) sync successfully to database.
   - Tampered record (`9999`) is rejected by server with HTTP 422 and moved to `quarantine_queue`.
   - **`Pending entries` count drops to `0` within 10 seconds** without manual intervention.

---

## 5. Definition of Done (DoD) Checklist

- [x] **Criterion 1:** All code pushed to shared Git repository and merged via Pull Request.
- [x] **Criterion 2:** All 5 User Stories (`01`, `02`, `14-1`, `14-2`, `14-3`) pass their unit and integration tests.
- [x] **Criterion 3:** Database schema is deployed on the shared cloud database (Supabase PostgreSQL) and accessible by team members.
- [x] **Criterion 4:** End-to-end offline-to-online simulation works smoothly during live browser demonstration.
