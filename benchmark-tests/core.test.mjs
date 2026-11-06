import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Clock,
  Recorder,
  Gate,
  ByteCache,
  stats,
  unionMs,
  classify,
  csv,
  manifest,
} from '../dist/bench/core.js';

test('quantiles need sufficient independent samples', () => {
  assert.equal(stats([1, 2]).median, 1.5);
  assert.equal(stats([1, 2]).p95, null);
  assert.equal(stats(Array.from({ length: 100 }, (_, i) => i)).p99, 98.01);
  assert.equal(stats([null, NaN]).mean, null);
});
test('parallel intervals use union wall time', () =>
  assert.equal(
    unionMs([
      [0, 100],
      [50, 200],
      [300, 350],
    ]),
    250,
  ));
test('cache classification is conservative', () => {
  assert.equal(classify(null, true).source, 'unknown');
  assert.equal(classify({ transferSize: 0, decodedBodySize: 0 }, false).source, 'unknown');
  assert.equal(classify({ transferSize: 0, decodedBodySize: 100 }, true).source, 'http_cache');
  assert.equal(
    classify({ transferSize: 120, encodedBodySize: 100, decodedBodySize: 100 }, true).source,
    'network',
  );
  assert.equal(
    classify({ transferSize: 120, encodedBodySize: 0, decodedBodySize: 100 }, true).source,
    'unknown',
  );
  assert.equal(
    classify({ workerStart: 1, transferSize: 120, encodedBodySize: 100 }, true).source,
    'unknown',
  );
});
test('weighted gate cancellation does not leak slots', async () => {
  const g = new Gate(3);
  const free = await g.acquire(2);
  const ac = new AbortController();
  const waiting = g.acquire(2, ac.signal);
  ac.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  free();
  assert.equal(g.used, 0);
  assert.equal(g.queue.length, 0);
  await assert.rejects(g.acquire(4));
});
test('gate FIFO enforces concurrency and idempotent release', async () => {
  const g = new Gate(1);
  const a = await g.acquire();
  let entered = false;
  const b = g.acquire().then((f) => {
    entered = true;
    return f;
  });
  await Promise.resolve();
  assert.equal(entered, false);
  a();
  a();
  const free = await b;
  assert.equal(g.used, 1);
  free();
  assert.equal(g.used, 0);
});
test('byte cache obeys LRU and lowered limits', () => {
  const b = new ByteCache(6);
  b.put('a', new ArrayBuffer(3));
  b.put('b', new ArrayBuffer(3));
  b.get('a');
  b.put('c', new ArrayBuffer(3));
  assert.equal(b.get('b'), undefined);
  b.trim(3);
  assert.equal(b.bytes, 3);
  b.clear();
  assert.equal(b.bytes, 0);
});
test('playback ordinary jitter keeps phase, stall rebases hold clock only', () => {
  const c = new Clock(30, () => 0);
  c.start(0);
  c.shown(0);
  assert.equal(c.nextDue, 1000 / 30);
  c.shown(35);
  assert.equal(c.nextDue, 2000 / 30);
  c.buffer(67);
  c.shown(200);
  assert.equal(c.nextDue, 200 + 1000 / 30);
  assert.equal(c.deadline(6), 200);
  assert.equal(c.stallMs(200), 133);
});
test('user pause and seek excluded from buffering', () => {
  const c = new Clock(10);
  c.start(100);
  c.shown(100);
  c.buffer(200);
  c.pause(250);
  c.resume(1250);
  assert.equal(c.stallMs(1250), 50);
  assert.equal(c.deadline(2, 1250), 1300);
  assert.equal(c.activeMs(1250), 150);
  c.seek(1300);
  c.seekReady(1500, true);
  assert.equal(c.stallMs(1500), 50);
  assert.equal(c.deadline(1), 1600);
});
test('CSV handles quotes, null and formulas', () => {
  const s = csv([{ x: '=test', y: 'a,b', z: null }]);
  assert.match(s, /'=test/);
  assert.match(s, /"a,b"/);
  assert.ok(s.endsWith(','));
});
test('Recorder bounds logs, OFF marks missing metrics', () => {
  let t = 0;
  const r = new Recorder({ logLimit: 2 }, () => t);
  r.event('a');
  r.event('b');
  r.event('c');
  assert.equal(r.dropped, 1);
  assert.equal(r.status, 'log_limit');
  const off = new Recorder({ instrumentation: false }, () => t);
  off.add('requests', { body_bytes: 100 });
  off.add('frames', {});
  assert.equal(off.tables.requests.length, 0);
  assert.equal(off.summary(new Clock(30)).bytes_body_received, null);
});
test('manifest rejects mismatched timelines and unsafe URLs', () => {
  const a = { id: '0', url: 'a.ply', bytes: 10, splats: 1 };
  const f = { id: 1450, full: [a] };
  const m = {
    schema: 'splat-benchmark-v1',
    scene_id: 't',
    fps: 30,
    camera: { position: [0, 0, 1], target: [0, 0, 0] },
    qualities: [{ id: 'res1', frames: [f] }],
  };
  assert.equal(
    manifest(m, 'http://localhost/data/manifest.json').qualities[0].frames[0].full[0].url,
    'http://localhost/data/a.ply',
  );
  assert.throws(() =>
    manifest(
      {
        ...m,
        qualities: [{ id: 'res1', frames: [{ ...f, full: [{ ...a, url: 'file:///etc/a.ply' }] }] }],
      },
      'http://localhost/',
    ),
  );
  assert.throws(() =>
    manifest(
      { ...m, qualities: [...m.qualities, { id: 'res2', frames: [{ ...f, id: 1451 }] }] },
      'http://localhost/',
    ),
  );
});
