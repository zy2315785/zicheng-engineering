import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,timingSafeEqual} from 'node:crypto';
import {Readable} from 'node:stream';
import {localDocumentPath,projectConfig} from './project-files.mjs';
import {cloudStatus,cloudConfig,saveCloudConfig,mapImaProject} from './cloud-sources.mjs';
import {startBaiduAuth,pollBaiduAuth,fetchBaiduFile} from './baidu-drive.mjs';
import {resolveAsk,apiStatus,activeProvider} from './api-bridge.mjs';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const DIST=path.join(ROOT,'dist');
const REMOTE=new Map();
try{for(const doc of JSON.parse(fs.readFileSync(path.join(ROOT,'.local/remote-documents.json'),'utf8')))REMOTE.set(doc.id,doc)}catch{}
const HOST='127.0.0.1';
const PORT=Number(process.env.PORT??4173);
const INSTANCE=createHash('sha256').update(ROOT.toLowerCase()).digest('hex').slice(0,20);
const STOP_TOKEN=process.env.ZC_INSTANCE_STOP_TOKEN??'';
let stopping=false;
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
const send=(res,code,text,type='text/plain; charset=utf-8')=>{res.writeHead(code,{'Content-Type':type,'X-Content-Type-Options':'nosniff'});res.end(text)};
const sendJson=(res,code,payload)=>send(res,code,JSON.stringify(payload),'application/json; charset=utf-8');

// 问答链路状态：仅在最近一次真实调用后更新，health 不做额外探测，避免拖慢页面加载。
let modelState={connected:false,state:'unchecked',message:'尚未发起过模型问答'};

let dataCache=null,dataMtime=0;
function loadDocuments(){
 const stat=fs.statSync(path.join(DIST,'project-data.json'));
 if(!dataCache||stat.mtimeMs!==dataMtime){
   dataCache=JSON.parse(fs.readFileSync(path.join(DIST,'project-data.json'),'utf8'));
   dataMtime=stat.mtimeMs;
 }
 return dataCache.documents??[];
}
function briefSources(sources=[]){
 return sources.map(({doc,chunk,score})=>{
   if(!doc)return null;
   const {chunks,...metadata}=doc;
   return {doc:metadata,chunk:chunk??null,score:score??0};
 }).filter(Boolean);
}
function readJson(req,limit=256*1024){
 return new Promise((resolve,reject)=>{
  let raw='',size=0,settled=false;
  const fail=error=>{if(settled)return;settled=true;reject(error)};
  req.on('data',chunk=>{
   size+=chunk.length;
   if(size>limit){fail(Object.assign(new Error('请求内容过大。'),{status:413}));req.resume();return}
   raw+=chunk;
  });
  req.on('end',()=>{if(settled)return;settled=true;try{resolve(JSON.parse(raw||'{}'))}catch{fail(Object.assign(new Error('请求格式不正确。'),{status:400}))}});
  req.on('error',fail);
 });
}

async function handleAsk(req,res){
 if(req.method!=='POST')return sendJson(res,405,{ok:false,message:'请使用 POST 提交问题。'});
 let body;try{body=await readJson(req)}catch(error){return sendJson(res,error.status??400,{ok:false,message:error.message})}
 const question=String(body.question??'').trim();
 const project=String(body.project??'ruibang').trim();
 const history=Array.isArray(body.history)?body.history.slice(-6).map(m=>({question:String(m?.question??'').slice(0,1800),answer:String(m?.answer??'').slice(0,2500)})):[];
 if(!question)return sendJson(res,400,{ok:false,message:'请先输入要查询的问题。'});
 if(question.length>2000)return sendJson(res,400,{ok:false,message:'请将问题控制在 2000 字以内。'});
 const controller=new AbortController();
 res.on('close',()=>{if(!res.writableEnded)controller.abort()});
 try{
  const documents=loadDocuments();
  const result=await resolveAsk(documents,question,{project,history,signal:controller.signal});
  for(const source of result.sources??[])if(source.doc?.source==='ima')REMOTE.set(source.doc.id,{...source.doc,chunks:[]});
  if(REMOTE.size){fs.mkdirSync(path.join(ROOT,'.local'),{recursive:true});fs.writeFileSync(path.join(ROOT,'.local/remote-documents.json'),JSON.stringify([...REMOTE.values()].slice(-500)));}
  const payload={kind:result.kind,text:result.text,sources:briefSources(result.sources),model:result.model??{provider:'本机检索',connected:false,name:'关键词检索'}};
  if(result.trace?.length)payload.trace=result.trace;
  if(result.error)payload.error=result.error;
  modelState=payload.model.connected
   ?{connected:true,state:'ready',message:'模型与资料工具连接正常',name:payload.model.name??null}
   :{connected:false,state:result.error??'local-only',message:String(result.text??'').split('\n')[0].slice(0,160)};
  if(res.writableEnded||controller.signal.aborted)return;
  sendJson(res,200,payload);
 }catch(error){
  modelState={connected:false,state:'SERVER_ERROR',message:String(error.message??'问答服务异常')};
  if(res.writableEnded)return;
  sendJson(res,502,{ok:false,message:'问答服务没有正常返回，请稍后重试。',kind:'unavailable',text:'本次问答没有完成。可以刷新页面重试，或改用资料库直接查看原文。',sources:[],model:{provider:'本机检索',connected:false,name:'关键词检索'}});
 }
}


