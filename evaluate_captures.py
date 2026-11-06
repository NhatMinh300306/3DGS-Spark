#!/usr/bin/env python3
"""Offline PSNR/SSIM, optional LPIPS; never run during a speed benchmark."""
import argparse,csv,json
from pathlib import Path
import numpy as np
from PIL import Image
from skimage.metrics import structural_similarity

def evaluate(reference,candidate,lpips_enabled=False):
    reference=Path(reference);candidate=Path(candidate)
    rm=json.loads((reference/'captures.json').read_text());cm=json.loads((candidate/'captures.json').read_text())
    if rm['scene_id']!=cm['scene_id']:raise ValueError('Scene mismatch')
    refs={(x['res'],x['frame_id']):x for x in rm['captures']};rows=[];model=None
    if lpips_enabled:
        import lpips
        model=lpips.LPIPS(net='alex')
    for c in cm['captures']:
        key=(c['res'],c['frame_id']);r=refs.get(key)
        if not r:raise ValueError(f'Missing reference frame {key}')
        for field in ['camera','width','height','background','color_space','tone_mapping']:
            if r.get(field)!=c.get(field):raise ValueError(f'Capture mismatch {field}: {key}')
        a=np.asarray(Image.open(reference/r['file']).convert('RGB'),dtype=np.float32)/255
        b=np.asarray(Image.open(candidate/c['file']).convert('RGB'),dtype=np.float32)/255
        if a.shape!=b.shape:raise ValueError('Image shape mismatch')
        mse=float(np.mean((a-b)**2));psnr=None if mse==0 else float(10*np.log10(1/mse))
        row={'res':key[0],'frame_id':key[1],'mse':mse,'psnr_db':psnr,'psnr_reason':'identical_images_infinite' if mse==0 else '', 'ssim':float(structural_similarity(a,b,data_range=1,channel_axis=-1)), 'lpips':None}
        if model is not None:
            import torch
            tensor=lambda x:torch.from_numpy(x.transpose(2,0,1).copy()).unsqueeze(0)*2-1
            with torch.no_grad():row['lpips']=float(model(tensor(a),tensor(b)).item())
        rows.append(row)
    return rows
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--reference',required=True);p.add_argument('--candidate',required=True);p.add_argument('--output',default='quality.csv');p.add_argument('--lpips',action='store_true');a=p.parse_args();rows=evaluate(a.reference,a.candidate,a.lpips)
    with open(a.output,'w',newline='',encoding='utf-8-sig') as f:
        w=csv.DictWriter(f,fieldnames=list(rows[0]) if rows else ['frame_id']);w.writeheader();w.writerows(rows)
    print(f'Wrote {len(rows)} image pairs. Full PLY reference is not ground truth unless separately supplied.')
