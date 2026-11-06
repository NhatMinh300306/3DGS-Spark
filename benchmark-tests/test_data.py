import contextlib,io,json,subprocess,sys,tempfile,unittest
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from bench_tools.ply_data import read,write,describe,equivalent
from configure_benchmark import main,collect
ROOT=Path(__file__).resolve().parents[1]
FIXTURE=ROOT/'dist/bench/data/fixture/manifest.json'
class DataTests(unittest.TestCase):
    def test_fixture_120_exact_pairs_sh3(self):
        d=json.loads(FIXTURE.read_text());self.assertTrue(d['fixture']);self.assertEqual(len(d['qualities']),4)
        for q in d['qualities']:
            self.assertEqual([f['id'] for f in q['frames']],list(range(1450,1480)))
            for f in q['frames']:
                paths=lambda kind:[FIXTURE.parent/a['url'].split('?')[0] for a in f[kind]]
                a=read(paths('full')[0]);self.assertTrue(equivalent(a,[read(p) for p in paths('tiles')]))
                self.assertEqual(describe(paths('full')[0],a)['sh_degree'],3)
                self.assertIn('nx',a.dtype.names)
    def test_duplicates_and_missing_attributes_fail_equivalence(self):
        d=json.loads(FIXTURE.read_text());f=d['qualities'][0]['frames'][0];a=read(FIXTURE.parent/f['full'][0]['url'].split('?')[0]);self.assertFalse(equivalent(a,[a,a]));self.assertFalse(equivalent(a,[a[:-1]]));b=a.copy();b['opacity'][0]+=1;self.assertFalse(equivalent(a,[b]))
    def test_truncated_and_nonfinite_ply_rejected(self):
        d=json.loads(FIXTURE.read_text());f=d['qualities'][0]['frames'][0];a=read(FIXTURE.parent/f['full'][0]['url'].split('?')[0])
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'a.ply';write(p,a);p.write_bytes(p.read_bytes()[:-1]);self.assertRaises(ValueError,read,p);a['x'][0]=np.nan;write(p,a);self.assertRaises(ValueError,read,p)
    def test_incremental_full_then_tiles_manifest(self):
        d=json.loads(FIXTURE.read_text());f=d['qualities'][-1]['frames'][0];a=read(FIXTURE.parent/f['full'][0]['url'].split('?')[0])
        with tempfile.TemporaryDirectory() as tmp:
            tmp=Path(tmp);write(tmp/'full/res8/001450.ply',a)
            for i in range(3):write(tmp/f'tiles/layer_8/frame_1450/voxels_new/{i}.ply',a[i::3])
            out=tmp/'out/manifest.json';common=['--res','res8','--start','1450','--end','1450','--output',str(out),'--copy']
            with contextlib.redirect_stdout(io.StringIO()):main(['--full-root',str(tmp/'full'),*common]);main(['--tiles-root',str(tmp/'tiles'),'--tile-dir','voxels_new',*common])
            result=json.loads(out.read_text());self.assertEqual(result['qualities'][0]['frames'][0]['equivalence'],'verified_exact_scalar_multiset');self.assertNotIn(str(tmp),out.read_text())
    def test_discovery_both_directory_orders(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            for p in ['frame_1450/layer_1/voxels_new/a.ply','tile30_res2_x/f1451/point_cloud/iteration_30000/point_cloud.ply']:(root/p).parent.mkdir(parents=True,exist_ok=True);(root/p).write_text('placeholder')
            self.assertEqual(set(collect(root)),{('res1',1450),('res2',1451)})
    def test_split_preserves_all_attributes_and_exact_ownership(self):
        d=json.loads(FIXTURE.read_text());a=read(FIXTURE.parent/d['qualities'][-1]['frames'][0]['full'][0]['url'].split('?')[0])
        with tempfile.TemporaryDirectory() as tmp:
            tmp=Path(tmp);write(tmp/'in/res8/001450.ply',a)
            run=subprocess.run([sys.executable,str(ROOT/'split_benchmark_tiles.py'),'--input',str(tmp/'in'),'--output',str(tmp/'tiles')],capture_output=True,text=True)
            self.assertEqual(run.returncode,0,run.stderr);tiles=[read(p) for p in (tmp/'tiles').rglob('*.ply')];self.assertTrue(equivalent(a,tiles));self.assertEqual(sum(map(len,tiles)),len(a))
    def test_server_range_mime_cors(self):
        import threading,urllib.request
        from functools import partial
        from http.server import ThreadingHTTPServer
        from serve_benchmark import Handler
        server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT/'dist')));thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            d=json.loads(FIXTURE.read_text());asset=d['qualities'][0]['frames'][0]['full'][0]['url'];url=f'http://127.0.0.1:{server.server_port}/bench/data/fixture/'+asset
            with urllib.request.urlopen(urllib.request.Request(url,headers={'Range':'bytes=0-9'})) as r:
                self.assertEqual(r.status,206);self.assertEqual(len(r.read()),10);self.assertEqual(r.headers['Content-Type'],'application/octet-stream');self.assertEqual(r.headers['Timing-Allow-Origin'],'*')
        finally:server.shutdown();server.server_close()
    def test_quality_identical_and_mismatched_camera(self):
        from PIL import Image
        from evaluate_captures import evaluate
        with tempfile.TemporaryDirectory() as tmp:
            tmp=Path(tmp);meta={'scene_id':'fixture','captures':[{'res':'res8','frame_id':1450,'file':'a.png','camera':{'position':[0,0,1]},'width':16,'height':16,'background':'black','color_space':'sRGB','tone_mapping':'none'}]}
            for sub in ['a','b']:
                p=tmp/sub;p.mkdir();Image.fromarray(np.zeros((16,16,3),dtype=np.uint8)).save(p/'a.png');(p/'captures.json').write_text(json.dumps(meta))
            result=evaluate(tmp/'a',tmp/'b');self.assertEqual(result[0]['ssim'],1);self.assertIsNone(result[0]['psnr_db']);meta['captures'][0]['camera']['position']=[0,0,2];(tmp/'b/captures.json').write_text(json.dumps(meta));self.assertRaises(ValueError,evaluate,tmp/'a',tmp/'b')
if __name__=='__main__':unittest.main()
