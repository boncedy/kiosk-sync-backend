# Sprint 2 Technical Requirements & Implementation Specification
**Sprint Goal:** Implement tamper-evident digital receipts, automated data reconciliation with anomaly detection, high-performance historical archive querying, Google Sheets synchronization, and stakeholder analytics with PDF/CSV reporting.  
**Total Estimated Effort:** 42 Points (Academic Sprint Scope)

---

## 1. System Architecture & Technology Stack (Sprint 2 Extensions)
Building upon the NestJS + Bun backend and Supabase PostgreSQL database established in Sprint 1, Sprint 2 introduces analytical processing, external API synchronization, and managerial reporting views:

* **Field Operator & Manager Web Clients:** Decoupled React/Next.js views for Field Operators (cash/liter submission & digital receipts) and Operation Managers / Stakeholders (dashboards, anomaly tables, filters, and e-reports).
* **Backend Server:** NestJS (running on Bun) handling reconciliation calculations, SHA-256 verification, cursor-based pagination, and report generation.
* **Database Hosting:** Cloud-hosted PostgreSQL on **Supabase** with composite indexing (`kiosk_id`, `recorded_at`) and audit tables (`system_audit_logs`).
* **External Integration:** Google Sheets API v4 (via Service Account authentication) coupled with a scheduled background cron job (`@nestjs/schedule`) and retry queue.
* **Report Generation:** Server-side or stream-based CSV formatting and PDF document generation (`pdfkit` or `jspdf`).

---

## 2. User Stories & Functional Requirements (Ordered by Priority)

### Priority 1 — ID 05: Implement Legal Volume Proving (½ Point)
**Objective:** Generate a tamper-evident digital proof receipt when field operators submit daily cash and liter entries, and allow read-only checksum verification during management disputes.

| Task Description | Owner | Implementation Guideline |
| :--- | :--- | :--- |
| **Generate SHA-256 cryptographic checksum and tamper-evident receipt payload upon daily log submission** | Wuth | Extend `POST /api/kiosk/logs` (or `/daily-submission`) to accept `operatorId` and `reportedCash`. Compute server-side `SHA-256(kioskId + operatorId + meterVolume + reportedCash + recordedAt)` and return a signed receipt object. |
| **Build daily cash and liter submission form with digital proof receipt view for Field Operators** | Ball | Create the operator submission form. Upon `201 Created`, display a printable/savable digital receipt card showing Timestamp, Operator ID, Liter Volume, Cash Submitted, and Checksum Hash. |
| **Create read-only historical log inspection modal with checksum verification badge for Operation Managers** | Sor | Build a read-only detail modal in the manager view. Fetch log details and display a green `"Verified (Tamper-Evident)"` or red `"Checksum Mismatch"` badge. |
| **Write integration tests for checksum validation and tamper-detection on modified log entries** | Earn | Write Jest tests verifying that valid submissions generate matching hashes and simulated direct DB mutations trigger a verification failure on inspection. |

**Acceptance Criteria (DoD):**
* Submitting the daily form immediately returns a digital receipt displaying timestamp, operator ID, liter volume, cash submitted, and cryptographic checksum.
* Inspecting any historical entry displays a read-only proof view with live checksum verification to protect against false blame.

---

### Priority 2 — ID 04: Interpret Data (13 Points)
**Objective:** Automatically calculate expected revenue versus reported cash (variance metrics) and flag daily volume anomalies that deviate beyond $\pm 30\%$ of the historical moving average.

