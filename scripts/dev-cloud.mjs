// Run the exact cloud handler locally; env files must remain outside dist/ and Git.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {onRequest} from '../cloud-functions/api/[[default]].js';
if(process.argv[2])process.loadEnvFile(process.argv[2]);
const root=fileURLToPath(new URL('../dist/',import.meta.url)),port=Number(process.env.PORT||4175);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webp':'image/webp','.svg':'image/svg+xml'};
http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1:'+port);
  if(url.pathname.startsWith('/api/')){
   const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>600000)throw new Error('body too large');chunks.push(chunk);}
   const request=new Request(url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
   const response=await onRequest({request,env:process.env});
   res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();return;
  }
  const target=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
  if(!target.startsWith(root))throw new Error('invalid path');
  const data=await readFile(target);res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);
 }catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log('Cloud handler preview: http://127.0.0.1:'+port));
