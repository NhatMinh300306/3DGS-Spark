"""Vertex-only Gaussian PLY I/O. Keep every scalar property, including SH."""
from pathlib import Path
import hashlib
import json
import numpy as np

TYPES = {'char':'i1','int8':'i1','uchar':'u1','uint8':'u1','short':'<i2','int16':'<i2','ushort':'<u2','uint16':'<u2','int':'<i4','int32':'<i4','uint':'<u4','uint32':'<u4','float':'<f4','float32':'<f4','double':'<f8','float64':'<f8'}
NAMES = {'i1':'char','u1':'uchar','i2':'short','u2':'ushort','i4':'int','u4':'uint','f4':'float','f8':'double'}
REQUIRED = ['x','y','z','opacity']+[f'f_dc_{i}' for i in range(3)]+[f'scale_{i}' for i in range(3)]+[f'rot_{i}' for i in range(4)]

def read(path):
    path = Path(path)
    with path.open('rb') as f:
        if f.readline().strip() != b'ply':
            raise ValueError(f'Not PLY: {path}')
        fmt = None; count = None; props = []; element = None
        for _ in range(10000):
            line = f.readline()
            if not line: raise ValueError(f'Truncated PLY header: {path}')
            words = line.decode('ascii').strip().split()
            if not words: continue
            if words[0] == 'end_header': break
            if words[0] == 'format': fmt = words[1]
            elif words[0] == 'element':
                element = words[1]
                if element != 'vertex': raise ValueError(f'Only vertex elements supported: {path}')
                count = int(words[2])
            elif words[0] == 'property':
                if element != 'vertex' or len(words) != 3 or words[1] not in TYPES:
                    raise ValueError(f'Unsupported scalar property: {path}: {words}')
                props.append((words[2], TYPES[words[1]]))
        else: raise ValueError('PLY header too long')
        if count is None or count <= 0 or not props: raise ValueError(f'Empty PLY: {path}')
        if len(set(n for n,_ in props)) != len(props): raise ValueError('Duplicate PLY property')
        dtype = np.dtype(props)
        missing = set(REQUIRED)-set(dtype.names)
        if missing: raise ValueError(f'Missing Gaussian properties in {path}: {sorted(missing)}')
        if fmt == 'binary_little_endian':
            data = f.read()
            if len(data) != count*dtype.itemsize: raise ValueError(f'Truncated/trailing PLY bytes: {path}')
            a = np.frombuffer(data, dtype=dtype).copy()
        elif fmt == 'ascii':
            lines = f.read().decode('ascii').splitlines()
            lines = [x for x in lines if x.strip()]
            if len(lines) != count: raise ValueError(f'Wrong vertex count: {path}')
            a = np.empty(count, dtype=dtype)
            for i,line in enumerate(lines):
                values = line.split()
                if len(values) != len(props): raise ValueError('Wrong ASCII property count')
                a[i] = tuple(values)
        else: raise ValueError(f'Unsupported PLY format {fmt}: {path}')
    for n in dtype.names:
        if not np.isfinite(a[n]).all(): raise ValueError(f'Non-finite PLY property {n}: {path}')
    return a

def write(path, a):
    path=Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    props=[]
    for n in a.dtype.names:
        d=a.dtype[n]
        key=f'{d.kind}{d.itemsize}'
        if key not in NAMES: raise ValueError('Unsupported output scalar')
        props.append(f'property {NAMES[key]} {n}')
    header='\n'.join(['ply','format binary_little_endian 1.0',f'element vertex {len(a)}',*props,'end_header',''])
    little=np.dtype([(n,a.dtype[n].newbyteorder('<')) for n in a.dtype.names])
    with path.open('wb') as f:
        f.write(header.encode('ascii')); f.write(a.astype(little,copy=False).tobytes())

def describe(path, a=None):
    path=Path(path); a=read(path) if a is None else a
    rest=[n for n in a.dtype.names if n.startswith('f_rest_')]
    degree=next((d for d in range(4) if 3*((d+1)**2-1)==len(rest)),None)
    if degree is None: raise ValueError(f'Unsupported/incomplete SH property count in {path}')
    return {'bytes':path.stat().st_size,'splats':len(a),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
      'properties':[[n,a.dtype[n].str] for n in a.dtype.names],'sh_degree':degree,
      'bounds':{'min':[float(a[n].min()) for n in ('x','y','z')],'max':[float(a[n].max()) for n in ('x','y','z')]},
      'bounds_scope':'Gaussian centers; not ellipsoid support'}

def fingerprints(a):
    names=sorted(a.dtype.names)
    canonical=np.empty(len(a),dtype=[(n,a.dtype[n].newbyteorder('<')) for n in names])
    for n in names: canonical[n]=a[n]
    return sorted(hashlib.sha256(row.tobytes()).hexdigest() for row in canonical)

def equivalent(full, tiles):
    if any(set(t.dtype.names)!=set(full.dtype.names) for t in tiles): return False
    if any(any(full.dtype[n].kind!=t.dtype[n].kind or full.dtype[n].itemsize!=t.dtype[n].itemsize for n in full.dtype.names) for t in tiles): return False
    return fingerprints(full)==sorted(h for t in tiles for h in fingerprints(t))
