#!/usr/bin/env python3
"""Aggregate independent run summaries; do not pool correlated frames as independent runs."""
import argparse,csv,hashlib,json,zipfile
from collections import defaultdict
from pathlib import Path
import numpy as np

def aggregate(paths):
    runs=[];seen=set();groups=defaultdict(list);excluded=[]
    for path in paths:
        with zipfile.ZipFile(path) as z:
            for name in z.namelist():
                if not name.endswith('/summary.json'):continue
                s=json.loads(z.read(name));meta=json.loads(z.read(name.replace('summary.json','metadata.json')))
                rid=s['run_id']
                if rid in seen:raise ValueError(f'Duplicate run_id: {rid}')
                seen.add(rid);runs.append(s)
                if s['status']!='completed' or not s['instrumentation']['complete_log']:
                    excluded.append({'run_id':rid,'reason':s['status']});continue
                c=dict(meta['config']);t=c.pop('treatment');
                for k in ['repeat_index','batch_id','purpose']:c.pop(k,None)
                c['manifest_scene']=meta['manifest_scene'];c['fixture']=meta['fixture'];c['renderer']=meta['renderer'];c['camera']=meta['camera'];c['viewport']=meta['viewport'];c['equivalence']=meta['equivalence'];c['dataset_assets']=meta.get('dataset_assets')
                fingerprint=hashlib.sha256(json.dumps(c,sort_keys=True).encode()).hexdigest()[:16]
                groups[(fingerprint,t)].append(s)
    result=[]
    for (f,t),ss in groups.items():
        row={'configuration':f,'treatment':t,'independent_runs':len(ss),'minimum_5_runs_met':len(ss)>=5}
        for metric in ['content_fps','time_to_first_complete_frame_ms','buffering_ms','deadline_miss_ratio','network_goodput_bps','bytes_body_received']:
            a=np.array([s[metric] for s in ss if isinstance(s.get(metric),(int,float)) and np.isfinite(s[metric])]);row[metric]={'valid_n':len(a),'mean':float(a.mean()) if len(a) else None,'median':float(np.median(a)) if len(a) else None,'p95':float(np.quantile(a,.95)) if len(a)>=20 else None,'p99':float(np.quantile(a,.99)) if len(a)>=100 else None}
        result.append(row)
    return {'groups':result,'excluded_runs':excluded,'total_run_ids':len(seen),'warning':'No causal speedup claim; verify equivalence, cache, network and matched conditions. p95 >=20; p99 >=100 independent run samples.'}
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('archives',nargs='+');p.add_argument('--output',default='comparison.json');a=p.parse_args();result=aggregate(a.archives);Path(a.output).write_text(json.dumps(result,indent=2))
    flat=[]
    for g in result['groups']:
        row={k:v for k,v in g.items() if not isinstance(v,dict)}
        for m,v in g.items():
            if isinstance(v,dict):row.update({m+'_'+k:x for k,x in v.items()})
        flat.append(row)
    if flat:
        with Path(a.output).with_suffix('.csv').open('w',newline='',encoding='utf-8-sig') as f:
            w=csv.DictWriter(f,fieldnames=list(flat[0]));w.writeheader();w.writerows(flat)
    print(f"Wrote {len(result['groups'])} configuration/treatment groups; retained {result['total_run_ids']} independent run IDs.")
