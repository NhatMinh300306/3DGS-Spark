import test from 'node:test';
import assert from 'node:assert/strict';
import { Recorder, ByteCache } from '../dist/bench/core.js';
import { AssetNetwork, GpuTimer } from '../dist/bench/network.js';
const file = { url: 'http://localhost/a.ply', bytes: 4, id: '0' };
function network(fetcher, mode = 'bypass') {
  return new AssetNetwork({
    recorder: new Recorder({}),
    concurrency: 2,
    rawBudget: 16,
    byteCache: new ByteCache(16),
    cacheMode: mode,
    fetcher,
    perf: { getEntriesByName: () => [] },
  });
}
test('network records actual body and releases raw reservation after consumer', async () => {
  const n = network(async () => new Response(new Uint8Array([1, 2, 3, 4])));
  const x = await n.load(file, {}, new AbortController().signal);
  assert.equal(x.row.body_bytes, 4);
  assert.equal(x.row.source, 'unknown');
  assert.equal(n.raw.used, 8);
  assert.equal(n.activeBuffers.size, 1);
  x.release();
  x.release();
  assert.equal(n.raw.used, 0);
  assert.equal(n.activeBuffers.size, 0);
});
test('truncation and missing file fail without leaking budgets', async () => {
  for (const response of [new Response(new Uint8Array(3)), new Response('', { status: 404 })]) {
    const n = network(async () => response);
    await assert.rejects(n.load(file, {}, new AbortController().signal));
    assert.equal(n.raw.used, 0);
    assert.equal(n.slots.used, 0);
    assert.equal(n.activeBuffers.size, 0);
    assert.equal(n.recorder.count.request_error, 1);
  }
});
test('application cache is not a network goodput sample', async () => {
  let calls = 0;
  const n = network(async () => {
    calls++;
    return new Response(new Uint8Array(4));
  }, 'app-bytes');
  const a = await n.load(file, {});
  a.release();
  const b = await n.load(file, {});
  assert.equal(calls, 1);
  assert.equal(b.row.source, 'app_byte_cache');
  assert.equal(b.row.fetch_ms, null);
  assert.equal(b.row.body_bytes, 0);
});
test('abort before a request neither fetches nor leaks', async () => {
  let calls = 0;
  const n = network(async () => {
    calls++;
    return new Response('a');
  });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(n.load(file, {}, ac.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
  assert.equal(n.raw.used, 0);
});
test('GPU query polls asynchronously and discards disjoint', () => {
  let disjoint = false,
    available = false,
    deleted = 0;
  const gl = {
    getExtension: () => ({ TIME_ELAPSED_EXT: 1, GPU_DISJOINT_EXT: 2 }),
    createQuery: () => ({}),
    beginQuery() {},
    endQuery() {},
    getParameter: () => disjoint,
    getQueryParameter: (q, k) => (k === 3 ? available : 2e6),
    deleteQuery() {
      deleted++;
    },
    QUERY_RESULT_AVAILABLE: 3,
    QUERY_RESULT: 4,
  };
  const t = new GpuTimer(gl);
  const row = {};
  t.begin(row);
  t.end();
  t.poll();
  assert.equal(row.gpu_draw_ms, null);
  available = true;
  t.poll();
  assert.equal(row.gpu_draw_ms, 2);
  assert.equal(deleted, 1);
  const bad = {};
  t.begin(bad);
  t.end();
  disjoint = true;
  t.poll();
  assert.equal(bad.gpu_draw_ms, null);
  assert.equal(bad.gpu_draw_reason, 'disjoint');
  assert.equal(deleted, 2);
});
