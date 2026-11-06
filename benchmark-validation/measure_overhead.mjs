// Recorder microbenchmark only. Not a Spark, network or rendering benchmark.
import { performance } from 'node:perf_hooks';
import { Recorder, stats } from '../dist/bench/core.js';
const rows = [];
for (let repeat = 0; repeat < 5; repeat++)
  for (const enabled of [true, false]) {
    const rec = new Recorder({ instrumentation: enabled, logLimit: 100000 });
    const start = performance.now();
    for (let i = 0; i < 10000; i++)
      rec.event(
        'tile-ready',
        { frame_id: 1450 + (i % 30), tile_id: String(i % 64) },
        { at_ms: i, bytes: 4096 },
      );
    rows.push({
      repeat,
      instrumentation: enabled,
      events: 10000,
      elapsed_ms: performance.now() - start,
      retained_rows: rec.rows,
    });
  }
console.log(
  JSON.stringify(
    {
      scope:
        'Node Recorder 10000 synthetic events; not browser/Spark/GPU performance and not a playback speedup',
      rows,
      on_ms: stats(rows.filter((x) => x.instrumentation).map((x) => x.elapsed_ms)),
      off_ms: stats(rows.filter((x) => !x.instrumentation).map((x) => x.elapsed_ms)),
    },
    null,
    2,
  ),
);
