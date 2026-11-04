import fs from 'node:fs';
import path from 'node:path';
import {setDefaultResultOrder} from 'node:dns';
import {APP_ROOT,projectConfig,normalizeName,isExcluded} from './project-files.mjs';
import {planImaQueries} from './ima-query.mjs';
setDefaultResultOrder('ipv4first');
const LOCAL=path.join(APP_ROOT,'.local');
const FILE=path.join(LOCAL,'cloud-config.json');
export function cloudConfig(){
 let c={};try{c=JSON.parse(fs.readFileSync(FILE,'utf8'))}catch{}
 c.ima={...c.ima,clientId:process.env.IMA_OPENAPI_CLIENTID||c.ima?.clientId,apiKey:process.env.IMA_OPENAPI_APIKEY||c.ima?.apiKey};
 return c;
}
export function saveCloudConfig(config){fs.mkdirSync(LOCAL,{recursive:true});fs.writeFileSync(FILE,JSON.stringify(config,null,2));}
const issue=(message,code='CLOUD_ERROR')=>Object.assign(new Error(message),{code});
export async function imaCall(method,body,{signal,fetcher=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms)),credentials=cloudConfig().ima}={}){
 const c=credentials;
 if(!c?.enabled||!c.apiKey||!c.clientId)throw issue('尚未配置 ima 连接。','IMA_NOT_CONFIGURED');
 for(let attempt=0;attempt<3;attempt++){
  try{
  const response=await fetcher('https://ima.qq.com/openapi/wiki/v1/'+method,{method:'POST',headers:{'Content-Type':'application/json','ima-openapi-clientid':c.clientId,'ima-openapi-apikey':c.apiKey},body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000)});
  if((response.status===429||response.status>=500)&&attempt<2){await response.body?.cancel();await sleep(750*(attempt+1));continue}
  if(!response.ok)throw issue('ima 服务返回 '+response.status+'，请检查连接。','IMA_HTTP');
  const value=await response.json();
  if(Number(value.code)===0)return value.data??{};
  if([110021,110010].includes(Number(value.code))&&attempt<2){await sleep(1500*(attempt+1));continue}
  throw issue('ima 检索未完成：'+String(value.msg??'接口未授权').slice(0,160),'IMA_'+value.code);
  }catch(error){
   if(signal?.aborted)throw error;
   if(!String(error.code??'').startsWith('IMA_')&&attempt<2){await sleep(750*(attempt+1));continue}
   if(String(error.code??'').startsWith('IMA_'))throw error;
   throw issue('ima 连接暂未完成，重试后仍不可用。请稍后再试。','IMA_NETWORK');
  }
 }
}
let mapped=null;
try{mapped=JSON.parse(fs.readFileSync(path.join(LOCAL,'cloud-map.json'),'utf8'))}catch{}
function saveMap(){fs.mkdirSync(LOCAL,{recursive:true});fs.writeFileSync(path.join(LOCAL,'cloud-map.json'),JSON.stringify(mapped,null,2));}
export async function mapImaProject(project,{signal,refresh=false}={}){
 const p=projectConfig(project);if(!p)throw issue('该项目尚未接入。','PROJECT_NOT_CONNECTED');
 const config=cloudConfig().ima;
 const cache=mapped?.projects?.[project];
 if(!refresh&&cache&&mapped.clientId===config.clientId&&Date.now()-cache.checkedAt<300000)return cache;
 let bases=[],cursor='';
 do{
  const data=await imaCall('search_knowledge_base',{query:config.knowledgeBaseName||'子城',cursor,limit:20},{signal});
  bases.push(...(data.info_list??[]).map(b=>({...b,id:b.id??b.kb_id,name:b.name??b.kb_name})));cursor=data.next_cursor||'';
  if(data.is_end!==false)break;
 }while(cursor&&bases.length<100);
 const base=bases.find(b=>b.name===config.knowledgeBaseName);
 if(!base)throw issue('ima 中未找到“'+config.knowledgeBaseName+'”知识库。','IMA_BASE_NOT_FOUND');
 const root=await listIma(base.id,undefined,{signal});
 const folder=root.find(item=>normalizeName(item.name??item.title)===normalizeName(p.imaFolder));
 if(!folder)throw issue('ima“'+base.name+'”内未找到项目文件夹“'+p.imaFolder+'”。','IMA_FOLDER_NOT_FOUND');
 const folderId=folder.folder_id??folder.media_id;
 if(!folderId)throw issue('ima 返回的项目目录没有文件夹编号。','IMA_FOLDER_INVALID');
 const folders=[folderId],files=[],queue=[{id:folderId,path:''}];
 while(queue.length){
  const current=queue.shift();
  for(const item of await listIma(base.id,current.id,{signal})){
   const name=item.name??item.title??'';
   if(isExcluded(name))continue;
   if(item.folder_id||Number(item.media_type)===99){const id=item.folder_id??item.media_id;if(!folders.includes(id)){folders.push(id);queue.push({id,path:current.path+name+'/'});}}
   else if(item.media_id)files.push({...item,path:current.path+name});
  }
  if(folders.length>200||files.length>6000)throw issue('项目资料目录超过本次安全读取范围。','IMA_DIRECTORY_LIMIT');
 }
 mapped={...mapped,clientId:config.clientId,knowledgeBaseName:base.name,knowledgeBaseId:base.id,projects:{...mapped?.projects,[project]:{baseId:base.id,folderId,folders,files,checkedAt:Date.now()}}};
 saveMap();return mapped.projects[project];
}
async function listIma(baseId,folderId,{signal}={}){
 let result=[],cursor='';
 do{
  const data=await imaCall('get_knowledge_list',{knowledge_base_id:baseId,cursor,limit:50,...(folderId?{folder_id:folderId}:{})},{signal});
  result.push(...(data.knowledge_list??[]),...(data.folder_list??[]));
  cursor=data.next_cursor||'';if(data.is_end!==false)break;
 }while(cursor&&result.length<6000);
 return result;
}
const plain=value=>String(value??'').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').slice(0,5000);
export async function searchImaDetailed(project,query,{signal,projectMap,call=imaCall,planSearch,localHints=[]}={}){
 const map=projectMap??await mapImaProject(project,{signal});
 const files=map.files.filter(f=>!isExcluded(f.path));
 const allowed=new Map(files.map(f=>[f.media_id,f]));
 const results=[],seen=new Set(),attempts=[];
 const toDocument=(file,item={})=>({id:'ima-'+file.media_id,mediaId:file.media_id,name:file.title??file.name,path:file.path,source:'ima',project,type:path.extname(file.title??file.name??'').slice(1).toLowerCase()||'txt',category:'云端资料',status:item.highlight_content?'indexed':'catalog',size:0,partial:true,chunks:item.highlight_content?[{location:'ima 检索匹配片段',text:plain(item.highlight_content)}]:[]});
 let plan=null,plannerFailed=false;
 if(planSearch&&files.length){
  try{plan=await planSearch({question:query,project,files})}catch(error){if(signal?.aborted)throw error;plannerFailed=true}
 }
 const proposed=(Array.isArray(plan?.queries)?plan.queries:[]).filter(q=>typeof q==='string'&&q.trim().length>=2&&q.length<=80).flatMap(q=>q.trim().split(/[\s,，、;；]+/)).filter(q=>q.length>=2);
 const firstSelected=(Array.isArray(plan?.mediaIds)?plan.mediaIds:[]).map(id=>allowed.get(id)).find(Boolean);
 // Probe an actual selected filename as well as content terms. A field such as
 // "开工日期" need not occur in any title, while "开工报告" is a real cloud file.
 const filenameProbe=firstSelected?String(firstSelected.title??firstSelected.name).replace(/\.[^.]+$/,'').slice(0,180):null;
 const queries=[...new Set([proposed[0],filenameProbe,...proposed.slice(1),...planImaQueries(query,files)].filter(Boolean))].slice(0,3);
 for(const term of queries){
  let cursor='',scanned=0,count=0;
  do{
  const data=await call('search_knowledge',{knowledge_base_id:map.baseId,query:term,cursor},{signal});
  for(const item of data.info_list??[]){
   const file=allowed.get(item.media_id);
   if(!file||isExcluded(file.path))continue;
   count++;
   if(!seen.has(file.media_id)){seen.add(file.media_id);results.push(toDocument(file,item))}
  }
  scanned+=(data.info_list??[]).length;
  cursor=data.next_cursor||'';if(data.is_end!==false||results.length>=8)break;
  }while(cursor&&scanned<300);
  attempts.push({query:term,count,method:'search'});
  if(results.length)break;
 }
 const searchCount=results.length;
 const searchDocuments=results.slice(),searchById=new Map(searchDocuments.map(d=>[d.mediaId,d]));
 results.length=0;seen.clear();
 const addCatalog=(candidates,label,method)=>{
  let added=0;
  for(const file of candidates){
   if(results.length>=8)break;
   if(!allowed.has(file.media_id)||seen.has(file.media_id))continue;
   seen.add(file.media_id);results.push(searchById.get(file.media_id)??toDocument(file));if(!searchById.has(file.media_id))added++;
  }
  if(added)attempts.push({query:label,count:added,method});
 };
 // Semantic selection is strictly a candidate list from the actual cloud folder.
 // Never present catalog selection or local mirror text as ima content matches.
 addCatalog((Array.isArray(plan?.mediaIds)?plan.mediaIds:[]).map(id=>allowed.get(id)).filter(Boolean),'模型按问题选择云端文件','selection');
 const confirmedHints=[];
 for(const hint of localHints){
  if(hint.project!==project||hint.imported)continue;
  const exact=files.find(f=>normalizeName(f.path)===normalizeName(hint.path));
  const sameName=files.filter(f=>normalizeName(f.title??f.name)===normalizeName(hint.name));
  const file=exact??(sameName.length===1?sameName[0]:null);
  if(file)confirmedHints.push(file);
 }
 addCatalog(confirmedHints,'本地检索线索在 ima 目录确认','mirror');
 for(const doc of searchDocuments){if(results.length>=8)break;if(!seen.has(doc.mediaId)){seen.add(doc.mediaId);results.push(doc)}}
 // The cloud directory is useful even for files not yet indexed by ima. Label it
 // separately: a filename match is not evidence from the document's contents.
 if(!results.length){
  for(const term of queries){
   const matching=files.filter(f=>normalizeName(f.path).includes(normalizeName(term))).slice(0,8);
   if(matching.length){addCatalog(matching,term,'catalog');break}
  }
 }
 return {documents:results.slice(0,8),attempts,searchCount,plannerUsed:!!plan,plannerFailed,catalogCount:files.length};
}
export async function searchIma(project,query,options={}){return (await searchImaDetailed(project,query,options)).documents}
export async function imaMedia(project,mediaId,{signal}={}){
 const map=await mapImaProject(project,{signal});
 if(!map.files.some(f=>f.media_id===mediaId))throw issue('不允许读取当前项目以外的云端文件。','PROJECT_SCOPE');
 return imaCall('get_media_info',{media_id:mediaId},{signal});
}
export function cloudStatus(){
 const c=cloudConfig();
 return {ima:{configured:!!(c.ima?.apiKey&&c.ima?.clientId),knowledgeBaseName:c.ima?.knowledgeBaseName??'子城',projects:Object.entries(mapped?.projects??{}).map(([id,p])=>({id,files:p.files.length,checkedAt:new Date(p.checkedAt).toISOString()}))},baidu:{configured:!!(c.baidu?.appKey&&c.baidu?.secretKey),connected:!!c.baidu?.accessToken,root:c.baidu?.root??'/AI'},requiredIma:c.requiredIma!==false};
}
