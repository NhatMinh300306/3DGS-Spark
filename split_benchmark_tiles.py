#!/usr/bin/env python3
"""Exact nonoverlapping center ownership on one shared spatial grid. No compression."""
import argparse,json
from pathlib import Path
import numpy as np
from configure_benchmark import collect
from bench_tools.ply_data import read,write

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input',required=True);p.add_argument('--output',required=True);p.add_argument('--grid',default='4,4,4');args=p.parse_args()
    root=Path(args.input).expanduser().resolve();out=Path(args.output).expanduser().resolve()
    if out==root or root in out.parents: p.error('Output must be outside input')
    if out.exists() and any(out.iterdir()):p.error('Output must be empty/new')
    grid=np.array([int(x) for x in args.grid.split(',')])
    if grid.shape!=(3,) or (grid<1).any() or (grid>64).any():p.error('Grid needs three values 1..64')
    found=collect(root)
    if not found:p.error('No recognized res/frame PLY')
    if any(len(v)!=1 for v in found.values()):p.error('Input must have one full PLY per res/frame')
    lo=np.full(3,np.inf);hi=-lo
    for paths in found.values():
        a=read(paths[0]);xyz=np.column_stack([a[n] for n in ('x','y','z')]);lo=np.minimum(lo,xyz.min(0));hi=np.maximum(hi,xyz.max(0))
    step=np.maximum(hi-lo,1e-12)/grid
    for (res,fid),paths in sorted(found.items()):
        a=read(paths[0]);xyz=np.column_stack([a[n] for n in ('x','y','z')]);cell=np.minimum(np.maximum(np.floor((xyz-lo)/step).astype(int),0),grid-1)
        dest=out/f'frame_{fid}'/f'layer_{res[3:]}'/'voxels_new'; meta={}
        for key in np.unique(cell,axis=0):
            mask=np.all(cell==key,axis=1);name='cell_'+'_'.join(map(str,key));write(dest/(name+'.ply'),a[mask]);meta[name]={'leftBottom':(lo+key*step).tolist(),'rightTop':(lo+(key+1)*step).tolist(),'splats':int(mask.sum())}
        (dest/'voxel_new.json').write_text(json.dumps(meta,indent=2))
    print(f'Wrote {len(found)} frames to {out}; one owner per Gaussian; all scalar properties retained.')
if __name__=='__main__':main()
