import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { signalFetch } from '../src/sites/signaling.js';
import { sqliteSignalStore } from './lib/sqlite-signal-store.js';
const store=sqliteSignalStore();
const assets=resolve('dist/client');
const types:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.wav':'audio/wav','.json':'application/json'};
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url??'/',`http://${req.headers.host}`);
    if(url.pathname.startsWith('/api/')||url.pathname==='/health'){
      const chunks:Buffer[]=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>40000){res.writeHead(413);res.end();return;}chunks.push(chunk);}
      const request=new Request(url,{method:req.method,headers:Object.fromEntries(Object.entries(req.headers).filter(([,value])=>value!==undefined).map(([key,value])=>[key,Array.isArray(value)?value.join(','):value!])),body:chunks.length?Buffer.concat(chunks):undefined});
      const response=await signalFetch(request,{DB:store.db});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    let path=resolve(assets,`.${decodeURIComponent(url.pathname)}`);
    if(!path.startsWith(`${assets}/`)&&path!==assets){res.writeHead(403);res.end();return;}
    if(!(await stat(path).catch(()=>null))?.isFile())path=resolve(assets,'index.html');
    res.writeHead(200,{'Content-Type':types[extname(path)]??'application/octet-stream'});res.end(await readFile(path));
  }catch{res.writeHead(500);res.end('Preview error');}
});
server.listen(Number(process.env.PORT??4187),'127.0.0.1',()=>console.log(`Sites browser-host preview: http://127.0.0.1:${process.env.PORT??4187}`));
for(const event of ['SIGINT','SIGTERM'] as const)process.on(event,()=>{server.close();store.close();process.exit(0);});