| Task Description | Owner | Implementation Guideline |
| :--- | :--- | :--- |
| **Build daily batch reconciliation engine to calculate expected revenue vs. reported cash and variance metrics** | Project | Implement reconciliation logic: $\text{Expected Revenue} = \text{Meter Volume} \times \text{Unit Price}$, and $\text{Variance} = \text{Reported Cash} - \text{Expected Revenue}$. Calculate discrepancy ratio $\%$. |
| **Implement moving-average baseline algorithm to flag daily volume anomalies exceeding $\pm 30\%$ threshold** | Project | Query historical baseline volume for the kiosk (e.g., last 7 or 30 entries). Flag `isAnomaly = true` if $\|\text{Current Volume} - \text{Moving Avg}\| > 0.30 \times \text{Moving Avg}$. |
| **Update Prisma schema to store variance metrics and anomaly classification flags with query endpoints** | Pun | Add `reportedCash`, `expectedRevenue`, `variance`, and `isAnomaly` to `DailyLog` in `schema.prisma`. Expose `GET /api/kiosk/reconciliation` to query interpreted records. |
| **Build Operations Review UI table highlighting flagged anomaly records and revenue variance alerts** | Sor | Create the Operations Review table. Highlight rows where `isAnomaly === true` or `variance < 0` with warning badges for immediate manager triage. |
| **Create unit and boundary test suites for $\pm 30\%$ moving-average anomaly detection and revenue variance formulas** | Earn | Test boundary conditions (exact $\pm 29.9\%$, $\pm 30.0\%$, $\pm 30.1\%$ spikes/drops, and zero-baseline edge cases) using Jest unit tests. |

**Acceptance Criteria (DoD):**
* Daily batch processing accurately outputs expected revenue, reported cash, and variance metrics for every submission.
* Records with volume drops or spikes beyond $\pm 30\%$ of the kiosk's moving average are automatically classified and highlighted as anomalies.

---

### Priority 3 — ID 08: Retrieve Data from Database (20 Points)
**Objective:** Display unseen records to operation managers upon opening the dashboard and enable non-blocking, indexed pagination for historical archives without stalling real-time listeners.

| Task Description | Owner | Implementation Guideline |
| :--- | :--- | :--- |
| **Add database composite indexes on timestamps and implement cursor-based pagination API for historical archives** | Project | Add `@@index([kioskId, recordedAt(sort: Desc)])` in Prisma. Implement `GET /api/kiosk/logs/archive?cursor=<id>&limit=20` using Prisma cursor pagination. |
| **Implement unseen-records tracking state per Operation Manager in Prisma to filter unread dashboard logs** | Wuth | Add `isReadByManager` (or a `ManagerReadState` timestamp table) and support `GET /api/kiosk/logs?unseenOnly=true` plus `PATCH /api/kiosk/logs/mark-seen`. |
| **Build non-blocking infinite scroll / pagination client fetcher alongside active real-time listeners** | Pun | Implement asynchronous archive fetching on scroll/page click in a separate state slice so incoming real-time heartbeat/log streams are never blocked or dropped. |
| **Integrate unread badge indicators and historical log table view on the Kiosk Dashboard** | Sor | Show an `"Unseen Logs"` section/badge on dashboard load, and smoothly append historical pages when the manager scrolls or clicks pagination controls. |
| **Perform load and concurrency testing on paginated archive queries while active real-time listeners are running** | Earn | Seed 500+ historical log records in Supabase. Verify pagination response times remain fast ($< 200\text{ ms}$) while concurrent real-time POST requests are active. |

**Acceptance Criteria (DoD):**
* Opening the dashboard highlights or filters records that the operation manager has not seen yet.
* Scrolling or paginating through historical archives queries indexed tables smoothly without stalling active real-time dashboard updates.

---

### Priority 4 — ID 03: Sync Data to Sheets Automatically (2 Points)
**Objective:** Append approved transaction and reconciliation logs to a configured Google Spreadsheet on a schedule, queuing failed rows for retry and auditing errors when rate limits or network failures occur.

