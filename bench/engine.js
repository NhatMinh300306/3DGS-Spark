import { Clock, Recorder, Gate, aborted } from './core.js';
import { AssetNetwork } from './network.js';

export function sourceBytes(mesh) {
  const buffers = new Set();
  const p = mesh.packedSplats;
  for (const a of [p?.packedArray, ...Object.values(p?.extra || {})])
    if (ArrayBuffer.isView(a)) buffers.add(a.buffer);
  return [...buffers].reduce((n, b) => n + b.byteLength, 0);
}
export function estimateFrame(frame, treatment) {
  return frame[treatment].reduce(
    (n, f) => n + Math.max(2048, Math.ceil(f.splats / 2048) * 2048) * 80,
    0,
  );
}
export class FrameCache {
  constructor(limit) {
    this.limit = limit;
    this.items = new Map();
    this.used = 0;
  }
  get(key) {
    const a = this.items.get(key);
    if (a) {
      this.items.delete(key);
      this.items.set(key, a);
    }
    return a;
  }
  delete(key, rec) {
    const a = this.items.get(key);
    if (!a) return;
    for (const m of a.meshes) {
      m.parent?.remove(m);
      m.dispose();
      if (rec) rec.count.disposed++;
    }
    a.root?.parent?.remove(a.root);
    this.used -= a.reservation;
    this.items.delete(key);
    rec?.event('asset-disposed', {}, { asset_key: key, meshes: a.meshes.length });
  }
  reserve(key, bytes, pins, rec) {
    if (bytes > this.limit) throw Error('A frame exceeds parsed/source budget');
    while (this.used + bytes > this.limit) {
      const victim = [...this.items].find(([k, a]) => !pins.has(k) && a.ready);
      if (!victim) return null;
      this.delete(victim[0], rec);
    }
    const a = {
      key,
      reservation: bytes,
      meshes: [],
      root: null,
      ready: false,
      uploaded: false,
      sourceBytes: 0,
    };
    this.items.set(key, a);
    this.used += bytes;
    return a;
  }
  trim(limit, rec) {
    this.limit = limit;
    while (this.used > limit) {
      const victim = [...this.items].find(([, a]) => a.ready);
      if (!victim) break;
      this.delete(victim[0], rec);
    }
  }
  clear(rec) {
    for (const k of [...this.items.keys()]) this.delete(k, rec);
  }
}

