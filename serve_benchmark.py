#!/usr/bin/env python3
"""Local HTTP server: CORS, Timing-Allow-Origin, Range, explicit MIME and cache policy."""
import argparse
from functools import partial
from http.server import ThreadingHTTPServer
from serve import Handler as Base
class Handler(Base):
    def end_headers(self):
        self.send_header('Cache-Control','public, max-age=86400' if self.path.split('?')[0].endswith('.ply') else 'no-cache')
        super().end_headers()
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=8765);p.add_argument('--bind',default='127.0.0.1');p.add_argument('--directory',default='dist');a=p.parse_args()
    with ThreadingHTTPServer((a.bind,a.port),partial(Handler,directory=a.directory)) as server:
        print(f'Open http://{a.bind}:{a.port}/bench/ — Ctrl+C to stop',flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
