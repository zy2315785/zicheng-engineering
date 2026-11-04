import {randomUUID} from 'node:crypto';
import {cloudConfig,saveCloudConfig} from './cloud-sources.mjs';
import {projectConfig,normalizeName,isExcluded} from './project-files.mjs';
const pending=new Map();
const fail=(message,code='BAIDU_ERROR')=>Object.assign(new Error(message),{code,status:code==='BAIDU_AUTH_REQUIRED'?409:502});
export async function baiduRequest(url,options={}, {fetcher=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 for(let attempt=0;attempt<3;attempt++){
  try{
   const response=await fetcher(url,options);
   if((response.status===429||response.status>=500)&&attempt<2){await response.body?.cancel();await sleep(500*(attempt+1));continue}
   return response;
  }catch(error){
   if(options.signal?.aborted)throw error;
   if(attempt===2)throw fail('百度网盘网络连接暂未完成，请稍后重试。','BAIDU_NETWORK');
   await sleep(500*(attempt+1));
  }
 }
}
async function oauth(params,{signal}={}){
 const url=new URL('https://openapi.baidu.com/oauth/2.0/'+(params.response_type?'device/code':'token'));
 for(const [key,value] of Object.entries(params))url.searchParams.set(key,String(value));
 url.searchParams.set('openapi','xpansdk');
 let r;
 for(let attempt=0;attempt<3;attempt++){
  try{r=await fetch(url,{headers:{'User-Agent':'pan.baidu.com','Accept':'application/json'},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});break}
  catch(error){if(signal?.aborted||attempt===2)throw fail('无法连接百度官方授权服务（'+(error.cause?.code??error.name)+'）。请稍后重试。','BAIDU_NETWORK');await new Promise(r=>setTimeout(r,500))}
 }
 const data=await r.json().catch(()=>null);
 if(!r.ok&&!data?.error)throw fail('百度授权服务返回 '+r.status+'，请稍后重试。');
 return data??{};
}
export async function startBaiduAuth(){
 const c=cloudConfig().baidu;
 if(!c?.appKey||!c.secretKey)throw fail('请先配置百度网盘应用凭证。','BAIDU_NOT_CONFIGURED');
 const data=await oauth({response_type:'device_code',client_id:c.appKey,scope:'basic,netdisk'});
 if(!data.device_code)throw fail('百度网盘未能创建授权：'+String(data.error_description??data.error??'请核对 AppKey').slice(0,120));
 for(const [id,p] of pending)if(p.expires<Date.now())pending.delete(id);
 const id=randomUUID();
 pending.set(id,{code:data.device_code,expires:Date.now()+data.expires_in*1000,lastPoll:0,interval:Math.max(5,Number(data.interval)||5)*1000});
 return {id,userCode:data.user_code,verificationUrl:data.verification_url,qrUrl:data.qrcode_url,expiresIn:data.expires_in,interval:Math.max(5,Number(data.interval)||5)};
}
function persistTokens(data){
 const c=cloudConfig();
 c.baidu={...c.baidu,accessToken:data.access_token,refreshToken:data.refresh_token||c.baidu.refreshToken,expiresAt:Date.now()+Number(data.expires_in)*1000};
 saveCloudConfig(c);
}
export async function pollBaiduAuth(id){
 const p=pending.get(id);
 if(!p||p.expires<Date.now()){pending.delete(id);return {state:'expired',message:'授权已过期，请重新开始。'}}
 if(Date.now()-p.lastPoll<p.interval)return {state:'pending'};
 p.lastPoll=Date.now();
 const c=cloudConfig().baidu;
 const data=await oauth({grant_type:'device_token',code:p.code,client_id:c.appKey,client_secret:c.secretKey});
 if(data.access_token){persistTokens(data);pending.delete(id);return {state:'ready',message:'百度网盘已连接。'}}
 if(['authorization_pending','slow_down'].includes(data.error))return {state:'pending'};
 pending.delete(id);throw fail('百度授权未完成：'+String(data.error_description??data.error??'请重试').slice(0,160));
}
async function token({signal}={}){
 const c=cloudConfig().baidu;
 if(c?.accessToken&&(!c.expiresAt||Date.now()<c.expiresAt-60000))return c.accessToken;
 if(c?.refreshToken){
  const data=await oauth({grant_type:'refresh_token',refresh_token:c.refreshToken,client_id:c.appKey,client_secret:c.secretKey},{signal});
  if(data.access_token){persistTokens(data);return data.access_token;}
 }
 throw fail('请先在网页“云端连接”中完成百度网盘首次授权，再下载原件。','BAIDU_AUTH_REQUIRED');
}
async function pan(endpoint,params,{signal}={}){
 const access=await token({signal});
 const url=new URL('https://pan.baidu.com/rest/2.0/xpan/'+endpoint);
 url.search=new URLSearchParams({...params,access_token:access}).toString();
 const r=await baiduRequest(url,{headers:{'User-Agent':'pan.baidu.com'},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
 if(!r.ok)throw fail('百度网盘接口返回 '+r.status+'。');
 const data=await r.json();
 if(Number(data.errno)!==0)throw fail([110,111,-6].includes(Number(data.errno))?'百度网盘授权已失效，请重新连接。':'百度网盘读取失败，错误码 '+data.errno+'。',[110,111,-6].includes(Number(data.errno))?'BAIDU_AUTH_REQUIRED':'BAIDU_ERROR');
 return data;
}
async function list(dir,{signal}={}){
 const files=[];
 for(let start=0;start<10000;start+=1000){
  const data=await pan('file',{method:'list',dir,order:'name',start,limit:1000},{signal});
  files.push(...(data.list??[]));if((data.list??[]).length<1000)break;
 }
 return files;
}
export function validateRelative(value){
 const parts=String(value??'').replace(/\\/g,'/').split('/');
 if(!parts.length||parts.some(p=>!p||p==='.'||p==='..'||p.includes('\0'))||isExcluded(value))throw fail('不允许下载项目范围外的文件。','PROJECT_SCOPE');
 return parts;
}
export async function locateBaiduFile(doc,{signal}={}){
 const p=projectConfig(doc.project);if(!p)throw fail('该项目未接入。','PROJECT_SCOPE');
 const parts=validateRelative(doc.path);
 const root=cloudConfig().baidu?.root||'/AI';
 let directory=root.replace(/\/$/,'');
 let found;
 for(const [index,name] of [p.baiduFolder,...parts].entries()){
  const children=await list(directory,{signal});
  const matches=children.filter(f=>normalizeName(f.server_filename)===normalizeName(name));
  if(matches.length!==1)throw fail(matches.length?'百度网盘中存在同名资料，请先核对目录。':'百度网盘未找到对应文件：'+name,'BAIDU_FILE_NOT_FOUND');
  found=matches[0];
  if(!String(found.path).startsWith(root+'/'))throw fail('百度网盘返回了项目目录外的文件。','PROJECT_SCOPE');
  if(index<[p.baiduFolder,...parts].length-1&&!found.isdir)throw fail('百度网盘目录结构不匹配。','PROJECT_SCOPE');
  directory=found.path;
 }
 if(!found||found.isdir)throw fail('该条目是文件夹，不能作为文件下载。');
 return found;
}
export function allowedDownloadURL(raw){
 const u=new URL(raw);
 const allowed=['baidu.com','baidupcs.com','bcebos.com','baidubce.com'];
 if(u.protocol!=='https:'||u.username||u.password||!allowed.some(d=>u.hostname===d||u.hostname.endsWith('.'+d)))throw fail('网盘返回的下载地址不在官方域名范围。','DOWNLOAD_HOST');
 return u;
}
export async function fetchBaiduFile(doc,{signal,range}={}){
 const file=await locateBaiduFile(doc,{signal});
 const data=await pan('multimedia',{method:'filemetas',fsids:JSON.stringify([file.fs_id]),dlink:'1'},{signal});
 const info=data.list?.find(f=>String(f.fs_id)===String(file.fs_id));
 if(!info?.dlink)throw fail('百度网盘未返回可用下载地址。');
 if(info.path&&info.path!==file.path)throw fail('网盘下载信息与所选文件不一致。','PROJECT_SCOPE');
 let url=allowedDownloadURL(info.dlink);
 const access=await token({signal});
 for(let redirects=0;redirects<6;redirects++){
  // Only the official CDN receives the user's access token; it never reaches the browser.
  url.searchParams.set('access_token',access);
  const response=await baiduRequest(url,{redirect:'manual',headers:{'User-Agent':'pan.baidu.com',...(range?{Range:range}:{})},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});
  if([301,302,303,307,308].includes(response.status)){
   const next=response.headers.get('location');await response.body?.cancel();
   if(!next)throw fail('网盘下载重定向无效。');url=allowedDownloadURL(new URL(next,url));continue;
  }
  if(!response.ok)throw fail('百度网盘下载返回 '+response.status+'。');
  return {response,file};
 }
 throw fail('网盘下载重定向次数过多。');
}
