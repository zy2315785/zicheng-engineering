import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Readable,Transform} from 'node:stream';
import {APP_ROOT,AI_ROOT,localDocumentPath,normalizeName,projectConfig} from './project-files.mjs';
import {searchImaDetailed,cloudConfig} from './cloud-sources.mjs';
import {fetchBaiduFile} from './baidu-drive.mjs';
import {searchDocuments} from './dist/search.mjs';

export const TOOLS=[
 {type:'function',function:{name:'search_docs',description:'检索当前项目 ima 云端资料并结合本地镜像。可换关键词反复查找。',parameters:{type:'object',properties:{query:{type:'string'},category:{type:'string'}},required:['query']}}},
 {type:'function',function:{name:'read_document',description:'打开当前项目文件的原文核对。支持按 keyword 查找或用 page 翻阅PDF；扫描页会尝试OCR。',parameters:{type:'object',properties:{name:{type:'string'},keyword:{type:'string'},page:{type:'integer',minimum:1},offset:{type:'integer',minimum:0}},required:['name']}}},
 {type:'function',function:{name:'download_file',description:'准备当前项目文件的百度网盘下载入口。只能访问当前项目在/AI中的对应目录。',parameters:{type:'object',properties:{name:{type:'string'}},required:['name']}}}
];
const strip=doc=>{const {chunks,...metadata}=doc;return metadata};
const brief=hits=>hits.map(hit=>'['+hit.number+'] '+hit.doc.name+' · '+(hit.chunk?.location??'目录')+'\n'+(hit.chunk?.text??'尚未取得正文，请用 read_document 打开核对。').slice(0,3000)).join('\n\n');
export function linkCloudToLocal(remote,documents,project){
 const pool=documents.filter(d=>d.project===project);
 return remote.map(doc=>{
  const exact=pool.find(d=>normalizeName(d.path)===normalizeName(doc.path));
  const sameName=pool.filter(d=>normalizeName(d.name)===normalizeName(doc.name));
  const local=exact??(sameName.length===1?sameName[0]:null);
  return {...doc,id:local?.id??doc.id,localId:local?.id,localPath:local?.path,...(local?{path:local.path,type:local.type,size:local.size,category:local.category}:{}),cloudSource:'ima'};
 });
}
const parsed=new Map();
export async function parseFile(file,{page=1,signal}={}){
 const stat=fs.statSync(file);
 const key=file+'|'+stat.mtimeMs+'|'+page;
 if(parsed.has(key))return parsed.get(key);
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(path.join(AI_ROOT,'runtime/python/python.exe'),['-I','-B',path.join(APP_ROOT,'scripts/document-parser.py'),file,'--start',String(Math.max(1,page)),'--pages','4','--ocr'],{cwd:APP_ROOT,windowsHide:true,stdio:['ignore','pipe','ignore']});
  let out='',settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);error?reject(error):resolve(value)};
  const cancel=()=>{child.kill();finish(new Error('文件读取已取消。'))};
  const timer=setTimeout(()=>{child.kill();finish(new Error('原文识别超时，请缩小页码范围。'))},90000);
  if(signal?.aborted){cancel();return}signal?.addEventListener('abort',cancel,{once:true});
  child.stdout.on('data',b=>{out+=b;if(out.length>16*1024*1024){child.kill();finish(new Error('正文过长，请缩小文件范围。'))}});
  child.on('error',error=>finish(error));
  child.on('close',()=>{try{finish(null,JSON.parse(out.trim()))}catch{finish(new Error('原文解析没有返回可用结果。'))}});
 });
 if(parsed.size>30)parsed.delete(parsed.keys().next().value);
 parsed.set(key,result);return result;
}
async function remoteOriginal(doc,{signal}={}){
 const cache=path.join(APP_ROOT,'.local','downloads');
 fs.mkdirSync(cache,{recursive:true});
 const target=path.join(cache,createHash('sha256').update(doc.project+'/'+doc.path).digest('hex').slice(0,24)+'.'+doc.type);
 if(fs.existsSync(target)&&Date.now()-fs.statSync(target).mtimeMs<300000)return target;
 const {response,file}=await fetchBaiduFile(doc,{signal});
 if(file.size>200*1024*1024){await response.body?.cancel();throw new Error('原件超过200MB，请从百度网盘下载后在专业软件中查看。')}
 const temporary=target+'.partial';
 let size=0;
 const limit=new Transform({transform(chunk,encoding,done){size+=chunk.length;done(size>200*1024*1024?new Error('文件超过读取限制。'):null,chunk)}});
 try{await pipeline(Readable.fromWeb(response.body),limit,fs.createWriteStream(temporary),{signal});fs.renameSync(temporary,target)}catch(e){fs.rmSync(temporary,{force:true});throw e}
 return target;
}
export function createKnowledgeTools(documents,{project,signal,today,planSearch}={}){
 if(!projectConfig(project))throw Object.assign(new Error('该项目尚未接入资料。'),{code:'PROJECT_NOT_CONNECTED'});
 const ctx={project,sources:[],trace:[],index:new Map(),known:new Map(documents.filter(d=>d.project===project).map(d=>[d.id,d])),cloudChecked:false};
 function register(doc,chunk,score=0){
  ctx.known.set(doc.id,{...(ctx.known.get(doc.id)??{}),...doc});
  const key=doc.id+'|'+(chunk?.location??'')+'|'+(chunk?.text??'').slice(0,60);
  let number=ctx.index.get(key);
  if(!number){
   if(ctx.sources.length>=24)return null;
   number=ctx.sources.length+1;ctx.index.set(key,number);
   ctx.sources.push({doc:strip(doc),chunk:chunk??null,score});
  }
  return {doc,chunk,number};
 }
 async function search(query,category='全部资料'){
  const config=cloudConfig();
  const local=searchDocuments(documents,query,{project,category,limit:5,today});
  let remote=[];
  if(config.ima?.enabled){
   try{
    const found=await searchImaDetailed(project,query,{signal,planSearch:ctx.cloudChecked?undefined:planSearch,localHints:local.filter(hit=>!hit.doc.imported).map(hit=>hit.doc)});
    remote=linkCloudToLocal(found.documents,documents,project);
    ctx.cloudChecked=true;
    if(found.plannerUsed)ctx.trace.push({step:ctx.trace.length+1,action:'问题拆解',detail:'结合 ima 当前项目 '+found.catalogCount+' 份云端目录选取查阅目标'});
    if(found.plannerFailed)ctx.trace.push({step:ctx.trace.length+1,action:'问题拆解未完成',detail:'改用关键词与本地线索核对 ima 目录'});
    const searches=found.attempts.filter(a=>a.method==='search');
    const catalog=found.attempts.filter(a=>a.method!=='search');
    ctx.trace.push({step:ctx.trace.length+1,action:'ima 检索',detail:'已定位 '+remote.length+' 份当前项目候选资料；关键词搜索命中 '+found.searchCount+' 份'+(catalog.length?'，其余通过云端目录选材核对':'')+'。查询：'+searches.map(a=>'「'+a.query+'」').join('、')});
    if(catalog.length)ctx.trace.push({step:ctx.trace.length+1,action:'ima 目录选材',detail:catalog.map(a=>a.query+'：'+a.count+' 份').join('；')+'（目录候选不等于正文答案，需读取原文）'});
   }catch(error){
    ctx.trace.push({step:ctx.trace.length+1,action:'ima 未完成',detail:'未取得云端资料，已保留本地目录'});
    if(config.requiredIma!==false)throw Object.assign(new Error(error.code?.startsWith('IMA_')?error.message:'ima 连接暂不可用，请检查网络后重试。'),{code:error.code??'IMA_UNAVAILABLE'});
   }
  }
  const hits=[];
  for(const doc of remote){const hit=register(doc,doc.chunks?.[0]);if(hit)hits.push(hit)}
  for(const match of local){if(remote.some(r=>r.id===match.doc.id)&&!match.chunk)continue;const hit=register(match.doc,match.chunk,match.score);if(hit)hits.push(hit)}
  ctx.trace.push({step:ctx.trace.length+1,action:'本地检索',detail:'「'+query+'」→ '+local.length+' 份镜像资料'});
  return brief(hits)||'本次未找到相关文件，可以换用专业术语继续搜索。';
 }
 function find(name){
  const pool=[...ctx.known.values()];
  const n=normalizeName(name);
  let match=pool.filter(d=>normalizeName(d.name)===n||normalizeName(d.path)===n);
  if(!match.length)match=pool.filter(d=>normalizeName(d.name).includes(n));
  if(match.length>1)throw new Error('发现多份同名文件，请提供包含文件夹的完整相对路径。');
  return match[0];
 }
 async function read(args){
  const doc=find(args.name);
  if(!doc)return '当前项目尚未找到此文件，请先用 search_docs 确认文件名。';
  let file,source='本地镜像';
  try{file=localDocumentPath({...doc,path:doc.localPath??doc.path})}catch{file=await remoteOriginal(doc,{signal});source='百度网盘原件'}
  const result=await parseFile(file,{page:Math.max(1,Number(args.page)||1),signal});
  ctx.trace.push({step:ctx.trace.length+1,action:'读取原文',detail:doc.name+' · '+source+(result.ocr?' · OCR':'')});
  let chunks=result.chunks??[];
  const term=String(args.keyword??'').trim();
  if(term){const matches=chunks.filter(c=>c.text.toLowerCase().includes(term.toLowerCase()));if(matches.length)chunks=matches}
  const offset=Math.max(0,Math.min(10000,Number(args.offset)||0));
  const hits=chunks.slice(offset,offset+4).map(c=>register(doc,c)).filter(Boolean);
  return (brief(hits)||'此处未取得可读正文，不能据此判断文件内容。')+'\n读取范围：'+(result.pages?'PDF 共 '+result.pages+' 页，本次从第 '+(args.page||1)+' 页读取最多4页；可继续用 page 翻页。':'共 '+chunks.length+' 段，本次从第 '+offset+' 段读取；可用 offset 继续。');
 }
 async function run(call){
  let args;try{args=JSON.parse(call.function.arguments||'{}')}catch{return '工具参数不是有效 JSON。'}
  if(call.function.name==='search_docs')return search(String(args.query??'').slice(0,200),args.category);
  if(call.function.name==='read_document')return read(args);
  if(call.function.name==='download_file'){
   const doc=find(args.name);if(!doc)return '未找到指定文件，请先检索当前项目。';
   const hit=register(doc,doc.chunks?.[0]);ctx.trace.push({step:ctx.trace.length+1,action:'准备下载',detail:doc.name+' · 百度网盘'});
   return '['+(hit?.number??'')+'] '+doc.name+'，网页来源卡片提供百度网盘下载按钮。若尚未连接，请先完成一次百度网盘授权。';
  }
  return '未知工具。';
 }
 return {ctx,search,run};
}
