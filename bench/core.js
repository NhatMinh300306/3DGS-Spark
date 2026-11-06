export const SCHEMA = 'splat-benchmark-v1';
export const MiB = 1048576;
export const aborted = () => new DOMException('Cancelled', 'AbortError');

export function stats(values) {
  const a = values.filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p) => {
    const x = (a.length - 1) * p,
      i = Math.floor(x);
    return a[i] + (a[Math.ceil(x)] - a[i]) * (x - i);
  };
  return {
    valid_n: a.length,
    mean: a.length ? a.reduce((s, x) => s + x, 0) / a.length : null,
    median: a.length ? q(0.5) : null,
    p95: a.length >= 20 ? q(0.95) : null,
    p99: a.length >= 100 ? q(0.99) : null,
    reason: a.length ? 'p95 needs 20 samples; p99 needs 100' : 'no_valid_samples',
  };
}
export function unionMs(intervals) {
  const sorted = intervals
    .filter(([a, b]) => Number.isFinite(a) && b >= a)
    .sort((a, b) => a[0] - b[0]);
  let start = null,
    end = null,
    total = 0;
  for (const [a, b] of sorted) {
    if (start === null) {
      start = a;
      end = b;
    } else if (a > end) {
      total += end - start;
      start = a;
      end = b;
    } else end = Math.max(end, b);
  }
  return total + (start === null ? 0 : end - start);
}
export function classify(e, sameOrigin) {
  if (!e) return { source: 'unknown', source_reason: 'resource_timing_absent' };
  if (e.workerStart > 0) return { source: 'unknown', source_reason: 'service_worker_intercepted' };
  if (!sameOrigin && e.transferSize === 0 && e.decodedBodySize === 0)
    return { source: 'unknown', source_reason: 'TAO_may_be_redacted' };
  if (e.deliveryType === 'cache' || (e.transferSize === 0 && e.decodedBodySize > 0))
    return {
      source: 'http_cache',
      source_reason: 'cache_delivery_or_zero_transfer_with_positive_visible_body',
    };
  if (
    e.responseStatus === 304 ||
    (e.transferSize > 0 && e.encodedBodySize === 0 && e.decodedBodySize > 0)
  )
    return { source: 'unknown', source_reason: 'mixed_cache_revalidation' };
  if (e.transferSize > 0 && e.encodedBodySize > 0)
    return { source: 'network', source_reason: 'positive_transfer_and_encoded_body' };
  return { source: 'unknown', source_reason: 'insufficient_timing_evidence' };
}
export class Gate {
  constructor(limit) {
    this.limit = limit;
    this.used = 0;
    this.queue = [];
  }
  acquire(weight = 1, signal) {
    if (!Number.isFinite(weight) || weight < 0 || weight > this.limit)
      return Promise.reject(Error('Task exceeds memory/concurrency budget'));
    if (signal?.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      const item = { weight, signal, resolve, reject };
      item.abort = () => {
        this.queue = this.queue.filter((x) => x !== item);
        reject(aborted());
        this.drain();
      };
      signal?.addEventListener('abort', item.abort, { once: true });
      this.queue.push(item);
      this.drain();
    });
  }
  drain() {
    while (this.queue.length && this.used + this.queue[0].weight <= this.limit) {
      const i = this.queue.shift();
      i.signal?.removeEventListener('abort', i.abort);
      this.used += i.weight;
      let released = false;
      i.resolve(() => {
        if (!released) {
          released = true;
          this.used -= i.weight;
          this.drain();
        }
      });
    }
  }
}
export class ByteCache {
  constructor(limit) {
    this.limit = limit;
    this.items = new Map();
    this.bytes = 0;
  }
  get(key) {
    const b = this.items.get(key);
    if (b) {
      this.items.delete(key);
      this.items.set(key, b);
    }
    return b;
  }
  put(key, b) {
    if (b.byteLength > this.limit) return;
    this.delete(key);
    while (this.bytes + b.byteLength > this.limit) this.delete(this.items.keys().next().value);
    this.items.set(key, b);
    this.bytes += b.byteLength;
  }
  delete(key) {
    const b = this.items.get(key);
    if (b) {
      this.bytes -= b.byteLength;
      this.items.delete(key);
    }
  }
  trim(limit) {
    this.limit = limit;
    while (this.bytes > limit) this.delete(this.items.keys().next().value);
  }
  clear() {
    this.items.clear();
    this.bytes = 0;
  }
}
export function manifest(raw, base) {
  const fail = (m) => {
    throw Error('Manifest: ' + m);
  };
  if (
    raw.schema !== SCHEMA ||
    !raw.scene_id ||
    !raw.qualities?.length ||
    !Number.isFinite(raw.fps) ||
    raw.fps <= 0 ||
    raw.fps > 120
  )
    fail('invalid scene/schema/fps');
  const vec = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  if (!raw.camera || !vec(raw.camera.position) || !vec(raw.camera.target))
    fail('camera position/target required');
  const ids = new Set();
  let timeline = null;
  return {
    ...raw,
    qualities: raw.qualities.map((q) => {
      if (!/^res[1248]$/.test(q.id) || ids.has(q.id) || !q.frames?.length)
        fail('invalid/duplicate res');
      ids.add(q.id);
      const fids = new Set();
      const frames = q.frames.map((f) => {
        if (!Number.isSafeInteger(f.id) || fids.has(f.id)) fail('invalid frame');
        fids.add(f.id);
        const out = { ...f };
        for (const type of ['full', 'tiles'])
          if (f[type]) {
            if (
              !Array.isArray(f[type]) ||
              !f[type].length ||
              (type === 'full' && f[type].length !== 1)
            )
              fail('invalid treatment file set');
            const unique = new Set();
            out[type] = f[type].map((a) => {
              const url = new URL(a.url, base);
              if (
                !['http:', 'https:'].includes(url.protocol) ||
                !url.pathname.toLowerCase().endsWith('.ply') ||
                !Number.isSafeInteger(a.bytes) ||
                a.bytes <= 0 ||
                !Number.isSafeInteger(a.splats) ||
                a.splats <= 0 ||
                unique.has(String(a.id))
              )
                fail('invalid PLY asset');
              unique.add(String(a.id));
              return { ...a, id: String(a.id), url: url.href };
            });
          }
        if (!out.full && !out.tiles) fail('no data for frame');
        return out;
      });
      const t = frames.map((f) => f.id).join(',');
      if (timeline !== null && t !== timeline) fail('res timelines differ');
      timeline = t;
      return { ...q, frames };
    }),
  };
}
export class Clock {
  constructor(fps, now = () => performance.now()) {
    this.now = now;
    this.period = 1000 / fps;
    this.state = 'startup';
    this.anchor = null;
    this.nextDue = null;
    this.startupEnd = null;
    this.activeStart = null;
    this.active = [];
    this.stalls = [];
    this.stallStart = null;
    this.pauseStart = null;
    this.paused = 0;
    this.epoch = 0;
  }
  start(t = this.now()) {
    if (this.anchor === null) this.paused = 0;
    this.state = 'playing';
    this.startupEnd ??= t;
    this.anchor = t;
    this.nextDue = t;
    this.activeStart = t;
  }
  deadline(n, t = this.now()) {
    return this.anchor === null || n === 0
      ? null
      : this.anchor +
          n * this.period +
          this.paused +
          (this.pauseStart === null ? 0 : t - this.pauseStart);
  }
  shown(t = this.now()) {
    const rebase =
      this.state === 'buffering' || this.nextDue === null || t - this.nextDue > this.period;
    this.closeStall(t);
    this.state = 'playing';
    this.nextDue = rebase ? t + this.period : this.nextDue + this.period;
  }
  buffer(t = this.now()) {
    if (this.state === 'playing') {
      this.state = 'buffering';
      this.stallStart = t;
    }
  }
  closeStall(t) {
    if (this.stallStart !== null) {
      this.stalls.push([this.stallStart, t]);
      this.stallStart = null;
    }
  }
  closeActive(t) {
    if (this.activeStart !== null) {
      this.active.push([this.activeStart, t]);
      this.activeStart = null;
    }
  }
  pause(t = this.now()) {
    if (['paused', 'seeking', 'ended', 'stopped'].includes(this.state)) return;
    this.closeStall(t);
    this.closeActive(t);
    this.state = 'paused';
    this.pauseStart = t;
    this.epoch++;
  }
  resume(t = this.now()) {
    if (this.state !== 'paused') return;
    const dt = t - this.pauseStart;
    this.paused += dt;
    if (this.nextDue !== null) this.nextDue += dt;
    this.pauseStart = null;
    this.state = this.startupEnd === null ? 'startup' : 'playing';
    if (this.startupEnd !== null) this.activeStart = t;
  }
  seek(t = this.now()) {
    this.closeStall(t);
    this.closeActive(t);
    this.state = 'seeking';
    this.anchor = null;
    this.nextDue = null;
    this.pauseStart = null;
    this.paused = 0;
    this.epoch++;
  }
  seekReady(t, playing) {
    this.anchor = t;
    this.nextDue = t;
    this.state = playing ? 'playing' : 'paused';
    this.activeStart = playing ? t : null;
    this.pauseStart = playing ? null : t;
  }
  stop(t = this.now()) {
    this.closeStall(t);
    this.closeActive(t);
    if (this.pauseStart !== null) {
      this.paused += t - this.pauseStart;
      this.pauseStart = null;
    }
    this.state = 'stopped';
  }
  activeMs(t = this.now()) {
    return (
      this.active.reduce((s, [a, b]) => s + b - a, 0) +
      (this.activeStart === null ? 0 : t - this.activeStart)
    );
  }
  stallMs(t = this.now()) {
    return (
      this.stalls.reduce((s, [a, b]) => s + b - a, 0) +
      (this.stallStart === null ? 0 : t - this.stallStart)
    );
  }
}
export class Recorder {
  constructor(config, now = () => performance.now()) {
    this.config = config;
    this.now = now;
    this.start = now();
    this.end = null;
    this.id = globalThis.crypto?.randomUUID?.() || `r-${Date.now()}-${Math.random()}`;
    this.enabled = config.instrumentation !== false;
    this.tables = Object.fromEntries(
      ['requests', 'frames', 'tiles', 'samples', 'renders', 'events'].map((n) => [n, []]),
    );
    this.limit = config.logLimit || 100000;
    this.rows = 0;
    this.dropped = 0;
    this.status = 'running';
    this.count = {
      raf: 0,
      renders: 0,
      content: 0,
      tile_updates: 0,
      created: 0,
      disposed: 0,
      stale: 0,
      request_success: 0,
      request_error: 0,
      request_aborted: 0,
    };
    this.peak = {};
  }
  context(c = {}) {
    return {
      run_id: this.id,
      scene_id: this.config.scene_id,
      res: this.config.res,
      cycle_id: null,
      frame_id: null,
      tile_id: null,
      ...c,
    };
  }
  add(table, r) {
    if (!this.enabled && !['frames', 'samples'].includes(table)) return r;
    if (this.rows >= this.limit) {
      this.dropped++;
      this.status = 'log_limit';
      return r;
    }
    const row = { ...this.context(), ...r };
    this.tables[table].push(row);
    this.rows++;
    return row;
  }
  event(type, c = {}, data = {}) {
    return this.add('events', { ...this.context(c), type, at_ms: this.now(), ...data });
  }
  memory(m) {
    for (const [k, v] of Object.entries(m))
      if (Number.isFinite(v)) this.peak[k] = Math.max(this.peak[k] || 0, v);
  }
  finish(status, t = this.now()) {
    this.end = t;
    if (!this.dropped) this.status = status;
  }
  summary(clock) {
    const end = this.end ?? this.now(),
      f = this.tables.frames,
      r = this.tables.requests,
      p = f.filter((x) => Number.isFinite(x.presented_estimate_at_ms));
    const due = f.filter(
      (x) =>
        Number.isFinite(x.fixed_deadline_at_ms) &&
        x.fixed_deadline_at_ms <= end &&
        !['cancelled_seek', 'cancelled'].includes(x.status),
    );
    const missed = due.filter(
      (x) =>
        !Number.isFinite(x.parsed_ready_at_ms) || x.parsed_ready_at_ms > x.fixed_deadline_at_ms,
    );
    const network = r.filter((x) => x.source === 'network' && x.status === 'success');
    const union = unionMs(network.map((x) => [x.fetch_start_at_ms, x.body_end_at_ms]));
    const sum = (rows, key) => rows.reduce((s, x) => s + (x[key] || 0), 0);
    const active = clock.activeMs(end),
      stall = clock.stallMs(end);
    const intervals = p
      .slice(1)
      .filter((x, i) => x.playback_epoch === p[i].playback_epoch)
      .map((x) => {
        const i = p.indexOf(x);
        return x.presented_estimate_at_ms - p[i - 1].presented_estimate_at_ms;
      });
    return {
      schema: SCHEMA,
      run_id: this.id,
      status: this.status,
      wall_duration_ms: end - this.start,
      complete_presentations: this.count.content,
      time_to_first_visible_content_ms: p.length
        ? p[0].presented_estimate_at_ms - this.start
        : null,
      time_to_first_complete_frame_ms: p.length ? p[0].presented_estimate_at_ms - this.start : null,
      startup_delay_ms: clock.startupEnd === null ? null : clock.startupEnd - this.start,
      active_playback_wall_ms: active,
      content_fps: active > 0 ? (this.count.content * 1000) / active : null,
      raf_hz: end > this.start ? (this.count.raf * 1000) / (end - this.start) : null,
      render_submit_fps: end > this.start ? (this.count.renders * 1000) / (end - this.start) : null,
      buffering_count: clock.stalls.length + (clock.stallStart === null ? 0 : 1),
      buffering_ms: stall,
      stall_ratio: active > 0 ? stall / active : null,
      deadline_readiness_scope:
        'parsed/packed readiness, not GPU completion; presentation lateness separately reported',
      deadline_due_n: due.length,
      deadline_miss_n: missed.length,
      deadline_miss_ratio: due.length ? missed.length / due.length : null,
      presented_after_deadline_n: due.filter(
        (x) =>
          Number.isFinite(x.presented_estimate_at_ms) &&
          x.presented_estimate_at_ms > x.fixed_deadline_at_ms,
      ).length,
      actually_skipped_frames: 0,
      skip_reason: 'hold every occurrence; seek displacement is separate',
      bytes_body_received: this.enabled ? sum(r, 'body_bytes') : null,
      network_classified_body_bytes: this.enabled ? sum(network, 'body_bytes') : null,
      http_cache_body_bytes: this.enabled
        ? sum(
            r.filter((x) => x.source === 'http_cache'),
            'body_bytes',
          )
        : null,
      unknown_source_body_bytes: this.enabled
        ? sum(
            r.filter((x) => x.source === 'unknown'),
            'body_bytes',
          )
        : null,
      app_cache_body_bytes: this.enabled
        ? sum(
            r.filter((x) => x.source?.startsWith('app_')),
            'app_cache_bytes',
          )
        : null,
      resource_transfer_size_sum:
        this.enabled && r.some((x) => Number.isFinite(x.transfer_size))
          ? sum(r, 'transfer_size')
          : null,
      resource_transfer_size_valid_n: r.filter((x) => Number.isFinite(x.transfer_size)).length,
      resource_transfer_size_reason:
        'browser estimate; not exact wire bytes; unavailable entries omitted',
      network_union_active_ms: this.enabled ? union : null,
      network_goodput_bps: union ? (sum(network, 'body_bytes') * 8000) / union : null,
      goodput_reason: union ? null : 'no_valid_network_samples',
      distributions: {
        complete_frame_interval_ms: stats(intervals),
        enqueue_to_present_ms: stats(p.map((x) => x.presented_estimate_at_ms - x.enqueued_at_ms)),
        fetch_ms: stats(r.map((x) => x.fetch_ms)),
        ttfb_ms: stats(r.map((x) => x.ttfb_ms)),
        parse_pack_wall_ms: stats(this.tables.tiles.map((x) => x.parse_pack_wall_ms)),
        update_wall_ms: stats(this.tables.renders.map((x) => x.spark_update_wall_ms)),
        submit_cpu_ms: stats(this.tables.renders.map((x) => x.render_submit_cpu_ms)),
        gpu_draw_ms: stats(this.tables.renders.map((x) => x.gpu_draw_ms)),
        seek_latency_ms: stats(
          this.tables.events.filter((x) => x.type === 'seek-presented').map((x) => x.latency_ms),
        ),
      },
      counters: { ...this.count },
      peak_memory: this.peak,
      instrumentation: {
        enabled: this.enabled,
        retained_rows: this.rows,
        dropped_rows: this.dropped,
        complete_log: !this.dropped,
      },
      unavailable: {
        ply_parse_only_ms: 'fused with pack in stock Spark Worker',
        worker_internal_queue_ms: 'no public pool timestamps',
        worker_transfer_ms: 'no public RPC hook',
        sort_only_ms: 'update combines generation/readback/sort/wait',
        cpu_percent: 'not exposed',
        gpu_percent: 'not exposed',
        total_vram_bytes: 'not exposed',
      },
      presentation_reason:
        'application estimate after awaited update + draw submit; not scanout or motion-to-photon',
    };
  }
}
export function csv(rows) {
  const keys = rows.length
    ? [...new Set(rows.flatMap((x) => Object.keys(x)))]
    : ['run_id', 'cycle_id', 'scene_id', 'res', 'frame_id', 'tile_id'];
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+@]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
  };
  return (
    '\uFEFF' +
    keys.join(',') +
    '\r\n' +
    rows.map((x) => keys.map((k) => cell(x[k])).join(',')).join('\r\n')
  );
}