| Task Description | Owner | Implementation Guideline |
| :--- | :--- | :--- |
| **Integrate Google Sheets API service with Service Account authentication and row-formatting mapper** | Project | Configure `googleapis` Sheets v4 client using environment Service Account credentials. Format `DailyLog` objects into ordered spreadsheet row arrays preserving column formatting. |
| **Implement scheduled sync cron pipeline with retry queue for Google Sheets API rate-limit and network failures** | Pun | Create a `@Cron()` job in NestJS to push unsynced approved logs. If HTTP `429` or network timeout occurs, push failed rows into a retry queue with exponential backoff. |
| **Create `system_audit_logs` Prisma schema and service to record failed sync batches and error traces** | Pun | Add `SystemAuditLog` model (`id`, `jobType`, `failedRowIds`, `errorMessage`, `retryCount`, `createdAt`) and log every failed Google Sheets synchronization attempt. |
| **Simulate Google Sheets API 429 rate-limit and network drop scenarios to verify retry queue and audit logging** | Earn | Mock Google Sheets API responses (`200 OK`, `429 Too Many Requests`, `503 Service Unavailable`) to verify failed rows are queued for retry and recorded in `system_audit_logs`. |

**Acceptance Criteria (DoD):**
* Scheduled sync pipeline appends newly approved logs to the Google Spreadsheet while preserving column formatting.
* API rate-limit (`429`) or network failures queue the failed rows for automatic retry and write an error entry into `system_audit_logs`.

---

### Priority 5 — ID 06: Filter Data by Time Period (1 Point)
**Objective:** Allow managers to filter metrics tables and graphs using preset intervals or validated custom date ranges.

| Task Description | Owner | Implementation Guideline |
| :--- | :--- | :--- |
| **Add `startDate` and `endDate` query parameter filtering with DTO date-range validation to metrics endpoints** | Ball | Extend metrics/logs GET endpoints to filter by `recordedAt: { gte: startDate, lte: endDate }`. Throw `400 Bad Request` if `startDate > endDate`. |
| **Build preset interval selector and custom date-range picker with inline validation error handling** | Ball | Create preset buttons (`Today`, `Last 7 Days`, `This Month`) and custom `Start Date` / `End Date` inputs. If `startDate > endDate`, show an inline error and block API calls. |
| **Bind date filter state to dynamically reload dashboard metrics tables and graphs** | Sor | Connect the date filter component to the dashboard data hooks so tables and charts immediately re-render when valid intervals are selected. |

**Acceptance Criteria (DoD):**
* Selecting preset intervals instantaneously reloads tables and graphs bounded by the start and end dates.
* Setting a custom start date after the end date displays an inline validation error and prevents data fetching until corrected.

---

### Priority 6 — ID 07: Generate E-Reports (5 Points)
**Objective:** Enable managers to export filtered operational metrics (total volume dispensed, revenue collected, and discrepancy ratios) as downloadable PDF or CSV files.

| Task Description | Owner | Implementation Guideline |
| :--- | :--- | :--- |
| **Build backend report generation service to export aggregated volume, revenue, and discrepancy ratios as CSV and PDF** | Wuth | Create `GET /api/kiosk/reports/export?format=csv\|pdf&startDate=...&endDate=...`. Compute summary totals and return a downloadable buffer with proper MIME headers. |
| **Implement "Generate Report" dropdown action (PDF/CSV) with file stream download and date-filter guard on UI** | Ball | Add a `"Generate Report"` button with `PDF` and `CSV` options. Disable export and show inline validation error if the active custom date range has `startDate > endDate`. |
| **Verify exported PDF/CSV data accuracy and formatting against filtered database records** | Earn | Write automated E2E tests and perform manual checks confirming downloaded CSV/PDF totals match the exact sum of database records for the selected period. |

**Acceptance Criteria (DoD):**
* Clicking "Generate Report" (PDF or CSV) downloads a properly formatted file containing total volume dispensed, revenue collected, and discrepancy ratios for the filtered period.
* Invalid custom date ranges (`startDate > endDate`) block report generation until fixed.

---

### Priority 7 — ID 09: Visualize Data (½ Point)
**Objective:** Provide stakeholders with monthly summary cards (gross revenue, uncollected cash, water loss %) and side-by-side comparison charts for subsidized vs. commercial water volumes.

