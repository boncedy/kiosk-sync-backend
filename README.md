# Water Kiosk Sync Backend

REST API that ingests daily meter readings from water-vending kiosks operated in the
field — including the hard case: kiosks that go offline for days, queue their readings
locally, and replay them later over an unreliable link without duplicating data or
silently losing money.

Every accepted reading returns a **tamper-evident signed receipt**. Every replayed
reading is **idempotent**. Every stored row can be **re-verified** against the checksum
it was submitted with.

<p>
  <a href="https://github.com/boncedy/kiosk-sync-backend/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/boncedy/kiosk-sync-backend/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="NestJS" src="https://img.shields.io/badge/NestJS-12-E0234E?logo=nestjs&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript&logoColor=white">
  <img alt="Prisma" src="https://img.shields.io/badge/Prisma-6-2D3748?logo=prisma&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white">
  <img alt="Jest" src="https://img.shields.io/badge/Jest-30-C21325?logo=jest&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue">
</p>

## The problem

A water kiosk is a physical machine in a rural area. The operator dispenses water,
collects cash, and records the meter reading. The network is frequently down, and the
operator's submission is the only record that money changed hands — so the server must
answer three questions honestly:

1. **Did this reading already arrive?** Otherwise an offline retry double-counts revenue.
2. **Can the operator prove what they reported?** Otherwise a later edit is undetectable.
3. **Do we lose the reading if the link dies mid-request?** Otherwise the record is gone.

## How this API answers them

### Idempotent ingestion with an honest ACK

`POST /api/kiosk/logs` is keyed on a client-generated `transactionId`. The kiosk only
marks a local record *Synchronized* when it receives a `200`/`201` whose body contains
`"ack": true` for that exact transaction — a plain `2xx` is not enough, because captive
portals answer `200` with an HTML page.

| Status | Meaning | Client action |
| --- | --- | --- |
| `201` | New record stored | Move to synced log |
| `200` + `"duplicate": true` | Identical retry of a record already stored (first ACK was lost) | Move to synced log — no row duplicated |
| `409 DUPLICATE_TRANSACTION` | Same `transactionId`, **different** reading | Quarantine — do not mark synced |
| `409 STATE_CONFLICT` | Reading contradicts newer or older server state | Quarantine |
| `422 CORRUPTED_PAYLOAD` | Checksum does not match the body | Quarantine |

The distinction between `200 duplicate` and `409 duplicate` is the whole point: a lost
ACK must converge, but a reused `transactionId` must never silently overwrite different
numbers.

### Tamper-evident receipts

On acceptance the server returns a receipt:

```
checksum  = SHA-256(kioskId + operatorId + meterVolume + reportedCash + recordedAt)
signature = HMAC-SHA256(checksum, RECEIPT_SIGNING_KEY)
```

The signature is compared with `crypto.timingSafeEqual`, so verification does not leak
the expected value through timing. `GET /api/kiosk/logs/:id/inspect` recomputes the
checksum from the row's **current** database values and diffs it against the checksum
stored at submission time:

| `verification.status` | Meaning |
| --- | --- |
| `VERIFIED` | The stored row still matches what was submitted |
| `CHECKSUM_MISMATCH` | The row was edited after submission |
| `NO_CHECKSUM` | Submitted by an older client, unverifiable |

This turns the database into something you can audit rather than merely query: a
back-dated edit shows up as a mismatch instead of quietly changing reported revenue.

### Monotonic meter invariant

`meterVolume` is cumulative, so for a given kiosk it must never decrease as
`recordedAt` increases. An incoming reading therefore has to fit between its two
neighbours in server history:

```
older reading  ≤  incoming  ≤  newer reading
```

Only the nearest neighbour on each side needs to be compared — a direct consequence of
every accepted reading satisfying the same invariant. `readingType: DAILY_VOLUME`
readings are exempt because they may legitimately move both ways.

### Evidence photos, without bloating the database

`POST /api/kiosk/logs/:transactionId/evidence` accepts one JPEG, PNG or WebP up to 5 MB,
validates it, forwards it to imgBB, and stores only the returned CDN URL on the row. If
`IMGBB_API_KEY` is not configured the route answers `503`, which tells the client to keep
the entry queued rather than accept a record it cannot prove.

### Historical queries that stay fast

Log history uses cursor pagination (`?kioskId=&cursor=&limit=`, limit 1–100, default 20)
over a composite index on `(kioskId, recordedAt DESC)`, so reading back through years of
history never degrades into an offset scan.

### Google Sheets reporting

Accepted readings are mirrored into a Google Sheet via a service account, so
stakeholders can read live figures without touching the API. Configuration is validated
at boot, and the integration is entirely optional — leaving the credentials empty
disables it rather than breaking ingestion. Credentials are supplied as JSON, as
email + private key, or as a key file path, and are git-ignored in all three forms.

## Testing: simulating a bad network on purpose

