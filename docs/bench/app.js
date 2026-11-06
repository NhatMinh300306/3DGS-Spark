import { manifest, MiB, ByteCache, csv } from './core.js';
import { FrameCache, Session } from './engine.js';
import { SparkAdapter } from './renderer.js';
import { zipSync, strToU8 } from './vendor/fflate.module.js';

const $ = (id) => document.getElementById(id);
let adapter, gpuError;
try {
  adapter = new SparkAdapter($('viewport'));
} catch (e) {
  gpuError = e;
}
const byteCache = new ByteCache(128 * MiB),
  frameCache = new FrameCache(512 * MiB);
let catalog,
  scene,
  session = null,
  records = [],
  batchCancel = false,
  batchActive = false,
  capturing = false,
  trace = null,
  lastUI = 0,
  stopping = false;
const note = (text, error = false) => {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
};
const number = (id, min, max) => {
  const n = Number($(id).value);
  if (!Number.isFinite(n) || n < min || n > max) throw Error(`${id}: cần giá trị ${min}..${max}`);
  return n;
};
function config(treatment = $('treatment').value) {
  const c = {
    scene_id: scene.scene_id,
    res: $('res').value,
    treatment,
    fps: number('fps', 1, 120),
    loop: $('loop').checked,
    horizon: number('horizon', 2, 30),
    startupFrames: number('startupFrames', 1, 30),
    requests: number('requests', 1, 16),
    decodes: number('decodes', 1, 4),
    frameConcurrency: 2,
    rawBytes: number('rawMiB', 4, 4096) * MiB,
    parsedBytes: number('parsedMiB', 4, 8192) * MiB,
    byteCacheBytes: number('cacheMiB', 0, 4096) * MiB,
    cacheMode: $('cacheMode').value,
    instrumentation: $('instrumentation').checked,
    measureBounds: $('measureBounds').checked,
    width: number('width', 320, 3840),
    height: number('height', 240, 2160),
    pixelRatio: number('pixelRatio', 0.5, 2),
    logLimit: number('logLimit', 1000, 100000),
    maxRunMs: number('maxSeconds', 10, 3600) * 1000,
    timeoutMs: 30000,
    cameraMode: $('cameraMode').value,
    cameraTrace: trace,
    network_note: $('networkNote').value,
    camera_configuration: structuredClone(scene.camera),
    allow_unverified: $('unverified').checked,
    policy: 'complete-only-hold',
  };
  if (c.startupFrames > c.horizon) throw Error('Startup phải nhỏ hơn hoặc bằng prefetch');
  if (c.cameraMode === 'trace' && !trace) throw Error('Hãy tạo hoặc nhập camera trace');
  if (c.cameraMode !== 'trace') c.cameraTrace = null;
  const q = scene.qualities.find((q) => q.id === c.res);
  if (!q?.frames.every((f) => f[treatment]?.length))
    throw Error('Scene chưa có đủ dữ liệu cho phương án đã chọn');
  if (
    q.frames.some((f) => f.equivalence !== 'verified_exact_scalar_multiset') &&
    !c.allow_unverified
  )
    throw Error(
      'Cần cấu hình cả Full và Tile để đối chiếu. Chỉ cho phép unverified cho kiểm tra riêng.',
    );
  return c;
}
function controls(running) {
  $('configuration').disabled = running;
  $('start').disabled = running || !!gpuError;
  $('batch').disabled = running || !!gpuError;
  $('capture').disabled = running || !!gpuError;
  $('stop').disabled = !running;
  $('pause').disabled = !running;
  $('timeline').disabled = !running;
  $('clear').disabled = running;
  $('export').disabled = running || !records.length;
}
async function loadScene() {
  if (session) return;
  try {
    const entry = catalog.scenes.find((s) => s.id === $('scene').value);
    const url = new URL(entry.url, new URL('./catalog.json', location.href));
    const raw = await fetch(url, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw Error('HTTP ' + r.status);
      return r.json();
    });
    scene = manifest(raw, url);
    $('res').innerHTML = scene.qualities
      .map((q) => `<option value="${q.id}">${q.id}</option>`)
      .join('');
    $('res').value = scene.qualities.some((q) => q.id === 'res8') ? 'res8' : scene.qualities[0].id;
    $('timeline').max = scene.qualities[0].frames.length - 1;
    note(
      `${scene.name} · ${scene.qualities[0].frames.length} frame${scene.fixture ? ' · dữ liệu SYNTHETIC, không phải 8i' : ''}${gpuError ? ' · WebGL2 chưa khả dụng: ' + gpuError.message : ''}`,
      !!gpuError,
    );
  } catch (e) {
    note(e.message, true);
  }
}
function download(name, blob) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function jsonDownload(name, obj) {
  download(name, new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
}
async function start(overrides = {}) {
  if (session || stopping) throw Error('Run cũ chưa kết thúc');
  if (gpuError) throw gpuError;
  if (records.reduce((n, r) => n + r.rec.rows, 0) > 250000)
    throw Error('Hãy xuất rồi xóa kết quả trước khi chạy thêm để giới hạn RAM log');
  const c = { ...config(overrides.treatment), ...overrides };
  if (!['app-bytes', 'app-processed'].includes(c.cacheMode)) byteCache.clear();
  if (c.cacheMode !== 'app-processed') frameCache.clear();
  adapter.begin(c, scene.camera);
  let resolveDone;
  const done = new Promise((resolve) => (resolveDone = resolve));
  const s = new Session({ manifest: scene, config: c, adapter, byteCache, frameCache });
  s.resolveDone = resolveDone;
  s.done = done;
  s.metadata = {
    schema: 'splat-benchmark-v1',
    run_id: s.rec.id,
    created_at: new Date().toISOString(),
    performance_time_origin_ms: performance.timeOrigin,
    config: c,
    manifest_scene: scene.scene_id,
    fixture: !!scene.fixture,
    dataset_assets: scene.qualities.map((q) => ({
      res: q.id,
      frames: q.frames.map((f) => ({
        id: f.id,
        full: f.full?.map((a) => ({ sha256: a.sha256, bytes: a.bytes, splats: a.splats })),
        tiles: f.tiles?.map((a) => ({ sha256: a.sha256, bytes: a.bytes, splats: a.splats })),
      })),
    })),
    equivalence: scene.qualities
      .find((q) => q.id === c.res)
      .frames.map((f) => ({ frame_id: f.id, status: f.equivalence })),
    renderer: adapter.metadata(),
    camera: adapter.cameraMetadata(),
    viewport: {
      css_width: c.width,
      css_height: c.height,
      pixel_ratio: c.pixelRatio,
      physical_width: adapter.renderer.domElement.width,
      physical_height: adapter.renderer.domElement.height,
    },
    browser: {
      user_agent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory ?? null,
    },
    initial_cache: { byte_bytes: byteCache.bytes, prepared_reserved_bytes: frameCache.used },
    limitations: [
      'No exact scanout timestamp',
      'No CPU/GPU utilization percentage',
      'No total VRAM measurement',
      'Stock Spark internal Worker parse/pack/transfer split unavailable',
      'No claim of 30 content FPS on real data',
    ],
  };
  session = s;
  controls(true);
  note(`Run ${s.rec.id.slice(0, 8)} · đang chuẩn bị frame đầu…`);
  return s;
}
async function finish(status) {
  if (!session || stopping) return;
  stopping = true;
  const s = session;
  const failure = s.error
    ? {
        name: s.error.name || 'Error',
        message: String(s.error.message || s.error),
        stack: s.error.stack || null,
      }
    : null;
  if (failure) {
    s.metadata.failure = failure;
    s.rec.event('run-error', {}, failure);
    console.error('Splat Lab run failed', s.error);
  }
  try {
    const summary = await s.stop(status);
    summary.error = failure;
    records.push({ rec: s.rec, metadata: s.metadata, summary });
    const item = document.createElement('div');
    item.textContent = `${records.length}. ${s.config.treatment} / ${s.config.res} · ${summary.content_fps?.toFixed(2) ?? '—'} content FPS · ${status}`;
    $('history').prepend(item);
    note(
      `${failure ? failure.message + ' · ' : ''}${status} · ${summary.complete_presentations} frame nội dung · ${summary.buffering_ms.toFixed(0)} ms buffering${scene.fixture ? ' · fixture tổng hợp' : ''}`,
      !['completed', 'stopped'].includes(status),
    );
    session = null;
    s.resolveDone(summary);
  } finally {
    stopping = false;
    controls(false);
  }
}
function drawChart(canvas, series, title, unit, maxMin = 1) {
  const ctx = canvas.getContext('2d'),
    w = canvas.width,
    h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.font = '17px system-ui';
  ctx.fillStyle = '#92a6bb';
  ctx.fillText(title, 12, 22);
  const max = Math.max(maxMin, ...series.flatMap((s) => s.values).filter(Number.isFinite));
  ctx.font = '14px system-ui';
  ctx.fillText(`${max.toFixed(1)} ${unit}`, 12, 43);
  ctx.strokeStyle = '#243448';
  ctx.beginPath();
  ctx.moveTo(8, h - 13);
  ctx.lineTo(w - 8, h - 13);
  ctx.stroke();
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.values.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const x = 10 + (i * (w - 20)) / Math.max(1, s.values.length - 1),
        y = h - 15 - ((h - 65) * v) / max;
      if (!i) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}
function updateUI() {
  const s = session;
  const record = s ? { rec: s.rec, summary: s.rec.summary(s.clock) } : records.at(-1);
  if (!record) return;
  const r = record.rec,
    z = record.summary,
    fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  $('state').textContent = s?.clock.state || z.status;
  const latest = r.tables.samples.at(-1);
  const values = [
    ['Content FPS', fmt(latest?.content_fps)],
    ['Render submit/s', fmt(latest?.render_submit_fps)],
    ['rAF/s', fmt(latest?.raf_hz)],
    ['Buffer parsed', `${latest?.buffer_ready_frames ?? 0} fr`],
    ['Body nhận', `${fmt(z.bytes_body_received / MiB, 2)} MiB`],
    ['Buffering', `${fmt(z.buffering_ms, 0)} ms`],
    ['First complete', `${fmt(z.time_to_first_complete_frame_ms, 0)} ms`],
    ['Parsed/source', `${fmt(latest?.parsed_source_arraybuffer_bytes / MiB, 1)} MiB`],
    ['GPU source ≈', `${fmt(latest?.gpu_source_estimate_bytes / MiB, 1)} MiB`],
  ];
  $('metrics').replaceChildren(
    ...values.map(([label, value]) => {
      const e = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = value;
      const t = document.createElement('span');
      t.textContent = label;
      e.append(b, t);
      return e;
    }),
  );
  const samples = r.tables.samples.slice(-100);
  drawChart(
    $('fpsChart'),
    [
      { values: samples.map((x) => x.raf_hz), color: '#8d98a8' },
      { values: samples.map((x) => x.render_submit_fps), color: '#7eb9ff' },
      { values: samples.map((x) => x.content_fps), color: '#8fe6bd' },
    ],
    'Nhịp hiển thị',
    '/s',
    30,
  );
  drawChart(
    $('bufferChart'),
    [{ values: samples.map((x) => x.buffer_ready_frames), color: '#8fe6bd' }],
    'Frame đã parse/pack (chưa gọi là GPU-ready)',
    'fr',
    2,
  );
  const network = samples.map((x, i) =>
    i
      ? Math.max(
          0,
          ((x.bytes_body_cumulative - samples[i - 1].bytes_body_cumulative) * 8) /
            (x.at_ms - samples[i - 1].at_ms) /
            1000,
        )
      : 0,
  );
  drawChart(
    $('networkChart'),
    [{ values: network, color: '#7eb9ff' }],
    'Tốc độ nhận body (gồm cache/unknown)',
    'Mbps',
    1,
  );
  if (s?.current) {
    $('frameLabel').textContent = s.current.frame.id;
    $('timeline').value = s.frames.findIndex((f) => f.id === s.current.frame.id);
  }
}
function animation(t) {
  requestAnimationFrame(animation);
  if (session && !capturing && !stopping) {
    if (session.config.cameraMode === 'trace' && !session.busy)
      adapter.applyTrace(Math.max(0, t - (session.clock.startupEnd ?? t)));
    session.tick(t);
    if (session.error) {
      note(session.error.message, true);
      finish('error');
    } else if (session.ended) finish('completed');
  }
  if (t - lastUI > 500) {
    lastUI = t;
    updateUI();
  }
}
function fieldStatus() {
  return {
    timestamps:
      'performance.now milliseconds, same main-thread origin; Worker internal timestamps not available',
    presented: 'application estimate after update and draw submission, not scanout',
    null_fields: {
      worker_internal_queue_ms: 'stock Worker pool hook unavailable',
      ply_parse_only_ms: 'fused with packing',
      pack_only_ms: 'fused with parsing',
      worker_transfer_ms: 'no public RPC hook',
      gpu_draw_ms: 'extension unavailable/disjoint/pending/disabled when null',
      gpu_ready_at_ms: 'not inferred from initialized/upload submission',
      cpu_percent: 'not exposed',
      gpu_percent: 'not exposed',
      total_vram_bytes: 'not exposed',
    },
    memory:
      'owned buffers observed; GPU source textures conservatively estimated; excludes renderer internals',
    off: 'instrumentation=false retains only frame/sample tables; detailed counters unavailable',
  };
}
function exportResults() {
  if (session || stopping) return;
  const files = {};
  for (const result of records) {
    const p = result.rec.id + '/';
    files[p + 'metadata.json'] = strToU8(JSON.stringify(result.metadata, null, 2));
    files[p + 'summary.json'] = strToU8(JSON.stringify(result.summary, null, 2));
    files[p + 'field_status.json'] = strToU8(JSON.stringify(fieldStatus(), null, 2));
    for (const table of ['requests', 'frames', 'tiles', 'samples', 'renders'])
      files[p + table + '.csv'] = strToU8(csv(result.rec.tables[table]));
    files[p + 'events.jsonl'] = strToU8(
      result.rec.tables.events.map((x) => JSON.stringify(x)).join('\n'),
    );
  }
  files['README.txt'] = strToU8(
    'Each folder is an independent run. See metadata/config, summary, field_status and the source METRICS.md. Fixture runs do not establish real redandblack performance.',
  );
  download(
    `splat-benchmark-${Date.now()}.zip`,
    new Blob([zipSync(files, { level: 3 })], { type: 'application/zip' }),
  );
}
async function batch() {
  if (batchActive) return;
  if ($('cameraMode').value === 'manual') {
    note('Batch baseline cần camera fixed hoặc trace đã lưu.', true);
    return;
  }
  batchActive = true;
  batchCancel = false;
  const id = crypto.randomUUID();
  try {
    for (let i = 0; i < 5 && !batchCancel; i++)
      for (const treatment of i % 2 ? ['tiles', 'full'] : ['full', 'tiles']) {
        if (batchCancel) break;
        const s = await start({
          treatment,
          loop: false,
          batch_id: id,
          repeat_index: i,
          purpose: 'speed',
        });
        const result = await s.done;
        if (result.status !== 'completed') batchCancel = true;
      }
  } catch (e) {
    note(e.message, true);
  } finally {
    batchActive = false;
    controls(!!session);
  }
}
async function captureSequence() {
  if (session || capturing) return;
  capturing = true;
  const output = {};
  const captures = [];
  let s;
  try {
    s = await start({
      loop: false,
      instrumentation: false,
      fps: 30,
      horizon: 2,
      startupFrames: 1,
      purpose: 'quality_capture',
      cameraMode: 'fixed',
      cameraTrace: null,
    });
    let previous = 0;
    while (session === s && !s.ended && !s.error) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      s.tick(performance.now());
      if (s.renderPromise) await s.renderPromise;
      if (s.rec.count.content > previous) {
        previous = s.rec.count.content;
        const blob = await adapter.capture();
        const filename = `frame_${s.current.frame.id}.png`;
        output[filename] = new Uint8Array(await blob.arrayBuffer());
        captures.push({
          file: filename,
          frame_id: s.current.frame.id,
          res: s.config.res,
          treatment: s.config.treatment,
          camera: adapter.cameraMetadata(),
          width: adapter.renderer.domElement.width,
          height: adapter.renderer.domElement.height,
          background: '#080d13',
          color_space: 'sRGB',
          tone_mapping: 'none',
        });
      }
    }
    if (s.error) throw s.error;
    await s.stop('quality_capture');
    session = null;
    s.resolveDone({ status: 'quality_capture' });
    output['captures.json'] = strToU8(
      JSON.stringify(
        {
          schema: 'splat-captures-v1',
          fixture: !!scene.fixture,
          scene_id: scene.scene_id,
          reference_semantics: 'Full PLY is equivalence reference, not ground truth',
          captures,
        },
        null,
        2,
      ),
    );
    download(
      `captures-${s.config.treatment}-${s.config.res}.zip`,
      new Blob([zipSync(output, { level: 1 })], { type: 'application/zip' }),
    );
    note('Đã xuất PNG riêng. Không có số đo tốc độ từ capture run trong kết quả benchmark.');
  } catch (e) {
    if (s) await s.stop('error');
    session = null;
    note(e.message, true);
  } finally {
    capturing = false;
    controls(false);
  }
}
$('start').onclick = () => start({ purpose: 'speed' }).catch((e) => note(e.message, true));
$('stop').onclick = () => {
  batchCancel = true;
  finish('stopped');
};
$('batch').onclick = batch;
$('export').onclick = exportResults;
$('capture').onclick = captureSequence;
$('pause').onclick = () => {
  if (!session) return;
  if (session.clock.state === 'paused') {
    session.resume();
    $('pause').textContent = 'Ⅱ';
  } else {
    session.pause();
    $('pause').textContent = '▶';
  }
};
$('timeline').onchange = () =>
  session?.seek(Number($('timeline').value)).catch((e) => note(e.message, true));
