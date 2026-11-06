import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, FrameCache } from '../dist/bench/engine.js';
import { ByteCache } from '../dist/bench/core.js';
function mock() {
  let t = 0;
  let disposed = 0;
  const adapter = {
    async prepare(b, f) {
      return {
        mesh: {
          numSplats: 1,
          packedSplats: { packedArray: new Uint32Array(4) },
          dispose() {
            disposed++;
          },
        },
        metrics: { parse_pack_wall_ms: 1 },
      };
    },
    group(meshes) {
      return { meshes };
    },
    async render(a, c, r) {
      return { presented_estimate_at_ms: t, render_submit_start_at_ms: t };
    },
    reset() {},
  };
  return {
    adapter,
    now: () => t,
    advance(n) {
      t += n;
    },
    get disposed() {
      return disposed;
    },
  };
}
function setup(treatment = 'full', fetcher = async () => new Response(new Uint8Array(4))) {
  const m = mock();
  const frames = [1450, 1451, 1452].map((id) => ({
    id,
    full: [{ id: '0', url: `http://localhost/${id}.ply`, bytes: 4, splats: 1 }],
    tiles: [0, 1].map((i) => ({
      id: String(i),
      url: `http://localhost/${id}-${i}.ply`,
      bytes: 4,
      splats: 1,
    })),
  }));
  const c = {
    scene_id: 'x',
    res: 'res8',
    treatment,
    fps: 30,
    loop: false,
    horizon: 3,
    startupFrames: 1,
    requests: 2,
    decodes: 2,
    rawBytes: 64,
    parsedBytes: 1000000,
    byteCacheBytes: 100,
    cacheMode: 'bypass',
    maxRunMs: 10000,
    timeoutMs: 1000,
  };
  const s = new Session({
    manifest: { scene_id: 'x', qualities: [{ id: 'res8', frames }] },
    config: c,
    adapter: m.adapter,
    byteCache: new ByteCache(100),
    frameCache: new FrameCache(c.parsedBytes),
    now: m.now,
    fetcher,
  });
  return { m, s };
}
async function drain(s) {
  await Promise.allSettled([...s.pending]);
  await Promise.resolve();
}
async function render(s, m) {
  s.tick(m.now());
  if (s.renderPromise) await s.renderPromise;
}
test('real scheduler Full PLY presents each occurrence and keeps fixed deadlines', async () => {
  const { s, m } = setup();
  await drain(s);
  await render(s, m);
  m.advance(34);
  await render(s, m);
  m.advance(34);
  await render(s, m);
  m.advance(34);
  await render(s, m);
  assert.equal(s.rec.count.content, 3);
  assert.equal(s.ended, true);
  assert.equal(s.rec.tables.requests.length, 3);
  const z = await s.stop('completed');
  assert.equal(z.complete_presentations, 3);
  assert.equal(z.actually_skipped_frames, 0);
  assert.equal(z.buffering_ms, 0);
  assert.equal(s.frameCache.used, 0);
});
test('Tile scheduler waits for all tiles, never counts tiles as content frames', async () => {
  const { s, m } = setup('tiles');
  await drain(s);
  await render(s, m);
  assert.equal(s.rec.count.content, 1);
  assert.equal(s.rec.count.tile_updates, 2);
  assert.equal(s.rec.tables.frames[0].tile_count, 2);
  assert.equal(s.rec.tables.tiles.filter((x) => x.status === 'presented').length, 2);
  await s.stop();
});
test('missing tile prevents partial frame and records error', async () => {
  const { s, m } = setup('tiles', async (url) =>
    url.includes('1450-1') ? new Response('', { status: 404 }) : new Response(new Uint8Array(4)),
  );
  await drain(s);
  await render(s, m);
  assert.equal(s.rec.count.content, 0);
  assert.ok(s.error);
  assert.equal(s.rec.count.request_error, 1);
  await s.stop('error');
  assert.equal(s.network.raw.used, 0);
});
test('seek cancels obsolete plans and can present requested frame', async () => {
  const { s, m } = setup();
  await drain(s);
  await render(s, m);
  await s.seek(2);
  await drain(s);
  m.advance(10);
  await render(s, m);
  assert.equal(s.current.frame.id, 1452);
  assert.ok(s.rec.tables.events.some((x) => x.type === 'seek-presented'));
  await s.stop();
});
test('stop waits for pending parse and stale results are disposed', async () => {
  const releases = [];
  const { s, m } = setup();
  m.adapter.prepare = () =>
    new Promise((resolve) =>
      releases.push(() =>
        resolve({ mesh: { numSplats: 1, dispose() {}, packedSplats: {} }, metrics: {} }),
      ),
    );
  await new Promise((resolve) => setImmediate(resolve));
  const stop = s.stop();
  while (releases.length) releases.shift()();
  await stop;
  assert.equal(s.network.raw.used, 0);
  assert.equal(s.rec.count.content, 0);
  assert.ok(s.rec.count.stale > 0);
});
