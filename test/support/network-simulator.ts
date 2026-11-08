import * as http from 'http';
import type { AddressInfo, Socket } from 'net';

// ───────────────────────────────────────────────────────────
//  Story 14-3 – Unstable network simulator
//
//  A tiny HTTP proxy that sits between the simulated kiosk and the
//  real NestJS server. It plays the role of the cellular / Wi-Fi link
//  (what Chrome DevTools "Offline" does in a manual test) but can also
//  inject the nasty, in-between failures that are hard to reproduce by
//  hand:
//
//    kiosk ──HTTP──▶ NetworkSimulator ──HTTP──▶ NestJS + PostgreSQL
//
//  Modes:
//    online    – forward everything (optionally with latency / random faults)
//    offline   – reset every connection immediately (link is down)
//    blackhole – accept connections but never answer (stalled link → client timeout)
//
//  Faults (random via a seeded PRNG, or queued one-shot via `injectFaults`):
//    drop-request   – connection reset BEFORE the request reaches the server
//    drop-response  – request IS processed by the server, but the ACK is lost
//    server-error   – gateway answers 503 without contacting the server
//    fake-ok        – gateway answers 200 with a captive-portal page, without
//                     contacting the server (one-shot only, never random)
// ───────────────────────────────────────────────────────────

export type NetworkMode = 'online' | 'offline' | 'blackhole';

export type FaultKind = 'drop-request' | 'drop-response' | 'server-error' | 'fake-ok';

export interface FlakyProfile {
  /** Probability (0–1) that a request is reset before reaching the server. */
  dropRequestRate?: number;
  /** Probability (0–1) that the server's response (ACK) is lost after processing. */
  dropResponseRate?: number;
  /** Probability (0–1) that the gateway answers 503 instead of forwarding. */
  serverErrorRate?: number;
  /** Random extra latency per request, in ms: [min, max]. */
  latencyMs?: [number, number];
  /** Only apply random faults to paths containing this string (e.g. '/logs'). */
  pathFilter?: string;
  /** PRNG seed so a failing run can be reproduced exactly. */
  seed?: number;
}

export interface QueuedFault {
  kind: FaultKind;
  /** Only consume this fault for a request whose path contains this string. */
  pathIncludes?: string;
  /** Only consume this fault for a request whose body has this transaction ID. */
  transactionId?: string;
}

export interface ForwardedRequest {
  method: string;
  path: string;
  transactionId?: string;
  status?: number;
  /** True when the server answered but the response never reached the client. */
  responseLost: boolean;
  at: number;
}

export interface NetworkStats {
  /** Connections reset because the link was offline. */
  refusedWhileOffline: number;
  /** Connections that hung because the link was a blackhole. */
  stalled: number;
  droppedRequests: number;
  droppedResponses: number;
  injectedServerErrors: number;
  /** 200 responses faked by the gateway (no ACK body, server never contacted). */
  fakeOkResponses: number;
  /** Requests that actually reached the NestJS server. */
  forwarded: ForwardedRequest[];
}