The interesting tests do not call the API directly. A fault-injecting proxy sits between
a simulated kiosk and the real server backed by PostgreSQL:

```
KioskSimulator (offline queue + checksums)
      │  HTTP
      ▼
NetworkSimulator  — offline, blackhole, packet drop, random 503, lost ACKs, latency jitter
      │  HTTP
      ▼
NestJS API  ──Prisma──▶  PostgreSQL
```

`test/support/kiosk-simulator.ts` implements the client-side queue; `network-simulator.ts`
injects the faults. The suite (`test/offline-sync.e2e-spec.ts`) covers:

1. Offline queueing of three readings, then automatic sequential sync on reconnect
2. Page reload while offline — queued records survive and sync on reconnection
3. A false `online` event (captive portal) — no flush until a real heartbeat succeeds
4. A dropped ACK — server commits, client retries, `200 duplicate`, exactly one row
5. Flapping connectivity mid-sync
6. A lossy, high-latency link — retries succeed with backoff
7. A blackholed link — request timeout, recovery once the link returns
8. A tampered cached record — rejected `422` and quarantined without blocking valid records
9. `2xx` without `ack` — the record is not marked synced
10. A reused `transactionId` with different data — `409`, quarantined, not overwritten

```bash
docker compose up -d          # PostgreSQL 16
npx prisma db push            # create the schema
npm test                      # unit tests (no database needed)
npm run test:e2e              # integration + offline-sync suites
npm run test:sync             # the offline-sync suite alone, verbose
```

A concurrency load test (`test/load.e2e-spec.ts`) and a payload-integrity suite
(`test/payload-integrity.e2e-spec.ts`) are also included.

## Architecture

```
src/
  kiosk/
    kiosk.controller.ts          routes: heartbeat, ingest, evidence, history
    kiosk.service.ts             ingestion, idempotency, persistence
    receipt.ts                   SHA-256 checksum + HMAC-SHA256 signing
    meter-conflict.ts            monotonic-invariant conflict detection
    checksum-validator.ts        client checksum formats (v1 / legacy)
    log-inspection.ts            live re-verification of stored rows
    sync-ack.ts                  ACK / duplicate / conflict response shapes
    imgbb.service.ts             evidence upload
    dto/                         class-validator request contracts
  google-sheets/                 optional Sheets mirror with retries and timeouts
  prisma.service.ts              Prisma client lifecycle
prisma/schema.prisma             Kiosk, DailyLog, WaterType, composite index
test/                            e2e, offline-sync, load, integrity suites + simulators
```

Stack: **NestJS 12 · TypeScript · Prisma 6 · PostgreSQL 16 · class-validator · Jest 30 ·
oxlint · Docker Compose**.

## Quick start

Requires **Node.js 24+** and Docker. NestJS 12 ships as ES modules, so Node 24's native
`require(esm)` support is required — on Node 22 the test run fails to load `@nestjs/common`.

```bash
npm install
cp .env.example .env          # then set DATABASE_URL
docker compose up -d
npx prisma db push
npm run start:dev             # http://localhost:3001
```

Bun works too (`bun install`, `bun run start:dev`). See `.env.example` for every variable
— nothing in it is a real secret.

## API summary

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/kiosk/heartbeat` | Kiosk liveness → `ONLINE` / `OFFLINE` |
| `GET` | `/api/kiosk/status/:id` | Current kiosk status |
| `POST` | `/api/kiosk/logs` | Ingest a reading; returns ACK + signed receipt |
| `POST` | `/api/kiosk/logs/:transactionId/evidence` | Attach one evidence photo |
| `GET` | `/api/kiosk/logs?kioskId=&cursor=&limit=` | Cursor-paginated history |
| `GET` | `/api/kiosk/logs/:id/inspect` | Row details + live checksum verification |

## Further documentation

- [`docs/sprint-1-requirements.md`](docs/sprint-1-requirements.md) — requirements and
  architecture decisions for connectivity, storage and the offline queue
- [`docs/sprint-2-implementation-spec.md`](docs/sprint-2-implementation-spec.md) —
  signed receipts, reconciliation, Sheets sync and reporting
- [`docs/test-results.md`](docs/test-results.md) — test execution report per user story

## Known limitations

- Acknowledged reads only: there is no endpoint for a manager to acknowledge an anomaly
  (`isReadByManager` exists in the schema but is not yet exposed).
- Google Sheets sync is best-effort with retries; it is not a transactional outbox, so a
  crash mid-sync can leave a row unmirrored until the next run.
- Evidence photos depend on imgBB and are therefore third-party-hosted; a private bucket
  would be the production choice.
- `RECEIPT_SIGNING_KEY` has a development default. It must be set, and rotated with a
  key-id, before real money is involved.

> **Team project.** Built for ITCS258 *Practical Software Engineering* at Mahidol
> University. This repository is my portfolio copy. My contribution:
> _`TODO: replace with what you personally built`_

## License

MIT — see [LICENSE](LICENSE).
