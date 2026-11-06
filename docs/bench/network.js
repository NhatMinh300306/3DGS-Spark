import { Gate, aborted, classify } from './core.js';

export class AssetNetwork {
  constructor({
    recorder,
    concurrency,
    rawBudget,
    byteCache,
    cacheMode,
    timeoutMs = 30000,
    fetcher = fetch,
    perf = performance,
  }) {
    Object.assign(this, { recorder, byteCache, cacheMode, timeoutMs, fetcher, perf });
    // Browser-native fetch requires the Window/global receiver, not AssetNetwork.
    this.fetcher = fetcher.bind(globalThis);
    this.slots = new Gate(concurrency);
    this.raw = new Gate(rawBudget);
    this.activeBuffers = new Set();
    this.loads = new Map();
    this.fetches = new Map();
  }
  async load(file, context, signal) {
    const r = this.recorder,
      now = () => r.now(),
      queued = now();
    const n = this.loads.get(file.url) || 0;
    this.loads.set(file.url, n + 1);
    const row = r.add('requests', {
      ...r.context(context),
      request_id: globalThis.crypto?.randomUUID?.() || Math.random().toString(36),
      url: file.url,
      expected_bytes: file.bytes,
      url_load_index: n,
      reload_index: null,
      retry_index: 0,
      status: 'queued',
      source: 'unknown',
      source_reason: 'not_completed',
      queued_at_ms: queued,
      fetch_start_at_ms: null,
      headers_at_ms: null,
      body_end_at_ms: null,
      fetch_ms: null,
      app_queue_ms: null,
      ttfb_ms: null,
      ttfb_reason: 'not_observed',
      body_bytes: 0,
      app_cache_bytes: 0,
      transfer_size: null,
      encoded_body_size: null,
      decoded_body_size: null,
      body_buckets: [],
      error: null,
    });
    const cached =
      ['app-bytes', 'app-processed'].includes(this.cacheMode) && this.byteCache.get(file.url);
    if (cached) {
      row.source = 'app_byte_cache';
      row.source_reason = 'application_owned_ArrayBuffer';
      row.app_cache_bytes = cached.byteLength;
      row.status = 'success';
      r.count.request_success++;
      return { buffer: cached, row, release: () => {} };
    }
    let freeRaw, freeSlot, buffer, controller, timer;
    try {
      // Body storage + conservative reservation for Spark's internal fileBytes.slice copy.
      freeRaw = await this.raw.acquire(file.bytes * 2, signal);
      freeSlot = await this.slots.acquire(1, signal);
      if (signal?.aborted) throw aborted();
      controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const cleanup = () => signal?.removeEventListener('abort', abort);
      controller.cleanup = cleanup;
      timer = setTimeout(() => controller.abort('timeout'), this.timeoutMs);
      row.fetch_start_at_ms = now();
      row.app_queue_ms = row.fetch_start_at_ms - queued;
      row.status = 'fetching';
      row.reload_index = this.fetches.get(file.url) || 0;
      this.fetches.set(file.url, row.reload_index + 1);
      const response = await this.fetcher(file.url, {
        signal: controller.signal,
        cache: this.cacheMode === 'bypass' ? 'no-store' : 'default',
      });
      row.headers_at_ms = now();
      row.http_status = response.status;
      if (!response.ok) throw Error(`HTTP ${response.status}: ${file.url}`);
      buffer = new ArrayBuffer(file.bytes);
      this.activeBuffers.add(buffer);
      const view = new Uint8Array(buffer);
      let offset = 0;
      const append = (chunk) => {
        row.body_bytes += chunk.byteLength;
        const bucket = Math.floor((now() - r.start) / 100);
        const prev = row.body_buckets.at(-1);
        if (prev?.[0] === bucket) prev[1] += chunk.byteLength;
        else row.body_buckets.push([bucket, chunk.byteLength]);
        if (offset + chunk.byteLength > file.bytes)
          throw Error('Body exceeds manifest size; regenerate manifest');
        view.set(chunk, offset);
        offset += chunk.byteLength;
      };
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            append(value);
          }
        } catch (e) {
          await reader.cancel().catch(() => {});
          throw e;
        }
      } else append(new Uint8Array(await response.arrayBuffer()));
      row.body_end_at_ms = now();
      row.fetch_ms = row.body_end_at_ms - row.fetch_start_at_ms;
      row.body_receive_wall_ms = row.body_end_at_ms - row.headers_at_ms;
      if (offset !== file.bytes)
        throw Error(`Manifest/body size mismatch: expected ${file.bytes}, got ${offset}`);
      const entries = this.perf.getEntriesByName?.(file.url, 'resource') || [];
      const entry = entries
        .filter((x) => x.startTime >= row.fetch_start_at_ms - 1 && x.responseEnd > 0)
        .at(-1);
      const origin = globalThis.location?.origin || new URL(file.url).origin;
      Object.assign(row, classify(entry, new URL(file.url).origin === origin));
      if (entry) {
        row.transfer_size = entry.transferSize;
        row.encoded_body_size = entry.encodedBodySize;
        row.decoded_body_size = entry.decodedBodySize;
        if (entry.requestStart > 0 && entry.responseStart >= entry.requestStart) {
          row.ttfb_ms = entry.responseStart - entry.requestStart;
          row.ttfb_reason = null;
        }
      }
      row.status = 'success';
      r.count.request_success++;
      if (['app-bytes', 'app-processed'].includes(this.cacheMode))
        this.byteCache.put(file.url, buffer);
      let released = false;
      return {
        buffer,
        row,
        release: () => {
          if (released) return;
          released = true;
          this.activeBuffers.delete(buffer);
          freeRaw?.();
        },
      };
    } catch (e) {
      row.status = signal?.aborted || controller?.signal.aborted ? 'aborted' : 'error';
      row.error = String(e.message || e);
      row.source_reason = 'incomplete_or_failed_request';
      row.body_end_at_ms ??= now();
      if (row.fetch_start_at_ms !== null) row.fetch_ms = row.body_end_at_ms - row.fetch_start_at_ms;
      r.count[row.status === 'aborted' ? 'request_aborted' : 'request_error']++;
      if (buffer) this.activeBuffers.delete(buffer);
      freeRaw?.();
      throw e;
    } finally {
      clearTimeout(timer);
      controller?.cleanup?.();
      freeSlot?.();
    }
  }
}