export class Session {
  constructor({
    manifest,
    config,
    adapter,
    byteCache,
    frameCache,
    now = () => performance.now(),
    fetcher = fetch,
  }) {
    Object.assign(this, { manifest, config, adapter, byteCache, frameCache, now });
    this.rec = new Recorder(config, now);
    this.clock = new Clock(config.fps, now);
    this.frames = manifest.qualities.find((q) => q.id === config.res)?.frames;
    if (!this.frames?.length || this.frames.some((f) => !f[config.treatment]))
      throw Error('Treatment/res missing in manifest');
    this.frameCache.trim(config.parsedBytes, this.rec);
    this.byteCache.trim(config.byteCacheBytes);
    this.frameGate = new Gate(config.frameConcurrency || 2);
    this.decode = new Gate(config.decodes);
    this.network = new AssetNetwork({
      recorder: this.rec,
      concurrency: config.requests,
      rawBudget: config.rawBytes,
      byteCache,
      cacheMode: config.cacheMode,
      timeoutMs: config.timeoutMs,
      fetcher,
    });
    this.controller = new AbortController();
    this.plans = new Map();
    this.pending = new Set();
    this.ordinal = 0;
    this.startIndex = 0;
    this.seekEpoch = 0;
    this.busy = false;
    this.stopped = false;
    this.current = null;
    this.renderPromise = null;
    this.lastSample = now();
    this.lastCounts = { ...this.rec.count };
    this.seekStart = null;
    this.transition = false;
    this.pausedSeek = false;
    const costs = this.frames.map((f) => estimateFrame(f, config.treatment));
    const needed = Math.max(
      ...costs.map((v, i) => v + (costs[(i + 1) % costs.length] || 0)),
      ...costs.map((_, i) =>
        Array.from(
          { length: Math.min(config.startupFrames, costs.length) },
          (_, j) => costs[(i + j) % costs.length],
        ).reduce((a, b) => a + b, 0),
      ),
    );
    if (needed > config.parsedBytes)
      throw Error(
        `Parsed/source budget too small for current + next/startup: need at least ${Math.ceil(needed / 1048576)} MiB`,
      );
    if (this.frames.some((f) => f[config.treatment].some((a) => a.bytes * 2 > config.rawBytes)))
      throw Error('Raw budget too small for largest PLY and Spark input copy reservation');
    this.rec.event(
      'run-start',
      {},
      {
        policy: 'complete-only / hold / no ABR / no culling',
        initial_byte_cache_bytes: byteCache.bytes,
        initial_prepared_cache_bytes: frameCache.used,
      },
    );
    this.fill();
  }
  frameAt(n) {
    const k = this.startIndex + n;
    if (!this.config.loop && k >= this.frames.length) return null;
    return {
      frame: this.frames[k % this.frames.length],
      cycle: Math.floor(k / this.frames.length),
    };
  }
  key(frame) {
    return `${this.manifest.scene_id}|${this.config.res}|${this.config.treatment}|${frame[this.config.treatment].map((f) => f.url + ':' + f.bytes).join('|')}`;
  }
  context(plan, tile = null) {
    return {
      cycle_id: plan.cycle,
      frame_id: plan.frame.id,
      tile_id: tile,
      occurrence_id: `${this.seekEpoch}:${plan.ordinal}`,
    };
  }
  pins() {
    return new Set(
      [
        this.current?.asset.key,
        ...[...this.plans.values()]
          .filter((p) => p.ordinal >= this.ordinal)
          .map((p) => p.asset.key),
      ].filter(Boolean),
    );
  }
  fill() {
    if (this.stopped || this.transition) return;
    for (let n = this.ordinal; n < this.ordinal + this.config.horizon; n++) {
      if (this.plans.has(n)) continue;
      const ref = this.frameAt(n);
      if (!ref) break;
      const key = this.key(ref.frame);
      let asset = this.frameCache.get(key);
      if (asset && !asset.ready) break;
      const reused = !!asset;
      if (!asset) {
        asset = this.frameCache.reserve(
          key,
          estimateFrame(ref.frame, this.config.treatment),
          this.pins(),
          this.rec,
        );
        if (!asset) break;
      }
      const plan = { ...ref, ordinal: n, asset, ready: false, tiles: [], error: null };
      this.plans.set(n, plan);
      plan.row = this.rec.add('frames', {
        ...this.rec.context(this.context(plan)),
        ordinal: n,
        playback_epoch: this.clock.epoch,
        status: 'queued',
        enqueued_at_ms: this.now(),
        bytes_ready_at_ms: null,
        parsed_ready_at_ms: null,
        first_submit_at_ms: null,
        presented_estimate_at_ms: null,
        gpu_complete_observed_at_ms: null,
        gpu_complete_reason: 'not_observed',
        fixed_deadline_at_ms: this.clock.deadline(n),
        tile_count: ref.frame[this.config.treatment].length,
        cache_prepared: reused,
      });
      if (reused) {
        for (const f of ref.frame[this.config.treatment]) {
          plan.tiles.push(
            this.rec.add('tiles', {
              ...this.rec.context(this.context(plan, f.id)),
              status: 'parsed',
              parse_pack_wall_ms: null,
              parse_pack_reason: 'app_prepared_cache',
              bytes_ready_at_ms: this.now(),
              parsed_ready_at_ms: this.now(),
              upload_submit_at_ms: null,
              presented_estimate_at_ms: null,
            }),
          );
          this.rec.add('requests', {
            ...this.rec.context(this.context(plan, f.id)),
            url: f.url,
            status: 'success',
            source: 'app_prepared_cache',
            source_reason: 'already_initialized_SplatMesh',
            body_bytes: 0,
            app_cache_bytes: f.bytes,
            fetch_ms: null,
            ttfb_ms: null,
            body_buckets: [],
          });
          this.rec.count.request_success++;
        }
        plan.ready = true;
        plan.row.status = 'parsed';
        plan.row.parsed_ready_at_ms = this.now();
        plan.row.bytes_ready_at_ms = this.now();
      } else {
        const task = this.prepare(plan, this.controller.signal);
        this.pending.add(task);
        task
          .catch((e) => {
            plan.error = e;
          })
          .finally(() => this.pending.delete(task));
      }
    }
  }
  async prepare(plan, signal) {
    let freeFrame;
    const r = this.rec;
    const asset = plan.asset;
    try {
      freeFrame = await this.frameGate.acquire(1, signal);
      let loaded = 0;
      const results = await Promise.allSettled(
        plan.frame[this.config.treatment].map(async (file) => {
          const row = r.add('tiles', {
            ...r.context(this.context(plan, file.id)),
            status: 'queued',
            parse_pack_wall_ms: null,
            worker_internal_queue_ms: null,
            worker_transfer_ms: null,
            ply_parse_only_ms: null,
            pack_only_ms: null,
            unavailable_reason: 'stock Spark exposes initialized wall only',
            bytes_ready_at_ms: null,
            parsed_ready_at_ms: null,
            upload_submit_at_ms: null,
            upload_submit_cpu_ms: null,
            presented_estimate_at_ms: null,
          });
          plan.tiles.push(row);
          let load, releaseDecode, mesh;
          try {
            load = await this.network.load(file, this.context(plan, file.id), signal);
            row.bytes_ready_at_ms = this.now();
            plan.row.first_tile_bytes_ready_at_ms ??= row.bytes_ready_at_ms;
            if (++loaded === plan.frame[this.config.treatment].length)
              plan.row.bytes_ready_at_ms = this.now();
            const queued = this.now();
            releaseDecode = await this.decode.acquire(1, signal);
            row.app_decode_queue_ms = this.now() - queued;
            if (signal.aborted) throw aborted();
            const parsed = await this.adapter.prepare(
              load.buffer,
              file,
              this.config.measureBounds,
              { created: () => r.count.created++, disposed: () => r.count.disposed++ },
            );
            mesh = parsed.mesh;
            Object.assign(row, parsed.metrics);
            if (signal.aborted) {
              r.count.stale++;
              mesh.dispose();
              r.count.disposed++;
              mesh = null;
              throw aborted();
            }
            if (mesh.numSplats !== file.splats) throw Error(`Gaussian count mismatch: ${file.url}`);
            mesh.benchmarkFileId = file.id;
            asset.meshes.push(mesh);
            mesh = null;
            row.parsed_ready_at_ms = this.now();
            plan.row.first_tile_parsed_at_ms ??= row.parsed_ready_at_ms;
            row.status = 'parsed';
          } catch (e) {
            if (mesh) {
              mesh.dispose();
              r.count.disposed++;
            }
            row.status = signal.aborted ? 'cancelled' : 'error';
            row.error = String(e.message || e);
            throw e;
          } finally {
            releaseDecode?.();
            load?.release();
          }
        }),
      );
      const failure = results.find((x) => x.status === 'rejected');
      if (failure) throw failure.reason;
      if (signal.aborted) throw aborted();
      const order = plan.frame[this.config.treatment].map((f) => f.id);
      asset.meshes.sort(
        (a, b) => order.indexOf(a.benchmarkFileId) - order.indexOf(b.benchmarkFileId),
      );
      asset.root = this.adapter.group(asset.meshes, this.manifest.rotation_x_degrees || 0);
      asset.sourceBytes = asset.meshes.reduce((n, m) => n + sourceBytes(m), 0);
      if (asset.sourceBytes > asset.reservation)
        throw Error(
          'Observed Spark source buffers exceed reservation; raise estimate before benchmarking',
        );
      asset.ready = true;
      plan.ready = true;
      plan.row.status = 'parsed';
      plan.row.parsed_ready_at_ms = this.now();
      r.event('frame-parsed', this.context(plan));
    } catch (e) {
      this.frameCache.delete(asset.key, r);
      plan.row.status = signal.aborted ? 'cancelled' : 'error';
      plan.error = e;
      throw e;
    } finally {
      freeFrame?.();
    }
  }
  readyAhead() {
    let n = 0;
    for (let i = this.ordinal; this.plans.get(i)?.ready; i++) {
      n++;
      if (n > this.config.horizon) break;
    }
    return n;
  }
  memory() {
    const raw = new Set([...this.network.activeBuffers, ...this.byteCache.items.values()]);
    const assets = [...this.frameCache.items.values()];
    const m = {
      raw_unique_arraybuffer_bytes: [...raw].reduce((n, b) => n + b.byteLength, 0),
      raw_budget_reserved_bytes: this.network.raw.used,
      app_byte_cache_bytes: this.byteCache.bytes,
      parsed_source_arraybuffer_bytes: assets.reduce(
        (n, a) => n + a.meshes.reduce((s, m) => s + sourceBytes(m), 0),
        0,
      ),
      parsed_source_reserved_bytes: this.frameCache.used,
      gpu_source_estimate_bytes: assets
        .filter((a) => a.uploaded)
        .reduce((n, a) => n + a.reservation, 0),
      prepared_frames: assets.filter((a) => a.ready).length,
      active_gaussians: this.current?.asset.meshes.reduce((n, m) => n + m.numSplats, 0) || 0,
    };
    if (globalThis.performance?.memory)
      m.js_heap_browser_reported_bytes = performance.memory.usedJSHeapSize;
    this.rec.memory(m);
    return m;
  }
  sample(force = false) {
    const t = this.now(),
      dt = t - this.lastSample;
    if (!force && dt < 500) return;
    const c = this.rec.count;
    const row = {
      at_ms: t,
      state: this.clock.state,
      buffer_ready_frames: this.readyAhead(),
      buffer_ready_seconds: this.readyAhead() / this.config.fps,
      render_submit_fps: dt > 0 ? ((c.renders - this.lastCounts.renders) * 1000) / dt : null,
      raf_hz: dt > 0 ? ((c.raf - this.lastCounts.raf) * 1000) / dt : null,
      content_fps: dt > 0 ? ((c.content - this.lastCounts.content) * 1000) / dt : null,
      tile_updates_per_second:
        dt > 0 ? ((c.tile_updates - this.lastCounts.tile_updates) * 1000) / dt : null,
      bytes_body_cumulative: this.rec.tables.requests.reduce((n, x) => n + (x.body_bytes || 0), 0),
      ...this.memory(),
    };
    this.rec.add('samples', row);
    this.lastSample = t;
    this.lastCounts = { ...c };
  }
  deadlines() {
    for (const p of this.plans.values())
      if (!p.row.presented_estimate_at_ms)
        p.row.fixed_deadline_at_ms = this.clock.deadline(p.ordinal);
  }
  tick(t = this.now()) {
    this.rec.count.raf++;
    if (this.stopped) return;
    this.sample();
    this.deadlines();
    this.fill();
    if (this.rec.dropped) {
      this.error = Error('Log limit reached; run invalid');
      return;
    }
    if (t - this.rec.start > this.config.maxRunMs) {
      this.error = Error('Run timeout');
      return;
    }
    if (this.busy || this.transition) return;
    const p = this.plans.get(this.ordinal);
    if (p?.error) {
      this.error = p.error;
      return;
    }
    if (!p) {
      if (!this.frameAt(this.ordinal) && this.clock.nextDue !== null && t >= this.clock.nextDue)
        this.ended = true;
      return;
    }
    if (
      this.clock.state === 'startup' &&
      this.readyAhead() < Math.min(this.config.startupFrames, this.frames.length - this.startIndex)
    )
      return;
    if (this.clock.state === 'startup') this.clock.start(t);
    if (this.clock.state === 'seeking') {
      if (!p.ready) return;
      this.clock.seekReady(t, !this.pausedSeek);
    }
    const due =
      (this.clock.state !== 'paused' && (this.clock.nextDue === null || t >= this.clock.nextDue)) ||
      (this.seekStart !== null && p.ready);
    if (due && !p.ready) this.clock.buffer(t);
    const candidate = due && p.ready ? p : null;
    const shown = candidate || this.current;
    if (!shown) return;
    this.busy = true;
    const signal = this.controller.signal;
    this.renderPromise = (async () => {
      const rr = await this.adapter.render(
        shown.asset,
        this.context(shown),
        this.rec,
        shown.tiles,
        signal,
        !!candidate,
      );
      this.rec.count.renders++;
      if (signal.aborted) return;
      if (candidate) {
        const at = rr.presented_estimate_at_ms;
        if (this.rec.count.content === 0) {
          this.clock.startupEnd = at;
          this.clock.anchor = at;
          this.clock.paused = 0;
          if (this.clock.pauseStart !== null) this.clock.pauseStart = at;
          this.clock.nextDue = at;
          if (this.clock.activeStart !== null) this.clock.activeStart = at;
        }
        const row = candidate.row;
        row.playback_epoch = this.clock.epoch;
        row.status = 'presented';
        row.fixed_deadline_at_ms = this.clock.deadline(candidate.ordinal, at);
        row.first_submit_at_ms = rr.render_submit_start_at_ms;
        row.presented_estimate_at_ms = at;
        row.present_lateness_ms =
          row.fixed_deadline_at_ms === null ? null : Math.max(0, at - row.fixed_deadline_at_ms);
        row.gpu_ready_at_ms = null;
        row.gpu_ready_reason = 'draw submission is not GPU ready';
        this.adapter.trackFence?.(row);
        for (const tile of candidate.tiles) {
          tile.status = 'presented';
          tile.presented_estimate_at_ms = at;
        }
        this.rec.count.content++;
        if (this.config.treatment === 'tiles')
          this.rec.count.tile_updates += candidate.tiles.length;
        this.rec.event('complete-frame-presented', this.context(candidate), {
          at_ms: at,
          ordinal: candidate.ordinal,
        });
        this.current = candidate;
        if (this.seekStart !== null) {
          this.rec.event('seek-presented', this.context(candidate), {
            latency_ms: at - this.seekStart,
          });
          this.seekStart = null;
        }
        if (this.clock.state === 'paused') this.clock.nextDue = at + this.clock.period;
        else this.clock.shown(at);
        this.ordinal++;
        for (const n of [...this.plans.keys()]) if (n < this.ordinal) this.plans.delete(n);
        this.deadlines();
        this.fill();
      }
    })()
      .catch((e) => {
        if (!signal.aborted) this.error = e;
      })
      .finally(() => {
        this.busy = false;
      });
  }
  pause() {
    this.clock.pause();
    this.rec.event('pause');
  }
  resume() {
    this.clock.resume();
    this.deadlines();
    this.rec.event('resume');
  }
  async seek(index) {
    if (this.stopped || this.transition) return;
    this.transition = true;
    this.pausedSeek = this.clock.state === 'paused';
    this.seekStart = this.now();
    this.clock.seek(this.seekStart);
    this.controller.abort();
    await Promise.allSettled([this.renderPromise, ...this.pending].filter(Boolean));
    for (const p of this.plans.values())
      if (p.row.status !== 'presented') p.row.status = 'cancelled_seek';
    this.plans.clear();
    this.controller = new AbortController();
    this.startIndex = index;
    this.ordinal = 0;
    this.seekEpoch++;
    this.transition = false;
    this.rec.event('seek', {}, { target_index: index });
    this.fill();
  }
  finalizeGoodput() {
    const buckets = new Map();
    for (const r of this.rec.tables.requests)
      for (const [b, n] of r.body_buckets || []) {
        const x = buckets.get(b) || { all: 0, network: 0, cache: 0, unknown: 0 };
        x.all += n;
        x[r.source === 'network' ? 'network' : r.source === 'http_cache' ? 'cache' : 'unknown'] +=
          n;
        buckets.set(b, x);
      }
    for (const s of this.rec.tables.samples) {
      const lo = Math.floor((s.at_ms - this.rec.start - 500) / 100),
        hi = Math.floor((s.at_ms - this.rec.start) / 100);
      let all = 0,
        net = 0;
      for (let i = lo; i <= hi; i++) {
        const b = buckets.get(i);
        all += b?.all || 0;
        net += b?.network || 0;
      }
      s.goodput_window_ms = (hi - lo + 1) * 100;
      s.body_receive_bps_approx_window = (all * 8000) / s.goodput_window_ms;
      s.network_classified_bps_approx_window = (net * 8000) / s.goodput_window_ms;
    }
  }
  async stop(status = 'stopped') {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      const t = this.now();
      this.stopped = true;
      this.deadlines();
      this.clock.stop(t);
      this.controller.abort();
      await Promise.allSettled([this.renderPromise, ...this.pending].filter(Boolean));
      this.sample(true);
      this.adapter.reset();
      if (this.config.cacheMode !== 'app-processed') this.frameCache.clear(this.rec);
      if (!['app-bytes', 'app-processed'].includes(this.config.cacheMode)) this.byteCache.clear();
      this.memory();
      this.finalizeGoodput();
      this.rec.event('run-stop', {}, { cleanup_ms: this.now() - t });
      this.rec.finish(status, t);
      return this.rec.summary(this.clock);
    })();
    return this.stopPromise;
  }
}
