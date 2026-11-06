#!/usr/bin/env python3
"""Discover real exports, validate PLY, and build the Full/Tile benchmark manifest."""
import argparse
import json
import math
import re
import shutil
from pathlib import Path
from urllib.parse import quote, unquote, urlparse
import numpy as np
from bench_tools.ply_data import read, describe, equivalent

SCHEMA='splat-benchmark-v1'

def identify(path, root):
    parts=path.relative_to(root).parts
    res=None; frame=None
    for part in (root.name, *parts[:-1]):
        m=re.search(r'(?:^|[_-])res([1248])(?:[_-]|$)',part) or re.fullmatch(r'layer_([1248])',part)
        if m: res='res'+m.group(1)
        m=re.fullmatch(r'(?:frame_|dynamic_|f)?(\d{4,6})',part)
        if m: frame=int(m.group(1))
    if frame is None and re.fullmatch(r'\d{4,6}',path.stem): frame=int(path.stem)
    return res,frame

def collect(root, tile_dir=None):
    root=Path(root).expanduser().resolve()
    if not root.is_dir(): raise ValueError(f'Input directory not found: {root}')
    out={}
    for p in sorted(root.rglob('*.ply')):
        rel=p.relative_to(root)
        if tile_dir and tile_dir not in rel.parts[:-1]: continue
        if any(x.startswith('iteration_') and x!='iteration_30000' for x in rel.parts): continue
        if p.name.endswith(('.drcdecode.ply','.drcsource.ply')): continue
        res,frame=identify(p,root)
        if res and frame is not None: out.setdefault((res,frame),[]).append(p)
    return out

def original_asset(output, asset):
    url=urlparse(asset['url'])
    if url.scheme: raise ValueError('Cannot verify remote existing assets; configure both local roots together')
    return (output.parent/unquote(url.path)).resolve()

