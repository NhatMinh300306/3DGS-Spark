import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { SplatMesh, SparkRenderer } from './vendor/spark.module.js';
import { GpuTimer } from './network.js';
import { aborted } from './core.js';
import { sourceBytes } from './engine.js';

export class SparkAdapter {
  constructor(host) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    host.append(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#080d13');
    this.camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.001, 1000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.spark = new SparkRenderer({
      renderer: this.renderer,
      autoUpdate: false,
      enableLod: false,
      minSortIntervalMs: 0,
      sortRadial: true,
    });
    this.scene.add(this.spark);
    this.root = null;
    this.fences = [];
    this.lastMatrix = '';
    this.timer = null;
  }
  begin(config, camera) {
    this.reset();
    this.home = structuredClone(camera);
    this.config = config;
    this.renderer.setPixelRatio(config.pixelRatio);
    this.renderer.setSize(config.width, config.height, false);
    this.camera.aspect = config.width / config.height;
    this.resetCamera();
    this.controls.enabled = config.cameraMode === 'manual';
    this.trace = config.cameraTrace || null;
    this.timer = new GpuTimer(this.renderer.getContext(), config.instrumentation);
  }
  resetCamera() {
    const c = this.home;
    if (!c) return;
    this.camera.position.fromArray(c.position);
    this.controls.target.fromArray(c.target);
    this.camera.up.fromArray(c.up || [0, 1, 0]);
    this.camera.fov = c.fov || 50;
    this.camera.near = c.near || 0.001;
    this.camera.far = c.far || 1000;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }
  applyTrace(ms) {
    if (!this.trace?.length) return;
    let b = this.trace.findIndex((x) => x.at_ms >= ms);
    if (b < 0) b = this.trace.length - 1;
    const a = this.trace[Math.max(0, b - 1)],
      z = this.trace[b];
    const k =
      z.at_ms === a.at_ms ? 0 : Math.max(0, Math.min(1, (ms - a.at_ms) / (z.at_ms - a.at_ms)));
    this.camera.position.fromArray(a.position.map((x, i) => x + (z.position[i] - x) * k));
    this.controls.target.fromArray(a.target.map((x, i) => x + (z.target[i] - x) * k));
    this.controls.update();
  }
  cameraMetadata() {
    return {
      position: this.camera.position.toArray(),
      target: this.controls.target.toArray(),
      up: this.camera.up.toArray(),
      fov: this.camera.fov,
      near: this.camera.near,
      far: this.camera.far,
    };
  }
  metadata() {
    const gl = this.renderer.getContext();
    return {
      spark: '2.3.1',
      three: THREE.REVISION,
      webgl_version: gl.getParameter(gl.VERSION),
      gpu_timer_available: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
      autoUpdate: false,
      enableLod: false,
      antialias: false,
      sortRadial: true,
      background: '#080d13',
      color_space: 'sRGB',
      tone_mapping: 'none',
      worker_timing:
        'stock internal Worker; initialized wall measured; internal queue/parse/pack/transfer split unavailable',
      gpu_memory_scope:
        'source textures estimate; excludes sort/generator/framebuffer/driver allocations',
    };
  }
  async prepare(buffer, file, measureBounds, lifecycle = {}) {
    const start = performance.now();
    let mesh;
    try {
      mesh = new SplatMesh({
        fileBytes: buffer,
        fileName: file.url.split('?')[0].split('/').at(-1),
        lod: false,
        nonLod: true,
        enableLod: false,
      });
      lifecycle.created?.();
      const constructed = performance.now();
      await mesh.initialized;
      const initialized = performance.now();
      let bounds = null;
      if (measureBounds) {
        const t = performance.now();
        mesh.getBoundingBox();
        bounds = performance.now() - t;
      }
      return {
        mesh,
        metrics: {
          prepare_start_at_ms: start,
          initialized_at_ms: initialized,
          constructor_cpu_ms: constructed - start,
          parse_pack_wall_ms: initialized - start,
          parse_pack_reason:
            'constructor + Worker acquisition/copy/parse/pack + initialized wait; not CPU time',
          bounds_cpu_ms: bounds,
          bounds_reason: measureBounds ? null : 'disabled_for_speed_run',
        },
      };
    } catch (e) {
      mesh?.dispose();
      if (mesh) lifecycle.disposed?.();
      throw e;
    }
  }
  group(meshes, rotation) {
    const root = new THREE.Group();
    root.rotation.x = (rotation * Math.PI) / 180;
    root.add(...meshes);
    return root;
  }
  poll() {
    this.timer?.poll();
    const gl = this.renderer.getContext();
    this.fences = this.fences.filter((x) => {
      const result = gl.clientWaitSync(x.sync, 0, 0);
      if (result === gl.TIMEOUT_EXPIRED) return true;
      x.row.gpu_complete_observed_at_ms = result === gl.WAIT_FAILED ? null : performance.now();
      x.row.gpu_complete_reason =
        result === gl.WAIT_FAILED
          ? 'fence_wait_failed'
          : 'fence_polled_after_draw; completion upper bound, not presentation';
      gl.deleteSync(x.sync);
      return false;
    });
  }
  async render(asset, context, rec, tileRows, signal, newFrame) {
    this.poll();
    const row = rec.add('renders', {
      ...rec.context(context),
      at_ms: performance.now(),
      new_content: newFrame,
      spark_update_wall_ms: null,
      spark_update_reason: 'not_required_static_camera',
      render_submit_start_at_ms: null,
      render_submit_cpu_ms: null,
      presented_estimate_at_ms: null,
      gpu_draw_ms: null,
      gpu_draw_reason: 'pending',
    });
    if (this.root !== asset.root) {
      this.root?.removeFromParent();
      this.root = asset.root;
      this.scene.add(this.root);
    }
    if (!asset.uploaded) {
      for (const mesh of asset.meshes) {
        const tr = tileRows.find((t) => t.tile_id === mesh.benchmarkFileId);
        const t = performance.now();
        this.renderer.initTexture(mesh.packedSplats.getTexture());
        if (tr) {
          tr.upload_submit_at_ms = t;
          tr.upload_submit_cpu_ms = performance.now() - t;
          tr.upload_reason =
            'base source texture initTexture only; SH/generation work may occur in update/draw';
        }
      }
      asset.uploaded = true;
    }
    this.camera.updateMatrixWorld();
    const matrix = this.camera.matrixWorld.elements.join(',');
    if (newFrame || matrix !== this.lastMatrix) {
      const t = performance.now();
      await this.spark.update({ scene: this.scene, camera: this.camera });
      row.spark_update_wall_ms = performance.now() - t;
      row.spark_update_reason = 'combined generation/readback/sort/wait; not isolated sort CPU/GPU';
      this.lastMatrix = matrix;
    }
    if (signal.aborted) throw aborted();
    this.timer.begin(row);
    row.render_submit_start_at_ms = performance.now();
    try {
      this.renderer.render(this.scene, this.camera);
    } finally {
      row.render_submit_cpu_ms = performance.now() - row.render_submit_start_at_ms;
      this.timer.end();
    }
    row.presented_estimate_at_ms = performance.now();
    asset.sourceBytes = asset.meshes.reduce((n, m) => n + sourceBytes(m), 0);
    return row;
  }
  trackFence(row) {
    if (this.config.instrumentation === false) {
      row.gpu_complete_reason = 'instrumentation_disabled';
      return;
    }
    const gl = this.renderer.getContext();
    if (this.fences.length >= 16) {
      row.gpu_complete_reason = 'fence_limit';
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) {
      row.gpu_complete_reason = 'fence_creation_failed';
      return;
    }
    gl.flush();
    this.fences.push({ sync, row });
  }
  async capture() {
    return new Promise((resolve, reject) =>
      this.renderer.domElement.toBlob(
        (b) => (b ? resolve(b) : reject(Error('Canvas PNG failed'))),
        'image/png',
      ),
    );
  }
  reset() {
    this.root?.removeFromParent();
    this.root = null;
    this.spark.clearSplats();
    this.lastMatrix = '';
    this.timer?.dispose();
    const gl = this.renderer.getContext();
    for (const f of this.fences) {
      f.row.gpu_complete_reason = 'not_observed_before_cleanup';
      gl.deleteSync(f.sync);
    }
    this.fences = [];
  }
}