async function handleCloud(req,res,url){
 if(url.pathname==='/api/cloud/status'&&req.method==='GET')return sendJson(res,200,{ok:true,...cloudStatus(),model:apiStatus()});
 if(req.method!=='POST')return sendJson(res,405,{ok:false,message:'请使用 POST。'});
 const body=await readJson(req,20000);
 if(url.pathname==='/api/cloud/check'){
  const project=String(body.project??'ruibang');
  const mapped=await mapImaProject(project,{refresh:true});
  return sendJson(res,200,{ok:true,project,files:mapped.files.length,...cloudStatus()});
 }
 if(url.pathname==='/api/cloud/baidu/start')return sendJson(res,200,{ok:true,...await startBaiduAuth()});
 if(url.pathname==='/api/cloud/baidu/poll')return sendJson(res,200,{ok:true,...await pollBaiduAuth(String(body.id??''))});
 if(url.pathname==='/api/settings'){
  const cloud=cloudConfig();
  cloud.ima={...cloud.ima,enabled:true,knowledgeBaseName:'子城'};
  cloud.baidu={...cloud.baidu,enabled:true,root:'/AI'};
  for(const [field,key] of [['imaClientId','clientId'],['imaApiKey','apiKey']])if(String(body[field]??'').trim())cloud.ima[key]=String(body[field]).trim();
  for(const [field,key] of [['baiduAppKey','appKey'],['baiduSecretKey','secretKey']])if(String(body[field]??'').trim())cloud.baidu[key]=String(body[field]).trim();
  cloud.requiredIma=true;
  const configFile=path.join(ROOT,'.local/api-config.json');
  let api={};try{api=JSON.parse(fs.readFileSync(configFile,'utf8'))}catch{}
  if(String(body.modelKey??'').trim())api.key=String(body.modelKey).trim();
  if(String(body.model??'').trim())api.model=String(body.model).trim();
  if(body.modelBase){const base=new URL(String(body.modelBase));if(base.protocol!=='https:')return sendJson(res,400,{ok:false,message:'模型 API 必须使用 HTTPS。'});api.base=base.href.replace(/\/$/,'');}
  api.thinking=true;api.effort='high';api.maxTokens=16384;api.maxSteps=6;api.agent=true;
  saveCloudConfig(cloud);
  fs.writeFileSync(configFile,JSON.stringify(api,null,2));
  return sendJson(res,200,{ok:true,message:'连接配置已保存在本机后台。',...cloudStatus()});
 }
 return sendJson(res,404,{ok:false,message:'接口不存在。'});
}
async function handleDownload(req,res,url){
 if(!['GET','HEAD'].includes(req.method))return send(res,405,'Method not allowed');
 const id=decodeURIComponent(url.pathname.split('/').at(-1));
 const doc=loadDocuments().find(d=>d.id===id)??REMOTE.get(id);
 if(!doc||!projectConfig(doc.project))return sendJson(res,404,{ok:false,message:'资料未找到，请重新检索。'});
 const controller=new AbortController();
 res.on('close',()=>{if(!res.writableEnded)controller.abort()});
 const {response}=await fetchBaiduFile(doc,{signal:controller.signal,range:req.headers.range});
 res.setHeader('Content-Disposition','attachment; filename="document.'+doc.type+'"; filename*=UTF-8\'\''+encodeURIComponent(doc.name));
 res.setHeader('Content-Type',types['.'+doc.type]??'application/octet-stream');
 res.setHeader('X-Content-Type-Options','nosniff');
 for(const header of ['content-length','content-range','accept-ranges'])if(response.headers.has(header))res.setHeader(header,response.headers.get(header));
 res.writeHead(response.status);
 if(req.method==='HEAD'){await response.body?.cancel();return res.end()}
 Readable.fromWeb(response.body).on('error',()=>res.destroy()).pipe(res);
}

