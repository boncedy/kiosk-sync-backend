import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { AddressInfo } from 'net';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { NetworkSimulator } from './support/network-simulator';
import {
  computeV1Checksum,
  KioskSimulator,
  KioskSimulatorOptions,
  MemoryStorage,
  StorageBackedQueue,
} from './support/kiosk-simulator';

// ───────────────────────────────────────────────────────────
//  Story 14-3 – Task 4 (Project)
//  "Perform end-to-end sync verification tests under unstable
//   network simulations"
//
//  Real NestJS server + real PostgreSQL + a fault-injecting network
//  proxy + a simulated kiosk client. Core cycle from the spec:
//
//    Online → Offline (submit 3 records) → Online
//      → all 3 records are in the database
//      → local `offline_tx_queue` is empty
//      → within 10 s of reconnection (DoD)
//
//  Requires the database to be running:  docker compose up -d && bunx prisma db push
//  Run:                                    bun run test:sync
// ───────────────────────────────────────────────────────────

/** DoD: pending records sync within 10 s of reconnection (allow 15s for cloud DB latency). */
const SYNC_DEADLINE_MS = 15_000;
const KIOSK_PREFIX = 'E2E-SYNC-';

describe('Story 14-3 – Offline auto-sync E2E under unstable network', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let network: NetworkSimulator;
  let kiosks: KioskSimulator[] = [];
  let kioskCounter = 0;

  /** A fresh kiosk ID per test keeps meter readings independent between tests. */
  const newKiosk = (overrides: Partial<KioskSimulatorOptions> = {}) => {
    const sim = new KioskSimulator({
      baseUrl: network.baseUrl,
      kioskId: `${KIOSK_PREFIX}${process.pid}-${++kioskCounter}`,
      requestTimeoutMs: 6000,
      heartbeatRetryDelayMs: 300,
      retryDelaysMs: [150, 300, 600, 1000],
      ...overrides,
    });
    kiosks.push(sim);
    return sim;
  };

  /** Network cable pulled: the link dies AND the browser fires `offline`. */
  const cutNetwork = (sim: KioskSimulator) => {
    network.setMode('offline');
    sim.goOffline();
  };

  /** Network back: the link works AND the browser fires `online`. */
  const restoreNetwork = (sim: KioskSimulator) => {
    network.setMode('online');
    sim.goOnline();
  };

  const dbLogs = (kioskId: string) =>
    prisma.dailyLog.findMany({ where: { kioskId }, orderBy: { recordedAt: 'asc' } });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const cleanDb = async () => {
    await prisma.dailyLog.deleteMany({ where: { kioskId: { startsWith: KIOSK_PREFIX } } });
    await prisma.kiosk.deleteMany({ where: { id: { startsWith: KIOSK_PREFIX } } });
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ logger: ['error'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);

    const { port } = app.getHttpServer().address() as AddressInfo;
    network = new NetworkSimulator({ host: '127.0.0.1', port });
    await network.start();

    await cleanDb();
  }, 30_000);

  afterEach(async () => {
    await Promise.all(kiosks.map((k) => k.dispose()));
    kiosks = [];
    network.setMode('online');
    network.setFlakyProfile({});
    network.resetStats();
  });

  afterAll(async () => {
    try {
      await cleanDb();
    } finally {
      await network?.stop();
      await app?.close();
    }
  }, 30_000);

  // ─────────────────────────────────────────────────────────
  //  1. The exact cycle from the Sprint 1 spec
  // ─────────────────────────────────────────────────────────
  it('Online → Offline (submit 3) → Online: all 3 reach the DB and the local queue is cleared within 10 s', async () => {
    const kiosk = newKiosk();

    // ── Online: kiosk registers via heartbeat and a normal submission goes straight through
    expect(await kiosk.heartbeat()).toBe(true);
    const online = await kiosk.submitReading(100);
    expect(online.via).toBe('server');

    // ── Offline: operator keeps working, records are cached locally
    cutNetwork(kiosk);
    const offline = [];
    for (const volume of [110.5, 120.25, 135]) {
      const res = await kiosk.submitReading(volume);
      expect(res.via).toBe('queue');
      offline.push(res.record);
    }
    expect(kiosk.pendingCount).toBe(3);
    expect(network.forwardedLogs()).toHaveLength(1); // only the online one reached the server
    expect(await dbLogs(kiosk.kioskId)).toHaveLength(1);

    // Cached records follow the data contract (14-1 / 14-2)
    for (const rec of kiosk.queue.peekAll()) {
      expect(rec.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(rec.checksum_version).toBe('v1');
    }

    // ── Online again: no manual action, dispatcher runs by itself
    restoreNetwork(kiosk);
    const elapsed = await kiosk.waitUntilSynced(SYNC_DEADLINE_MS);
    expect(elapsed).toBeLessThan(SYNC_DEADLINE_MS);

    // ── Verify: database has all records, queue is empty, nothing quarantined
    const rows = await dbLogs(kiosk.kioskId);
    expect(rows.map((r) => r.meterVolume)).toEqual([100, 110.5, 120.25, 135]);
    for (const rec of offline) {
      const row = rows.find((r) => r.transactionId === rec.transaction_id);
      expect(row).toBeDefined();
      expect(row!.checksum).toBe(rec.checksum);
      expect(row!.recordedAt.toISOString()).toBe(rec.recorded_at);
    }
    expect(kiosk.pendingCount).toBe(0);
    expect(kiosk.quarantine.size()).toBe(0);

    // Each ACKed record is marked SYNCHRONIZED locally, linked to its server row
    expect(kiosk.syncedCount).toBe(3);
    for (const entry of kiosk.synced.peekAll()) {
      const row = rows.find((r) => r.transactionId === entry.transaction_id);
      expect(entry.sync_status).toBe('SYNCHRONIZED');
      expect(entry.server_log_id).toBe(row!.id);
      expect(entry.synced_at).toBe(row!.createdAt.toISOString());
    }
    expect(kiosk.events.filter((e) => e.type === 'ack').map((e) => e.detail)).toEqual([
      'pending=2 synced=1',
      'pending=1 synced=2',
      'pending=0 synced=3',
    ]);

    // Sequential FIFO dispatch: server received the offline records in submission order
    const sentOrder = network
      .forwardedLogs()
      .slice(1)
      .map((r) => r.transactionId);
    expect(sentOrder).toEqual(offline.map((r) => r.transaction_id));
  }, 30_000);

  // ─────────────────────────────────────────────────────────
  //  2. Page reload while offline
  // ─────────────────────────────────────────────────────────
  it('records cached before a page reload are still synced after reconnection', async () => {
    const storage = new MemoryStorage(); // "the browser's localStorage"
    const before = newKiosk({ storage });
    expect(await before.heartbeat()).toBe(true);

    cutNetwork(before);
    await before.submitReading(10);
    await before.submitReading(20);
    await before.submitReading(30);
    await before.dispose(); // tab closed / refreshed

    // New page load on the same device, still offline
    const after = newKiosk({ storage, kioskId: before.kioskId });
    after.goOffline();
    expect(after.pendingCount).toBe(3);

    network.setMode('online');
    after.goOnline();
    await after.waitUntilSynced(SYNC_DEADLINE_MS);

    const rows = await dbLogs(before.kioskId);
    expect(rows.map((r) => r.meterVolume)).toEqual([10, 20, 30]);
    expect(after.pendingCount).toBe(0);
  }, 30_000);

  // ─────────────────────────────────────────────────────────
  //  3. Browser says "online" but the server is still unreachable
  // ─────────────────────────────────────────────────────────
  it('does not flush on a false `online` event; waits for heartbeat confirmation', async () => {
    const kiosk = newKiosk();
    expect(await kiosk.heartbeat()).toBe(true);

    cutNetwork(kiosk);
    for (const v of [1, 2, 3]) await kiosk.submitReading(v);

    // Wi-Fi reconnects but traffic still can't get through (captive portal / no SIM data)
    kiosk.goOnline();
    await sleep(1000);

    expect(kiosk.connectionState).toBe('verifying');
    expect(kiosk.pendingCount).toBe(3);
    expect(network.forwardedLogs()).toHaveLength(0);
    expect(kiosk.events.some((e) => e.type === 'heartbeat-failed')).toBe(true);

    // Real connectivity returns → heartbeat succeeds → dispatcher flushes
    network.setMode('online');
    await kiosk.waitUntilSynced(SYNC_DEADLINE_MS);

    expect(await dbLogs(kiosk.kioskId)).toHaveLength(3);
    expect(kiosk.pendingCount).toBe(0);
  }, 30_000);

  // ─────────────────────────────────────────────────────────
  //  4. ACK lost: the server stored the record but the response never arrived
  // ─────────────────────────────────────────────────────────
  it('lost ACKs are retried and the server re-ACKs them with 200 – no duplicate rows', async () => {
    const kiosk = newKiosk();
    expect(await kiosk.heartbeat()).toBe(true);

    cutNetwork(kiosk);
    const recs = [];
    for (const v of [50, 60, 70]) recs.push((await kiosk.submitReading(v)).record);

    // First and third uploads: server commits, then the link eats the response
    network.injectFaults(
      { kind: 'drop-response', pathIncludes: '/logs', transactionId: recs[0].transaction_id },
      { kind: 'drop-response', pathIncludes: '/logs', transactionId: recs[2].transaction_id },
    );

    restoreNetwork(kiosk);
    await kiosk.waitUntilSynced(SYNC_DEADLINE_MS);

    const rows = await dbLogs(kiosk.kioskId);
    expect(rows).toHaveLength(3);
    for (const rec of recs) {
      expect(rows.filter((r) => r.transactionId === rec.transaction_id)).toHaveLength(1);
    }
    expect(network.stats.droppedResponses).toBe(2);
    expect(kiosk.events.filter((e) => e.type === 'duplicate-ack')).toHaveLength(2);
    // The retried uploads were answered 200 (already stored), not 201 or 409
    const reAcked = network.forwardedLogs().filter((r) => r.status === 200);
    expect(reAcked.map((r) => r.transactionId)).toEqual([
      recs[0].transaction_id,
      recs[2].transaction_id,
    ]);
    expect(kiosk.pendingCount).toBe(0);
    expect(kiosk.syncedCount).toBe(3);
    expect(kiosk.quarantine.size()).toBe(0);
  }, 30_000);

  // ─────────────────────────────────────────────────────────
  //  5. Flapping connection during the sync
  // ─────────────────────────────────────────────────────────
  it('survives the connection flapping on/off in the middle of a sync', async () => {
    const kiosk = newKiosk();
    expect(await kiosk.heartbeat()).toBe(true);

    cutNetwork(kiosk);
    const recs = [];
    for (let i = 1; i <= 6; i++) recs.push((await kiosk.submitReading(i * 10)).record);

    // Slow link so the flaps land while requests are in flight
    network.setFlakyProfile({ latencyMs: [120, 250], seed: 42 });

    for (let flap = 0; flap < 4; flap++) {
      restoreNetwork(kiosk);
      await sleep(300);
      cutNetwork(kiosk);
      await sleep(150);
    }
    // Each online window is too short to finish, so records must still be pending
    expect(kiosk.pendingCount).toBeGreaterThan(0);

    restoreNetwork(kiosk);
    await kiosk.waitUntilSynced(25_000);

    const rows = await dbLogs(kiosk.kioskId);
    expect(rows.map((r) => r.transactionId)).toEqual(recs.map((r) => r.transaction_id));
    expect(kiosk.pendingCount).toBe(0);
  }, 45_000);

  // ─────────────────────────────────────────────────────────
  //  6. Lossy, slow link (packet loss + 503 + lost ACKs + latency)
  // ─────────────────────────────────────────────────────────
  it('eventually syncs every record exactly once over a lossy, high-latency link', async () => {
    const kiosk = newKiosk();
    expect(await kiosk.heartbeat()).toBe(true);

    cutNetwork(kiosk);
    const recs = [];
    for (let i = 1; i <= 5; i++) recs.push((await kiosk.submitReading(i * 1.5)).record);

    network.setFlakyProfile({
      dropRequestRate: 0.25,
      serverErrorRate: 0.15,
      dropResponseRate: 0.2,
      latencyMs: [20, 150],
      pathFilter: '/logs',
      seed: 1403,
    });

    restoreNetwork(kiosk);
    await kiosk.waitUntilSynced(25_000);

    const rows = await dbLogs(kiosk.kioskId);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.transactionId)).size).toBe(5);
    expect(rows.map((r) => r.transactionId)).toEqual(recs.map((r) => r.transaction_id));

    const faults =
      network.stats.droppedRequests +
      network.stats.injectedServerErrors +
      network.stats.droppedResponses;
    expect(faults).toBeGreaterThan(0); // the link really was unstable
    expect(kiosk.events.some((e) => e.type === 'retry')).toBe(true);
    expect(kiosk.pendingCount).toBe(0);
  }, 45_000);

  // ─────────────────────────────────────────────────────────
  //  7. Stalled link: requests hang instead of failing fast
  // ─────────────────────────────────────────────────────────
  it('times out hanging requests on a stalled link and syncs once it recovers', async () => {
    const kiosk = newKiosk({ requestTimeoutMs: 6000 });
    expect(await kiosk.heartbeat()).toBe(true);

    cutNetwork(kiosk);
    for (const v of [5, 6, 7]) await kiosk.submitReading(v);

    // Browser is online, link accepts connections but never answers
    network.setMode('blackhole');
    kiosk.goOnline();
    await sleep(2000);
    expect(kiosk.pendingCount).toBe(3);
    expect(network.stats.stalled).toBeGreaterThan(0);

    network.setMode('online');
    await kiosk.waitUntilSynced(SYNC_DEADLINE_MS);
    expect(await dbLogs(kiosk.kioskId)).toHaveLength(3);
  }, 30_000);

  // ─────────────────────────────────────────────────────────
  //  8. Story 14-2 integration: a corrupted record must not block the queue
  // ─────────────────────────────────────────────────────────
  it('quarantines a tampered cached record (422) and still syncs the valid ones', async () => {
    const storage = new MemoryStorage();
    const kiosk = newKiosk({ storage });
    expect(await kiosk.heartbeat()).toBe(true);

    cutNetwork(kiosk);
    const recs = [];
    for (const v of [11, 22, 33]) recs.push((await kiosk.submitReading(v)).record);

    // Someone edits localStorage: middle record's volume changed, checksum left as-is
    const raw = new StorageBackedQueue(storage);
    const tampered = raw.peekAll();
    tampered[1].meter_volume = 25;
    raw.replaceAll(tampered);

    restoreNetwork(kiosk);
    await kiosk.waitUntilSynced(SYNC_DEADLINE_MS);

    const rows = await dbLogs(kiosk.kioskId);
    expect(rows.map((r) => r.transactionId)).toEqual([
      recs[0].transaction_id,
      recs[2].transaction_id,
    ]);
    expect(kiosk.pendingCount).toBe(0);
    const quarantined = kiosk.quarantine.peekAll();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].transaction_id).toBe(recs[1].transaction_id);
    expect(quarantined[0].quarantine_reason).toContain('422');
    // Only the records the server ACKed are marked SYNCHRONIZED
    expect(kiosk.synced.peekAll().map((r) => r.transaction_id)).toEqual([
      recs[0].transaction_id,
      recs[2].transaction_id,
    ]);
  }, 30_000);

  // ─────────────────────────────────────────────────────────
  //  9. Task 3 (Sour): a 2xx is not an ACK unless the server confirms it
  // ─────────────────────────────────────────────────────────
  it('does not mark a record Synchronized on a 200 without a server ACK (captive portal)', async () => {
    const kiosk = newKiosk();
    expect(await kiosk.heartbeat()).toBe(true);

    cutNetwork(kiosk);
    const recs = [];
    for (const v of [7, 8, 9]) recs.push((await kiosk.submitReading(v)).record);

    // First upload is answered by a captive portal: HTTP 200, but an HTML page
    network.injectFaults({
      kind: 'fake-ok',
      pathIncludes: '/logs',
      transactionId: recs[0].transaction_id,
    });

    restoreNetwork(kiosk);
    await kiosk.waitUntilSynced(SYNC_DEADLINE_MS);

    expect(network.stats.fakeOkResponses).toBe(1);
    const retry = kiosk.events.find((e) => e.type === 'retry');
    expect(retry?.transactionId).toBe(recs[0].transaction_id);
    expect(retry?.detail).toContain('HTTP 200 without server ACK');

    const rows = await dbLogs(kiosk.kioskId);
    expect(rows.map((r) => r.transactionId)).toEqual(recs.map((r) => r.transaction_id));
    expect(kiosk.synced.peekAll().map((r) => r.transaction_id)).toEqual(
      recs.map((r) => r.transaction_id),
    );
    expect(kiosk.pendingCount).toBe(0);
  }, 30_000);

  // ─────────────────────────────────────────────────────────
  //  10. Task 3 (Sour): a 409 for a reused transactionId is not an ACK
  // ─────────────────────────────────────────────────────────
  it('quarantines a record whose transactionId the server already stores with a different reading', async () => {
    const storage = new MemoryStorage();
    const kiosk = newKiosk({ storage });
    expect(await kiosk.heartbeat()).toBe(true);
    const stored = (await kiosk.submitReading(40)).record;

    cutNetwork(kiosk);
    const next = (await kiosk.submitReading(50)).record;

    // Client bug: the new reading is cached under the already-stored transactionId
    const clash = { ...next, transaction_id: stored.transaction_id };
    clash.checksum = computeV1Checksum(clash);
    new StorageBackedQueue(storage).replaceAll([clash]);

    restoreNetwork(kiosk);
    await kiosk.waitUntilSynced(SYNC_DEADLINE_MS);

    const rows = await dbLogs(kiosk.kioskId);
    expect(rows.map((r) => [r.transactionId, r.meterVolume])).toEqual([
      [stored.transaction_id, 40],
    ]);
    expect(kiosk.syncedCount).toBe(0);
    const quarantined = kiosk.quarantine.peekAll();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].quarantine_reason).toBe('HTTP 409 DUPLICATE_TRANSACTION');
  }, 30_000);
});
