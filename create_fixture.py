#!/usr/bin/env python3
"""Create a small synthetic SH3 dataset; this is not 8i data or a performance benchmark."""
from pathlib import Path
from tempfile import TemporaryDirectory
import json
import numpy as np
from bench_tools.ply_data import write
from configure_benchmark import main

def create(destination='dist/bench/data/fixture/manifest.json'):
    rng=np.random.default_rng(1203)
    names=['x','y','z','nx','ny','nz']+[f'f_dc_{i}' for i in range(3)]+[f'f_rest_{i}' for i in range(45)]+['opacity']+[f'scale_{i}' for i in range(3)]+[f'rot_{i}' for i in range(4)]
    with TemporaryDirectory() as temp:
        temp=Path(temp)
        for res,count in [(1,96),(2,72),(4,48),(8,24)]:
            phase=np.arange(count)*2*np.pi/count
            base=np.zeros(count,dtype=[(n,'<f4') for n in names])
            base['opacity']=3; base['rot_0']=1
            for k in range(3):base[f'scale_{k}']=-3.2;base[f'f_dc_{k}']=np.sin(phase+k*2.09)*1.0
            for k in range(45):base[f'f_rest_{k}']=rng.normal(0,.02,count)
            for i in range(30):
                a=base.copy();t=i*2*np.pi/30;a['x']=np.cos(phase+t)*.8;a['y']=np.sin(phase*2+t)*.45;a['z']=np.sin(phase+t)*.3
                write(temp/'full'/f'res{res}'/f'{1450+i:06}.ply',a)
                for tile in range(3):write(temp/'tiles'/f'frame_{1450+i}'/f'layer_{res}'/'voxels_new'/f'tile_{tile}.ply',a[tile::3])
        main(['--full-root',str(temp/'full'),'--tiles-root',str(temp/'tiles'),'--tile-dir','voxels_new','--scene-id','fixture','--name','Orbit SH3 — SYNTHETIC','--output',str(destination),'--copy'])
    dest=Path(destination);d=json.loads(dest.read_text());d['fixture']=True;dest.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
if __name__=='__main__':create()
