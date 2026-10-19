"""Test-only local HTTP server. NEVER use as a production backend."""
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
import os,json,time,datetime,urllib.parse
ROOT=Path(__file__).resolve().parent.parent/'public'
cloud={}
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT),**kwargs)
    def do_GET(self):
        p=urllib.parse.urlparse(self.path).path
        if p=='/api/session':
            # slow session to verify full screen skeleton handling
            if os.environ.get('SLOW_SESSION')=='1':time.sleep(0.75)
            return self.reply({'authenticated':self.auth(), 'user':{'id':'mock-user','name':'E2E User','email':'test@example.com','avatarUrl':''} if self.auth() else None})
        if p=='/api/items':
            if not self.auth():return self.reply({'error':'ログインが必要です'},401)
            return self.reply({'items':list(cloud.values())})
        if p=='/__test/login':
            self.send_response(302);self.send_header('Set-Cookie','mock_login=1; Path=/; SameSite=Lax; HttpOnly');self.send_header('Location','/');self.end_headers();return
        if p=='/api/auth/google':return self.reply({'error':'テスト環境ではGoogle認証を利用できません'},503)
        return super().do_GET()
    def auth(self):return 'mock_login=1' in self.headers.get('Cookie','')
    def incoming(self):
        try:return json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
        except:return {}
    def do_POST(self):
        p=urllib.parse.urlparse(self.path).path
        if p=='/api/logout':
            self.send_response(200);self.send_header('Set-Cookie','mock_login=; Path=/; Max-Age=0');self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{"ok":true}');return
        if not self.auth():return self.reply({'error':'ログインが必要です'},401)
        if p=='/api/items':
            item=self.incoming();cloud[item['id']]=item;return self.reply({'item':item},201)
        if p=='/api/ai/tasks':
            data=self.incoming();return self.reply({'tasks':[{'title':'資料を確認する'},{'title':'ゼミを準備する'}] if data.get('text') else []})
        return self.reply({'error':'Not found'},404)
    def do_PUT(self):
        p=urllib.parse.urlparse(self.path).path
        if not self.auth():return self.reply({'error':'ログインが必要です'},401)
        key=p.rsplit('/',1)[-1];item=self.incoming();cloud[key]=item;return self.reply({'item':item})
    def do_PATCH(self):
        p=urllib.parse.urlparse(self.path).path
        if not self.auth():return self.reply({'error':'ログインが必要です'},401)
        key=p.rsplit('/',1)[-1];item=self.incoming();cloud[key]=item;return self.reply({'item':item})
    def do_DELETE(self):
        key=urllib.parse.urlparse(self.path).path.rsplit('/',1)[-1];cloud.pop(key,None);return self.reply({'ok':True})
    def reply(self,payload,status=200):
        data=json.dumps(payload,ensure_ascii=False).encode()
        self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
    def log_message(self,*args):pass
if __name__=='__main__':
    print('Serving on 127.0.0.1:8765',flush=True)
    ThreadingHTTPServer(('127.0.0.1',8765),Handler).serve_forever()