/** Deterministic PRNG (mulberry32) – same seed ⇒ same fault sequence. */
function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class NetworkSimulator {
  private server: http.Server;
  private readonly sockets = new Set<Socket>();
  private mode: NetworkMode = 'online';
  private profile: FlakyProfile = {};
  private rng: () => number = createRng(1);
  private faultQueue: QueuedFault[] = [];
  private port = 0;

  readonly stats: NetworkStats = NetworkSimulator.emptyStats();

  constructor(private readonly upstream: { host: string; port: number }) {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.keepAliveTimeout = 1;

    this.server.on('connection', (socket: Socket) => {
      if (this.mode === 'offline') {
        this.stats.refusedWhileOffline++;
        socket.destroy();
        return;
      }
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  private static emptyStats(): NetworkStats {
    return {
      refusedWhileOffline: 0,
      stalled: 0,
      droppedRequests: 0,
      droppedResponses: 0,
      injectedServerErrors: 0,
      fakeOkResponses: 0,
      forwarded: [],
    };
  }

  /* ───────────── lifecycle ───────────── */

  async start(): Promise<string> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    this.port = (this.server.address() as AddressInfo).port;
    return this.baseUrl;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    this.destroyAllSockets();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /* ───────────── controls ───────────── */

  getMode(): NetworkMode {
    return this.mode;
  }

  /**
   * Switch the link state. Going offline/blackhole kills every in-flight
   * connection, exactly like a real link dropping mid-request.
   */
  setMode(mode: NetworkMode): void {
    this.mode = mode;
    if (mode !== 'online') this.destroyAllSockets();
  }

  /** Random faults applied while online. Pass `{}` to go back to a clean link. */
  setFlakyProfile(profile: FlakyProfile): void {
    this.profile = profile;
    this.rng = createRng(profile.seed ?? 1);
  }

  /** Deterministic one-shot faults, consumed in order by matching requests. */
  injectFaults(...faults: QueuedFault[]): void {
    this.faultQueue.push(...faults);
  }

  resetStats(): void {
    Object.assign(this.stats, NetworkSimulator.emptyStats());
  }

  /** Requests for `/logs` that actually reached the server. */
  forwardedLogs(): ForwardedRequest[] {
    return this.stats.forwarded.filter((r) => r.path.includes('/logs'));
  }

  private destroyAllSockets(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  /* ───────────── request pipeline ───────────── */

  private pickFault(path: string, transactionId?: string): FaultKind | null {
    const idx = this.faultQueue.findIndex((f) => {
      if (f.pathIncludes && !path.includes(f.pathIncludes)) return false;
      if (f.transactionId && f.transactionId !== transactionId) return false;
      return true;
    });
    if (idx >= 0) return this.faultQueue.splice(idx, 1)[0].kind;

    const p = this.profile;
    if (p.pathFilter && !path.includes(p.pathFilter)) return null;
    // Always draw all three numbers so the sequence stays reproducible.
    const r1 = this.rng();
    const r2 = this.rng();
    const r3 = this.rng();
    if (r1 < (p.dropRequestRate ?? 0)) return 'drop-request';
    if (r2 < (p.serverErrorRate ?? 0)) return 'server-error';
    if (r3 < (p.dropResponseRate ?? 0)) return 'drop-response';
    return null;
  }

  private async latency(): Promise<void> {
    const range = this.profile.latencyMs;
    if (!range) return;
    const [min, max] = range;
    await sleep(min + Math.floor(this.rng() * (max - min + 1)));
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (this.mode === 'blackhole') {
      this.stats.stalled++;
      return; // never answer – the socket is destroyed when the link changes
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const path = req.url ?? '/';

    await this.latency();
    if (this.mode !== 'online') {
      req.socket.destroy(); // link went down while the packet was "in the air"
      return;
    }

    let transactionId: string | undefined;
    try {
      const parsed = JSON.parse(body.toString() || '{}') as Record<string, unknown>;
      transactionId = (parsed.transactionId ?? parsed.transaction_id) as string | undefined;
    } catch {
      /* not JSON – fine */
    }

    const fault = this.pickFault(path, transactionId);

    if (fault === 'drop-request') {
      this.stats.droppedRequests++;
      req.socket.destroy();
      return;
    }
    if (fault === 'server-error') {
      this.stats.injectedServerErrors++;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ statusCode: 503, message: 'Simulated gateway error' }));
      return;
    }
    if (fault === 'fake-ok') {
      this.stats.fakeOkResponses++;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>Sign in to continue using Wi-Fi</body></html>');
      return;
    }

    const record: ForwardedRequest = {
      method: req.method ?? 'GET',
      path,
      transactionId,
      responseLost: false,
      at: Date.now(),
    };
    this.stats.forwarded.push(record);

    const upstreamRes = await this.forward(req, path, body).catch(() => null);
    if (!upstreamRes) {
      res.writeHead(502);
      res.end();
      return;
    }
    record.status = upstreamRes.status;

    // Link may have died while the server was working on the request.
    if (fault === 'drop-response' || this.mode !== 'online') {
      record.responseLost = true;
      this.stats.droppedResponses++;
      req.socket.destroy();
      return;
    }

    res.writeHead(upstreamRes.status, upstreamRes.headers);
    res.end(upstreamRes.body);
  }

  private forward(
    req: http.IncomingMessage,
    path: string,
    body: Buffer,
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const headers = { ...req.headers, host: `${this.upstream.host}:${this.upstream.port}` };
      delete headers.connection;
      const upstreamReq = http.request(
        {
          host: this.upstream.host,
          port: this.upstream.port,
          method: req.method,
          path,
          headers: { ...headers, 'content-length': String(body.length) },
          agent: false,
        },
        (upstreamRes) => {
          const out: Buffer[] = [];
          upstreamRes.on('data', (c: Buffer) => out.push(c));
          upstreamRes.on('end', () => {
            const resHeaders = { ...upstreamRes.headers };
            delete resHeaders.connection;
            delete resHeaders['keep-alive'];
            resolve({
              status: upstreamRes.statusCode ?? 502,
              headers: resHeaders,
              body: Buffer.concat(out),
            });
          });
          upstreamRes.on('error', reject);
        },
      );
      upstreamReq.on('error', reject);
      upstreamReq.end(body);
    });
  }
}