const server=http.createServer(async(req,res)=>{
 try{
 if(req.headers.host!==`${HOST}:${PORT}`&&req.headers.host!==`localhost:${PORT}`)return send(res,403,'Invalid host');
 if(req.headers.origin&&!([`http://${HOST}:${PORT}`,`http://localhost:${PORT}`].includes(req.headers.origin)))return send(res,403,'Invalid origin');
 let url;try{url=new URL(req.url,`http://${HOST}:${PORT}`)}catch{return send(res,400,'Bad request')}
 res.setHeader('Cache-Control','private, no-store');
 if(url.pathname==='/api/shutdown'){
   if(req.method!=='POST')return sendJson(res,405,{ok:false,message:'Method not allowed'});
   const supplied=req.headers['x-zc-stop-token'];
   if(!STOP_TOKEN||typeof supplied!=='string'||Buffer.byteLength(supplied)!==Buffer.byteLength(STOP_TOKEN)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(STOP_TOKEN)))return sendJson(res,403,{ok:false,message:'Invalid service control token'});
   if(stopping)return sendJson(res,409,{ok:false,message:'Service is already stopping'});
   stopping=true;res.setHeader('Connection','close');
   res.once('finish',()=>{server.close(()=>process.exit(0));server.closeIdleConnections();setTimeout(()=>process.exit(0),1000).unref()});
   return sendJson(res,200,{ok:true,message:'Service is stopping'});
 }
 if(url.pathname==='/api/ask'){await handleAsk(req,res);return}
 if(url.pathname.startsWith('/api/cloud/')||url.pathname==='/api/settings'){await handleCloud(req,res,url);return}
 if(url.pathname.startsWith('/api/download/')){await handleDownload(req,res,url);return}
 if(url.pathname==='/api/model'){
   if(!['GET','HEAD'].includes(req.method))return sendJson(res,405,{ok:false,message:'Method not allowed'});
   sendJson(res,200,{ok:true,status:apiStatus()});
   return;
 }
 if(!['GET','HEAD'].includes(req.method))return send(res,405,'Method not allowed');
 res.setHeader('Cache-Control','private, no-store');
 if(url.pathname==='/api/health')return sendJson(res,200,{service:'zicheng-local',provider:activeProvider(),modelConnected:modelState.connected,modelState:modelState.state,cloud:cloudStatus(),instanceId:INSTANCE,pid:process.pid});
 let target;
 if(url.pathname.startsWith('/api/files/')){
   const id=url.pathname.split('/').at(-1);
   const data=JSON.parse(fs.readFileSync(path.join(DIST,'project-data.json'),'utf8'));
   const doc=data.documents.find(d=>d.id===id);
   if(!doc)return send(res,404,'Document not found');
   if(url.searchParams.has('download')){await handleDownload(req,res,new URL('/api/download/'+encodeURIComponent(id),url));return}
   target=localDocumentPath(doc);
   const disposition=url.searchParams.has('download')?'attachment':'inline';
   res.setHeader('Content-Disposition',`${disposition}; filename="document.${doc.type}"; filename*=UTF-8''${encodeURIComponent(doc.name)}`);
   res.setHeader('Cache-Control','private, no-store');
 }else{
   let pathname;try{pathname=decodeURIComponent(url.pathname)}catch{return send(res,400,'Bad URL')}
   target=path.resolve(DIST,'.'+(pathname==='/'?'/index.html':pathname));
   if(!target.startsWith(DIST+path.sep)||!fs.existsSync(target)||!fs.statSync(target).isFile())return send(res,404,'Not found');
 }
 const stat=fs.statSync(target);
 res.setHeader('Content-Type',types[path.extname(target).toLowerCase()]??'application/octet-stream');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Referrer-Policy','same-origin');
 res.setHeader('Accept-Ranges','bytes');
 if(req.headers.range){
   const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
   if(!m)return send(res,416,'Unsupported range');
   const start=Number(m[1]),end=m[2]?Math.min(Number(m[2]),stat.size-1):stat.size-1;
   if(start>end||start>=stat.size){res.setHeader('Content-Range',`bytes */${stat.size}`);return send(res,416,'Invalid range')}
   res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${stat.size}`,'Content-Length':end-start+1});
   return req.method==='HEAD'?res.end():fs.createReadStream(target,{start,end}).pipe(res);
 }
 res.writeHead(200,{'Content-Length':stat.size});
 if(req.method==='HEAD')res.end();else fs.createReadStream(target).pipe(res);
 }catch(error){if(res.headersSent){res.destroy();return}sendJson(res,error.status??502,{ok:false,message:error.code?String(error.message).slice(0,220):'服务暂未完成，请检查连接后重试。',code:error.code??'SERVER_ERROR'});}
});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`端口 ${PORT} 已在使用。请设置 PORT 后重试。`:error.message);process.exitCode=1});
server.listen(PORT,HOST,()=>console.log(`子城联合工程部 · 本地预览 http://${HOST}:${PORT}\n问答接口 /api/ask 已就绪；原始资料仅在本机提供访问。按 Ctrl+C 停止。`));
