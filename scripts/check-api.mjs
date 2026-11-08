#!/usr/bin/env node
/**
 * End-to-end availability check for the kiosk API.
 *
 *   node scripts/check-api.mjs
 *   node scripts/check-api.mjs --base http://localhost:3001 --proxy http://localhost:3000
 *   node scripts/check-api.mjs --base https://api.example.com --photo ./meter.jpg
 *
 * Checks every layer in order: TCP/HTTP reachability, the heartbeat route,
 * the read route, the photo-upload route (imgBB), the stored image URL, and
 * optionally the operator app's /api proxy.
 */
import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const base = (arg('base', process.env.API_BASE_URL || 'http://localhost:3001')).replace(/\/+$/, '');
const proxy = arg('proxy').replace(/\/+$/, '');
const photoPath = arg('photo');
const kioskId = arg('kiosk', 'KIOSK-001');

/* ------------------------------------------------------------------ */
/* A tiny valid PNG so the check works without a real meter photo.     */
/* ------------------------------------------------------------------ */

let crcTable;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function makePng(width = 320, height = 240) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const offset = y * stride + 1 + x * 3;
      raw[offset] = (x * 255) / width;
      raw[offset + 1] = (y * 255) / height;
      raw[offset + 2] = 160;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

const results = [];

function resolveHint(error, fallback) {
  const message = String(error?.message ?? '').toLowerCase();
  if (message.includes('aborted') || message.includes('timeout')) {
    return 'Timed out. The server or imgBB is slow to answer; retry before assuming a bug.';
  }
  if (message.includes('fetch failed') || message.includes('econnrefused')) {
    return HINTS.down;
  }
  return fallback;
}

async function check(name, hint, run) {
  try {
    const detail = await run();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({
      name,
      ok: false,
      detail: error.message,
      hint: resolveHint(error, hint),
    });
  }
}

const HINTS = {
  down: `Nothing answered at ${base}. Is the server running (bun run start:dev) and is PORT correct?`,
  route: 'Route missing. The base URL or path prefix is wrong, or the server is an older build.',
  storage: 'Photo storage is not configured. Set IMGBB_API_KEY in .env and restart the server.',
  contract: 'The server rejected the request body. The DTOs likely differ from this build.',
};

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`expected JSON, got: ${text.slice(0, 120)}`);
  }
}

function expectStatus(response, accepted) {
  if (!accepted.includes(response.status)) {
    throw new Error(`HTTP ${response.status}`);
  }
}

async function main() {
  await check('server reachable (GET /)', HINTS.down, async () => {
    const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(10_000) });
    expectStatus(response, [200]);
    return `HTTP 200 · ${(await response.text()).trim().slice(0, 40)}`;
  });

  // Without the base URL nothing else can pass; report instead of repeating
  // the same connection error against every route.
  if (!results[0].ok) report();

  await check('heartbeat route (POST /api/kiosk/heartbeat)', HINTS.route, async () => {
    const response = await fetch(`${base}/api/kiosk/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kioskId, kiosk_id: kioskId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) throw new Error('HTTP 404');
    expectStatus(response, [200, 201]);
    return `HTTP ${response.status}`;
  });

  await check(`read route (GET /api/kiosk/logs?kioskId=${kioskId})`, HINTS.route, async () => {
    const response = await fetch(
      `${base}/api/kiosk/logs?kioskId=${encodeURIComponent(kioskId)}&limit=1`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (response.status === 404) throw new Error('HTTP 404');
    if (response.status >= 500) throw new Error(`HTTP ${response.status} (database unreachable?)`);
    expectStatus(response, [200]);
    const body = await readJson(response);
    if (!Array.isArray(body.data)) throw new Error('response is missing a "data" array');
    return `HTTP 200 · ${body.data.length} row(s)`;
  });

  let imageUrl = '';
  await check('photo upload (POST /api/kiosk/logs/:id/evidence)', HINTS.storage, async () => {
    const image = photoPath ? readFileSync(photoPath) : makePng();
    const contentType = photoPath
      ? photoPath.endsWith('.png') ? 'image/png' : 'image/jpeg'
      : 'image/png';
    const form = new FormData();
    form.append('file', new Blob([image], { type: contentType }), photoPath ? `check${photoPath.slice(photoPath.lastIndexOf('.'))}` : 'api-check.png');

    const response = await fetch(
      `${base}/api/kiosk/logs/API-CHECK-${Date.now()}/evidence`,
      { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) },
    );
    if (response.status === 503) throw new Error('HTTP 503 · storage unavailable');
    if (response.status === 404) throw new Error('HTTP 404 · route missing');
    if (response.status === 400) throw new Error('HTTP 400 · image rejected');
    expectStatus(response, [200, 201]);
    const body = await readJson(response);
    if (typeof body.proofImageUrl !== 'string') throw new Error('response is missing proofImageUrl');
    imageUrl = body.proofImageUrl;
    return imageUrl;
  });

  if (imageUrl) {
    await check('stored photo is publicly fetchable', 'The returned proofImageUrl does not resolve.', async () => {
      const response = await fetch(imageUrl, { signal: AbortSignal.timeout(20_000) });
      expectStatus(response, [200]);
      const type = response.headers.get('content-type') ?? '';
      if (!type.startsWith('image/')) throw new Error(`content-type is "${type}"`);
      return `HTTP 200 · ${type}`;
    });
  }

  if (proxy) {
    await check(`operator proxy (${proxy}/api/kiosk/logs)`, 'The Next.js rewrite is not forwarding /api to the server.', async () => {
      const response = await fetch(
        `${proxy}/api/kiosk/logs?kioskId=${encodeURIComponent(kioskId)}&limit=1`,
        { signal: AbortSignal.timeout(20_000) },
      );
      expectStatus(response, [200]);
      return 'HTTP 200 · rewrite works';
    });
  }

  report();
}

/** Prints the results table and exits 1 when any check failed. */
function report() {
  const width = Math.max(...results.map((r) => r.name.length)) + 2;
  console.log(`\nAPI availability — ${base}${proxy ? `  (proxy ${proxy})` : ''}\n`);
  for (const result of results) {
    const mark = result.ok ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${result.name.padEnd(width)} ${result.detail}`);
    if (!result.ok && result.hint) console.log(`      ↳ ${result.hint}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Checker crashed:', error);
  process.exit(2);
});