$('resetCamera').onclick = () => adapter?.resetCamera();
$('statsToggle').onclick = () => $('statsPanel').classList.toggle('hidden');
$('toggle').onclick = () => {
  $('panel').classList.toggle('hidden');
  document.body.classList.toggle('panelHidden');
};
$('scene').onchange = loadScene;
$('clear').onclick = () => {
  if (session) return;
  records = [];
  $('history').replaceChildren();
  $('export').disabled = true;
  byteCache.clear();
  frameCache.clear();
  note('Đã xóa kết quả và cache ứng dụng. HTTP cache trình duyệt không được xóa bởi nút này.');
};
$('saveCamera').onclick = () => {
  if (adapter?.home) jsonDownload('camera.json', adapter.cameraMetadata());
  else if (scene) jsonDownload('camera.json', scene.camera);
};
$('traceExample').onclick = () => {
  if (!scene) return;
  const c = scene.camera;
  const dx = c.position[0] - c.target[0],
    dz = c.position[2] - c.target[2];
  trace = Array.from({ length: 121 }, (_, i) => {
    const a = (i / 120) * Math.PI * 2;
    return {
      at_ms: i * 250,
      position: [
        c.target[0] + dx * Math.cos(a) + dz * Math.sin(a),
        c.position[1],
        c.target[2] - dx * Math.sin(a) + dz * Math.cos(a),
      ],
      target: [...c.target],
    };
  });
  $('cameraMode').value = 'trace';
  jsonDownload('camera-trace.json', trace);
};
$('traceFile').onchange = async () => {
  try {
    const v = JSON.parse(await $('traceFile').files[0].text());
    if (
      !Array.isArray(v) ||
      v.length < 2 ||
      v.some(
        (x, i) =>
          !Number.isFinite(x.at_ms) ||
          x.at_ms < 0 ||
          (i && x.at_ms <= v[i - 1].at_ms) ||
          !['position', 'target'].every(
            (k) => Array.isArray(x[k]) && x[k].length === 3 && x[k].every(Number.isFinite),
          ),
      )
    )
      throw Error('Trace không hợp lệ');
    trace = v;
    $('cameraMode').value = 'trace';
    note(`Đã nhập ${v.length} camera keyframe`);
  } catch (e) {
    note(e.message, true);
  }
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden && session && !capturing) {
    batchCancel = true;
    finish('invalid_visibility');
  }
});
fetch('./catalog.json', { cache: 'no-cache' })
  .then((r) => {
    if (!r.ok) throw Error('catalog.json HTTP ' + r.status);
    return r.json();
  })
  .then(async (c) => {
    catalog = c;
    for (const s of c.scenes) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name;
      $('scene').append(o);
    }
    $('scene').value = c.default || c.scenes[0]?.id;
    await loadScene();
    controls(false);
  })
  .catch((e) => note(e.message, true));
requestAnimationFrame(animation);