export class GpuTimer {
  constructor(gl, enabled = true) {
    this.gl = gl;
    this.ext = enabled ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
    this.pending = [];
    this.current = null;
    this.reason = enabled ? 'extension_unavailable' : 'instrumentation_disabled';
  }
  begin(row) {
    row.gpu_draw_ms = null;
    row.gpu_draw_reason = this.reason;
    if (!this.ext) return;
    if (this.current || this.pending.length >= 16) {
      row.gpu_draw_reason = 'query_limit';
      return;
    }
    const q = this.gl.createQuery();
    if (!q) {
      row.gpu_draw_reason = 'query_creation_failed';
      return;
    }
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.current = { q, row };
    row.gpu_draw_reason = 'pending';
  }
  end() {
    if (this.current) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.pending.push(this.current);
      this.current = null;
    }
  }
  poll() {
    if (!this.ext) return;
    const gl = this.gl;
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      for (const x of this.pending) {
        x.row.gpu_draw_ms = null;
        x.row.gpu_draw_reason = 'disjoint';
        gl.deleteQuery(x.q);
      }
      this.pending = [];
      return;
    }
    this.pending = this.pending.filter((x) => {
      if (!gl.getQueryParameter(x.q, gl.QUERY_RESULT_AVAILABLE)) return true;
      x.row.gpu_draw_ms = gl.getQueryParameter(x.q, gl.QUERY_RESULT) / 1e6;
      x.row.gpu_draw_reason = null;
      gl.deleteQuery(x.q);
      return false;
    });
  }
  dispose() {
    this.end();
    for (const x of this.pending) {
      x.row.gpu_draw_ms = null;
      x.row.gpu_draw_reason = 'not_observed_before_cleanup';
      this.gl.deleteQuery(x.q);
    }
    this.pending = [];
  }
}
