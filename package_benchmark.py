#!/usr/bin/env python3
"""Package only the Full/Tile benchmark, vendors, fixtures, tests and documentation."""
import argparse,hashlib,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent
TOP=['README.md','METRICS.md','BENCHMARK_PROTOCOL.md','SOURCES-BENCHMARK.md','VALIDATION-BENCHMARK.md','LICENSE','package.json','requirements-benchmark.txt','requirements-quality.txt','configure_benchmark.py','split_benchmark_tiles.py','create_fixture.py','serve_benchmark.py','serve.py','evaluate_captures.py','summarize_benchmarks.py','package_benchmark.py']

def package(destination):
    destination=Path(destination).resolve();destination.parent.mkdir(parents=True,exist_ok=True)
    files=[ROOT/n for n in TOP]+[ROOT/'dist/index.html']
    for folder in ['bench_tools','benchmark-tests','benchmark-validation','dist/bench']:
        files.extend(p for p in (ROOT/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix!='.zip')
    files=sorted(set(files))
    for p in files:
        if not p.is_file():raise FileNotFoundError(p)
        if p.is_symlink():raise ValueError(f'User data symlink not packaged automatically: {p}')
    with zipfile.ZipFile(destination,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for p in files:z.write(p,'Splat-Lab-Benchmark-v12/'+p.relative_to(ROOT).as_posix())
    with zipfile.ZipFile(destination) as z:
        bad=z.testzip()
        if bad:raise ValueError(f'Corrupt ZIP member: {bad}')
    print(f'{destination}\n{destination.stat().st_size} bytes; {len(files)} files\nSHA256 {hashlib.sha256(destination.read_bytes()).hexdigest()}')
    return destination
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--output',default=str(ROOT.parent/'downloads/Splat-Lab-Benchmark-v12.zip'));a=p.parse_args();package(a.output)