def main(argv=None):
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--full-root'); ap.add_argument('--tiles-root'); ap.add_argument('--tile-dir')
    ap.add_argument('--res',default='res1,res2,res4,res8'); ap.add_argument('--start',type=int,default=1450); ap.add_argument('--end',type=int,default=1479)
    ap.add_argument('--scene-id',default='redandblack'); ap.add_argument('--name',default='Redandblack — 8i')
    ap.add_argument('--output',default='dist/bench/data/redandblack/manifest.json'); ap.add_argument('--camera',help='JSON file with position/target/FOV'); ap.add_argument('--rotation',type=float,default=0)
    ap.add_argument('--skip-equivalence',action='store_true',help='Mark unverified; not eligible for a baseline comparison')
    g=ap.add_mutually_exclusive_group(required=True); g.add_argument('--copy',action='store_true'); g.add_argument('--link',action='store_true')
    args=ap.parse_args(argv)
    try:
        if not args.full_root and not args.tiles_root: raise ValueError('Supply --full-root or --tiles-root')
        qualities=args.res.split(',')
        if len(set(qualities))!=len(qualities) or any(q not in ['res1','res2','res4','res8'] for q in qualities): raise ValueError('Invalid --res')
        if args.end<args.start: raise ValueError('--end must be >= --start')
        output=Path(args.output).resolve(); output.parent.mkdir(parents=True,exist_ok=True)
        old=json.loads(output.read_text(encoding='utf-8')) if output.exists() else {}
        if old and old.get('scene_id')!=args.scene_id: raise ValueError('Existing manifest has another scene_id')
        maps={}
        for t,root in [('full',args.full_root),('tiles',args.tiles_root)]:
            if root: maps[t]=collect(root,args.tile_dir if t=='tiles' else None)
        oldframes={(q['id'],f['id']):f for q in old.get('qualities',[]) for f in q['frames']}
        rows=[]; allbounds=[]; pairs=0; network_bytes={'full':0,'tiles':0}
        for q in qualities:
            frames=[]
            for fid in range(args.start,args.end+1):
                f={'id':fid}; arrays={}
                for t in ['full','tiles']:
                    if t in maps:
                        paths=maps[t].get((q,fid),[])
                        if not paths: raise ValueError(f'No {t} PLY: {q}, frame {fid}; inspect root/res/frame names and --tile-dir')
                        if t=='full' and len(paths)!=1: raise ValueError(f'{q}/{fid}: {len(paths)} full candidates; select an unambiguous export root')
                        if t=='tiles' and len({p.parent for p in paths})>1: raise ValueError(f'{q}/{fid}: multiple tile directories; use --tile-dir to choose one')
                        assets=[]; aa=[]
                        for i,p in enumerate(paths):
                            a=read(p); info=describe(p,a); aa.append(a)
                            target=output.parent/'files'/t/q/str(fid)/f'{i:04d}-{p.name}'
                            target.parent.mkdir(parents=True,exist_ok=True)
                            if target.is_symlink():
                                if target.resolve()!=p: raise ValueError(f'Existing link points elsewhere: {target}; use a new output directory')
                            elif target.exists() and args.link:
                                if target.resolve()!=p: raise ValueError(f'Existing regular file: {target}; remove it or use --copy')
                            elif args.link: target.symlink_to(p)
                            if args.copy and target.resolve()!=p: shutil.copy2(p,target)
                            assets.append({'id':str(i),'url':quote(target.relative_to(output.parent).as_posix(),safe='/')+'?v='+info['sha256'][:16],**info})
                        f[t]=assets; arrays[t]=aa
                        if t=='tiles':
                            for meta_name in ['voxel_new.json','manifest.json','metadata.json']:
                                meta_path=paths[0].parent/meta_name
                                if meta_path.is_file():
                                    try: f.setdefault('source_tile_metadata',{})[meta_name]=json.loads(meta_path.read_text(encoding='utf-8'))
                                    except (ValueError,UnicodeError): raise ValueError(f'Cannot read tile JSON: {meta_path}')
                    elif t in oldframes.get((q,fid),{}):
                        f[t]=oldframes[(q,fid)][t]
                        if t=='tiles' and oldframes[(q,fid)].get('source_tile_metadata'): f['source_tile_metadata']=oldframes[(q,fid)]['source_tile_metadata']
                        arrays[t]=[read(original_asset(output,a)) for a in f[t]]
                    if t in f:
                        network_bytes[t]+=sum(a['bytes'] for a in f[t])
                        allbounds.extend(a['bounds'] for a in f[t])
                if 'full' in f and 'tiles' in f and not args.skip_equivalence:
                    ok=equivalent(arrays['full'][0],arrays['tiles'])
                    if not ok: raise ValueError(f'Gaussian multiset mismatch: {q}/{fid}; tile duplication, missing vertices or altered attributes. Baseline refused.')
                    f['equivalence']='verified_exact_scalar_multiset'; pairs+=1
                else: f['equivalence']='unverified'
                frames.append(f)
            rows.append({'id':q,'training_image_size':1024//int(q[3:]),'frames':frames})
        camera=json.loads(Path(args.camera).read_text()) if args.camera else old.get('camera')
        if camera is None:
            lo=np.min([b['min'] for b in allbounds],axis=0); hi=np.max([b['max'] for b in allbounds],axis=0)
            center=(lo+hi)/2; radius=max(float(np.linalg.norm(hi-lo))/2,0.01)
            theta=math.radians(args.rotation); x,y,z=center; center=np.array([x,math.cos(theta)*y-math.sin(theta)*z,math.sin(theta)*y+math.cos(theta)*z])
            camera={'position':(center+np.array([0,0,3.1*radius])).tolist(),'target':center.tolist(),'fov':50,'near':max(radius/1000,0.001),'far':max(radius*100,100),'up':[0,1,0]}
        doc={'schema':SCHEMA,'scene_id':args.scene_id,'name':args.name,'fps':30,'fixture':False,'rotation_x_degrees':args.rotation,'camera':camera,'qualities':rows,'quality_semantics':'Alternative training resolutions; never additive','tile_bounds_scope':'centers; no frustum exclusion in baseline','preparation':{'equivalence_verified_pairs':pairs,'source_bytes':network_bytes}}
        output.write_text(json.dumps(doc,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        bench=output.parents[2] if output.parent.parent.name=='data' else Path('dist/bench').resolve()
        catalog=bench/'catalog.json'
        if output.is_relative_to(bench):
            cat=json.loads(catalog.read_text()) if catalog.exists() else {'scenes':[]}
            cat['scenes']=[s for s in cat['scenes'] if s['id']!=args.scene_id]
            cat['scenes'].append({'id':args.scene_id,'name':args.name,'url':output.relative_to(bench).as_posix()}); cat['default']=args.scene_id
            catalog.write_text(json.dumps(cat,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        print(f'Configured {len(qualities)} resolutions × {args.end-args.start+1} frames; verified {pairs} Full/Tile pairs.\n{output}')
        print(json.dumps(network_bytes))
        return 0
    except (ValueError,OSError,KeyError) as e:
        ap.exit(2,f'Not configured: {e}\n')
if __name__=='__main__': main()
