"""Load exact application sources into Chromium's about:blank document when URL navigation is enterprise-blocked.
This tests real DOM and interactions, but storage and API are mocked. Not a production smoke test.
"""
from pathlib import Path
import re
ROOT=Path(__file__).resolve().parent.parent

def make_page():
    html=(ROOT/'public/index.html').read_text()
    css=(ROOT/'public/style.css').read_text()
    logic=(ROOT/'public/logic.js').read_text().replace('export const ', 'const ').replace('export function ','function ')
    sync=(ROOT/'public/sync.js').read_text().replace("import { safeItems } from './logic.js';",'').replace('export const ', 'const ').replace('export function ','function ').replace('export class ','class ')
    quota=(ROOT/'public/quota.js').read_text().replace('export const ', 'const ').replace('export function ', 'function ')
    app=(ROOT/'public/app.js').read_text()
    app=app.replace("import { clampStatus, createItem, getCounts, getVisibleItems, nextStatus, safeItems } from './logic.js';",'').replace("import { CloudSync, cacheKey, queueKey } from './sync.js';",'').replace("import { renderQuotaPanel } from './quota.js';",'')
    html=html.replace('<script src="/theme.js"></script>', '<script>'+ (ROOT/'public/theme.js').read_text() + '</script>')
    html=html.replace('<link rel="stylesheet" href="/style.css" />','<style>'+css+'</style>')
    html=html.replace('<script type="module" src="/app.js"></script>','<script type="module">'+logic+'\n'+sync+'\n'+quota+'\n'+app+'</script>')
    bootstrap='''<script>
    window.__mizuStore=window.__mizuStore||new Map();
    if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>[4,2,2,2,6].map((n,i)=>Array.from(crypto.getRandomValues(new Uint8Array(n)),b=>b.toString(16).padStart(2,'0')).join('')).join('-')});
    Object.defineProperty(window,'localStorage',{configurable:true,value:{
      getItem:k=>window.__mizuStore.has(k)?window.__mizuStore.get(k):null,
      setItem:(k,v)=>window.__mizuStore.set(k,String(v)),
      removeItem:k=>window.__mizuStore.delete(k),clear:()=>window.__mizuStore.clear()
    }});
    window.__cloudItems=window.__cloudItems||new Map();
    window.__offlineWrites=window.__offlineWrites||false;
    window.__mockAuthenticated=window.__mockAuthenticated||false;
    window.fetch=async(url,opts={})=>{
      const path=String(url);
      if(window.__offlineWrites && (opts.method==='PUT'||opts.method==='DELETE'))throw new Error('Offline');
      await new Promise(r=>setTimeout(r,8));
      const resp=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json'}});
      if(path==='/api/usage')return resp({configured:false,metrics:{},aiCalls:{used:3,limit:20},message:'Cloudflare Analyticsの設定が必要です'});
      if(path==='/api/session'&&window.__offlineMock)throw new Error('Offline');
      if(path==='/api/session')return resp({authenticated:window.__mockAuthenticated,user:window.__mockAuthenticated?{id:'tester',email:'tester@example.com',name:'Tester'}:null});
      if(!window.__mockAuthenticated)return resp({error:'Googleログインが必要です'},401);
      if(path==='/api/items'&&(!opts.method||opts.method==='GET'))return resp({items:[...window.__cloudItems.values()]});
      if(path==='/api/items'&&opts.method==='POST'){const o=JSON.parse(opts.body);window.__cloudItems.set(o.id,o);return resp({item:o},201);}
      if(path.startsWith('/api/items/')&&['PUT','PATCH'].includes(opts.method)){const o=JSON.parse(opts.body);window.__cloudItems.set(o.id,o);return resp({item:o});}
      if(path.startsWith('/api/items/')&&opts.method==='DELETE'){window.__cloudItems.delete(path.split('/').at(-1));return resp({ok:true});}
      if(path==='/api/ai/tasks')return resp({tasks:[{title:'資料を確認する'},{title:'ゼミを準備する'}]});
      if(path==='/api/logout'){window.__mockAuthenticated=false;return resp({ok:true});}
      return resp({error:'Not found'},404);
    };
    </script>'''
    theme=(ROOT/'public/theme.js').read_text()
    html=html.replace('<script>'+theme+'</script>',bootstrap+'<script>'+theme+'</script>',1)
    return html