| Task Description | Owner | Implementation Guideline |
| :--- | :--- | :--- |
| **Create stakeholder analytics aggregation endpoint returning gross revenue, uncollected cash, water loss %, and subsidized vs. commercial volume** | Wuth | Build `GET /api/kiosk/analytics/stakeholder`. Aggregate monthly `grossRevenue`, `uncollectedCash` (negative variance sum), `waterLossPercentage`, and group volumes by `waterType` (`SUBSIDIZED` vs. `COMMERCIAL`). |
| **Build Stakeholder Analytics summary cards and side-by-side Social Assistance comparison charts** | Sor | Create the Stakeholder Analytics view with 3 KPI Summary Cards and a side-by-side Bar/Column Chart in the Social Assistance tab comparing Subsidized vs. Commercial volume. |

**Acceptance Criteria (DoD):**
* Stakeholder analytics view displays summary cards for total gross revenue, outstanding uncollected cash, and water loss percentages.
* Social Assistance tab renders side-by-side charts comparing total subsidized volume against commercial sales volume.

---

## 3. Data Contract & API Specification (Shared Reference)

### 3.1 Daily Operator Submission & Legal Proof Receipt (Story 05 & 04)
* **URL:** `POST /api/kiosk/logs`
* **Request Body:**
```json
{
  "transactionId": "TXN-20261031-001",
  "kioskId": "KIOSK-001",
  "operatorId": "OP-104",
  "meterVolume": 500.0,
  "reportedCash": 950.0,
  "waterType": "COMMERCIAL",
  "recordedAt": "2026-10-31T10:00:00.000Z",
  "checksum": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```
* **Response (`201 Created`):**
```json
{
  "success": true,
  "receipt": {
    "logId": "uuid-9876",
    "transactionId": "TXN-20261031-001",
    "kioskId": "KIOSK-001",
    "operatorId": "OP-104",
    "meterVolume": 500.0,
    "reportedCash": 950.0,
    "expectedRevenue": 1000.0,
    "variance": -50.0,
    "isAnomaly": false,
    "checksum": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "tamperEvidentVerified": true,
    "timestamp": "2026-10-31T10:00:01.120Z"
  }
}
```

### 3.2 Paginated Archive & Date-Filtered Query (Story 08 & 06)
* **URL:** `GET /api/kiosk/logs?kioskId=KIOSK-001&startDate=2026-10-01&endDate=2026-10-31&unseenOnly=false&cursor=uuid-1020&limit=20`
* **Responses:**
  * `200 OK`: Returns `{ "data": [...], "nextCursor": "uuid-1000", "unseenCount": 4 }`
  * `400 Bad Request`: When `startDate > endDate` (`{"statusCode": 400, "message": "startDate must not be after endDate"}`)

### 3.3 Report Export Endpoint (Story 07)
* **URL:** `GET /api/kiosk/reports/export?format=csv&startDate=2026-10-01&endDate=2026-10-31`
* **Response (`200 OK`):**
  * Headers: `Content-Type: text/csv` (or `application/pdf`), `Content-Disposition: attachment; filename="kiosk-report-2026-10.csv"`

### 3.4 Stakeholder Analytics Endpoint (Story 09)
* **URL:** `GET /api/kiosk/analytics/stakeholder?month=2026-10`
* **Response (`200 OK`):**
```json
{
  "month": "2026-10",
  "summaryCards": {
    "totalGrossRevenue": 45000.0,
    "outstandingUncollectedCash": 1250.0,
    "waterLossPercentage": 2.78
  },
  "socialAssistanceChart": {
    "subsidizedVolumeLiters": 8500.0,
    "commercialSalesVolumeLiters": 22500.0
  }
}
```

---

## 4. Definition of Done (DoD) for Sprint 2
1. Prisma schema migrations (`DailyLog` extensions, composite indexes, and `SystemAuditLog`) are pushed to Supabase and verified.
2. All 7 User Stories (`05`, `03`, `04`, `08`, `06`, `07`, `09`) pass unit, boundary, and integration tests (`bun test` and `npm run lint` are green).
3. Google Sheets synchronization pipeline demonstrates both normal row appending and simulated failure recovery into `system_audit_logs`.
4. Field Operator, Operation Manager, and Stakeholder views are integrated with the NestJS backend and ready for live Sprint 2 Review demonstration.