import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {searchDocuments} from './dist/search.js';
import {buildAgentPrompt,todayLabel} from './prompt.mjs';
import {createKnowledgeTools,TOOLS} from './knowledge-tools.mjs';
import {retrievalPlanMessages,parseRetrievalPlan} from './retrieval-plan.mjs';

/** DeepSeek reasoning with project-scoped ima search, local reads and Baidu originals. */
export const APP_ROOT=path.dirname(fileURLToPath(import.meta.url));
const LOCAL=path.join(APP_ROOT,'.local');
const CONFIG_FILE=path.join(LOCAL,'api-config.json');

export const DEFAULTS={
 provider:'deepseek',
 name:'DeepSeek',
 base:'https://api.deepseek.com/v1',
 model:'deepseek-flash',
 timeout:240000,
 agent:true,
 maxSteps:6
};

export const AGENT_MAX_STEPS=DEFAULTS.maxSteps;
const SOURCE_LIMIT=10;

let cached=null,cachedMtime=0,lastConnection={state:'unchecked',message:'尚未发起过 API 问答'},running=false;

const clean=v=>String(v??'').trim().replace(/\/+$/,'');

export function readApiConfig(){
 let stat=null;
 try{stat=fs.statSync(CONFIG_FILE)}catch{}
 if(cached&&stat&&stat.mtimeMs===cachedMtime)return cached;
 let file={};
 if(stat){try{file=JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8'))}catch{}}
 const enabled=v=>v===undefined||v===null?true:!(v===false||/^(0|false|off|no)$/i.test(String(v).trim()));
 const steps=Number(process.env.ZC_AGENT_STEPS||file.maxSteps||DEFAULTS.maxSteps);
 const config={
  provider:clean(process.env.ZC_API_PROVIDER||file.provider)||DEFAULTS.provider,
  name:clean(process.env.ZC_API_NAME||file.name)||DEFAULTS.name,
  base:clean(process.env.ZC_API_BASE||file.base)||DEFAULTS.base,
  model:clean(process.env.ZC_API_MODEL||file.model)||DEFAULTS.model,
  timeout:Number(process.env.ZC_MODEL_TIMEOUT||file.timeout||DEFAULTS.timeout),
  key:clean(process.env.ZC_API_KEY||file.key),
  agent:enabled(process.env.ZC_AGENT??file.agent),
  maxSteps:Number.isFinite(steps)&&steps>0?Math.min(steps,8):DEFAULTS.maxSteps,
  thinking:file.thinking!==false,
  effort:process.env.ZC_REASONING_EFFORT||file.effort||'high',
  maxTokens:Math.min(32768,Math.max(4096,Number(file.maxTokens)||16384))
 };
 if(!Number.isFinite(config.timeout)||config.timeout<5000)config.timeout=DEFAULTS.timeout;
 cached=config;cachedMtime=stat?.mtimeMs??0;
 return config;
}

/** Use the configured API, otherwise show local retrieval only. */
export function activeProvider(){return readApiConfig().key?'api':'local';}

/** 模型常写出不存在的编号，越界的标注直接剥掉，来源卡片以服务端 sources 为准。 */
export function normalizeCitations(text,count){
 if(!count)return String(text??'').replace(/\[\d{1,2}\]/g,'');
 return String(text??'').replace(/\[(\d{1,2})\]/g,(whole,num)=>{
  const index=Number(num);
  return index>=1&&index<=count?whole:'';
 }).replace(/[ \t]{2,}/g,' ');
}

/** 模型偶尔会把编号写串。用引用前面最近的文名反查真实编号并改写。 */
export function reconcileCitations(text,sources=[]){
 if(!sources.length)return String(text??'');
 const frequency=new Map();
 for(const source of sources){const name=String(source?.doc?.name??'').replace(/\.[^.]+$/,'').trim();frequency.set(name,(frequency.get(name)??0)+1)}
 const names=sources
  .map((s,i)=>({i,name:String(s?.doc?.name??'').replace(/\.[^.]+$/,'').trim()}))
  .filter(x=>x.name.length>=2&&frequency.get(x.name)===1)
  .sort((a,b)=>b.name.length-a.name.length);
 if(!names.length)return String(text??'');
 return String(text).replace(/\[(\d{1,2})\]/g,(whole,num,offset,all)=>{
  const before=all.slice(Math.max(0,offset-120),offset);
  let best=null,bestAt=-1;
  for(const item of names){
   const at=before.lastIndexOf(item.name);
   if(at>bestAt||(at===bestAt&&at>=0&&best&&item.name.length>best.name.length)){bestAt=at;best=item}
  }
  if(!best||bestAt<0)return whole;
  const want=best.i+1;
  return want===Number(num)?whole:`[${want}]`;
 });
}

/** 只保留真正被引用到的来源，并把编号压成连续序号。 */
export function trimToCited(text,sources=[]){
 const cited=new Set([...String(text??'').matchAll(/\[(\d{1,2})\]/g)]
  .map(m=>Number(m[1])).filter(n=>n>=1&&n<=sources.length));
 if(!cited.size)return {text:String(text??''),sources};
 const kept=[],map=new Map();
 sources.forEach((source,index)=>{
  if(cited.has(index+1)){kept.push(source);map.set(index+1,kept.length)}
 });
 const rewritten=String(text).replace(/\[(\d{1,2})\]/g,(whole,num)=>{
  const next=map.get(Number(num));
  return next?`[${next}]`:whole;
 });
 return {text:rewritten,sources:kept};
}

/** 回答与来源一起收口：按文名纠偏 → 剥越界编号 → 去重 → 只留被引用的。 */
export function bindCitations(text,sources=[]){
 const t1=reconcileCitations(text,sources);
 const t2=normalizeCitations(t1,sources.length).replace(/(\[\d{1,2}\])(?:\s*\1)+/g,'$1');
 return trimToCited(t2,sources);
}

function logFailure(detail){
 try{
  fs.mkdirSync(LOCAL,{recursive:true});
  const file=path.join(LOCAL,'api.log');
  fs.appendFileSync(file,`[${new Date().toISOString()}] ${detail}\n\n`);
  try{if(fs.statSync(file).size>256000)fs.writeFileSync(file,detail)}catch{}
 }catch{}
}

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function classify(status,body){
 const tail=String(body??'').slice(0,300);
 if(status===401||status===403)return {code:'AUTH_REQUIRED',message:'API 密钥无效或已失效，请检查 .local/api-config.json 中的 key。'};
 if(status===402||/insufficient|balance|quota|余额/i.test(tail))return {code:'QUOTA',message:'API 账户余额不足，请先充值后重试。'};
 if(status===429)return {code:'RATE_LIMIT',message:'API 调用过于频繁或并发超限，请稍后重试。'};
 if(status===400&&/model/i.test(tail))return {code:'MODEL_UNAVAILABLE',message:`API 不接受模型“${readApiConfig().model}”，请修改 .local/api-config.json 中的 model 字段。`};
 if(status===400&&/context|too long|length|token/i.test(tail))return {code:'CONTEXT_OVERFLOW',message:'本次检索内容超出模型上下文上限，请把问题问得更具体一些。'};
 return {code:'API_ERROR',message:`模型接口返回 ${status}，请核对模型配置或稍后重试。`};
}

async function chat(config,messages,{signal,attempt=0,tools,toolChoice,deadline}={}){
 const remaining=deadline?deadline-Date.now():config.timeout;
 if(remaining<=0)return {ok:false,code:'TIMEOUT',message:'本次分析已达到时间上限，请缩小问题范围后重试。'};
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),Math.min(config.timeout,remaining));
 const forward=()=>controller.abort();
 signal?.addEventListener('abort',forward,{once:true});
 try{
  const payload={model:config.model,max_tokens:config.maxTokens,messages};
  if(config.thinking){payload.thinking={type:'enabled'};payload.reasoning_effort=config.effort}else payload.temperature=0.2;
  if(tools?.length){payload.tools=tools;payload.tool_choice=toolChoice??'auto'}
  const res=await fetch(`${config.base}/chat/completions`,{
   method:'POST',
   headers:{'Content-Type':'application/json','Authorization':`Bearer ${config.key}`},
   body:JSON.stringify(payload),
   signal:controller.signal
  });
  if((res.status===429||res.status>=500)&&attempt<1&&!signal?.aborted){
   await delay(1200);
   return chat(config,messages,{signal,attempt:attempt+1,tools,toolChoice,deadline});
  }
  if(!res.ok){
   const body=await res.text().catch(()=>'');
   const error=classify(res.status,body);
   logFailure(`status=${res.status} code=${error.code}`);
   return {ok:false,...error};
  }
  let data;
  try{data=await res.json()}catch{return {ok:false,code:'API_ERROR',message:'API 返回内容不是合法 JSON。'}}
  const message=data?.choices?.[0]?.message;
  if(!message)return {ok:false,code:'EMPTY',message:'API 返回了空结果，请稍后重试。'};
  return {ok:true,message,finishReason:data.choices[0].finish_reason,reportedModel:data.model??config.model,usage:data.usage??null};
 }catch(error){
  if(signal?.aborted)return {ok:false,code:'CANCELLED',message:'请求已取消。'};
  if(controller.signal.aborted)return {ok:false,code:'TIMEOUT',message:`API 超过 ${Math.round(Math.min(config.timeout,remaining)/1000)} 秒没有返回，请稍后重试。`};
  if(attempt<1&&/fetch failed|network|ECONN|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|socket/i.test(String(error.message))&&(!deadline||Date.now()+1000<deadline)){
   await delay(750);return chat(config,messages,{signal,attempt:attempt+1,tools,toolChoice,deadline});
  }
  const message=/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|network/i.test(String(error.message))
   ?'无法连接 API 服务，请检查本机网络或代理设置。'
   :`API 调用失败：${error.message}`;
  logFailure(`code=CONNECTION_FAILED ${error.message}`);
  return {ok:false,code:'CONNECTION_FAILED',message};
 }finally{
  clearTimeout(timer);
  signal?.removeEventListener('abort',forward);
 }
}

function briefSources(raw){
 return raw.map(({doc,...rest})=>{
  if(!doc)return null;
  const {chunks,...metadata}=doc;
  return {...rest,doc:metadata};
 }).filter(Boolean);
}

export async function planImaRetrieval({question,project,files},{configuration=readApiConfig(),signal,deadline,request=chat}={}){
 // This bounded routing call selects documents; the answer still uses high reasoning.
 const result=await request({...configuration,thinking:false,maxTokens:1800,timeout:30000},retrievalPlanMessages(question,project,files),{signal,deadline});
 if(!result.ok)throw Object.assign(new Error('问题拆解暂未完成。'),{code:'PLAN_'+result.code});
 try{return parseRetrievalPlan(result.message.content,files)}catch{throw Object.assign(new Error('问题拆解返回格式不完整。'),{code:'PLAN_FORMAT'})}
}

function unavailable(documents,question,{project},{message,code}){
 const sources=briefSources(searchDocuments(documents,question,{project,limit:6}));
 return {kind:'unavailable',text:message+'\n以下仅展示本地检索结果，尚未得到模型回答。',sources,model:{provider:'本机检索',connected:false,name:'关键词检索'},error:code};
}

/** Model reasoning + cloud search + on-demand original-file reads. */
export async function askWithAgent(documents,question,{project='ruibang',history=[],signal,configuration,knowledgeFactory=createKnowledgeTools}={}){
 const config=configuration??readApiConfig();
 const modelMeta={provider:config.name,connected:false,name:config.model,effort:config.effort,thinking:config.thinking};
 if(!config.key)return {kind:'unavailable',text:'尚未配置模型 API，以下仅为本地检索结果。',sources:briefSources(searchDocuments(documents,question,{project,limit:5})),model:modelMeta,error:'NO_KEY'};
 if(running)return {kind:'unavailable',text:'还有一个问题正在分析，请稍后重试。',sources:[],model:modelMeta,error:'BUSY'};
 running=true;
 let knowledge;
 try{
  const deadline=Date.now()+config.timeout;
  knowledge=knowledgeFactory(documents,{project,signal,today:Date.parse(todayLabel().slice(0,10)+'T00:00:00+08:00'),planSearch:input=>planImaRetrieval(input,{configuration:config,signal,deadline})});
  // Every question performs a real ima query before the first model request.
  const initial=await knowledge.search(question);
  const messages=[
   {role:'system',content:buildAgentPrompt({project,today:todayLabel(),history,maxSteps:config.maxSteps})},
   {role:'user',content:question+'\n\n<本次资料预检索>\n'+initial+'\n</本次资料预检索>'}
  ];
  let usage=null,reportedModel=config.model;
  const finish=text=>{
   const bound=bindCitations(text,knowledge.ctx.sources);
   lastConnection={state:'ready',message:'深度思考与资料工具调用正常',verifiedAt:new Date().toISOString(),reportedModel};
   return {kind:'generated',text:bound.text,sources:bound.sources,trace:knowledge.ctx.trace,model:{...modelMeta,connected:true,reportedModel,usage},cloudChecked:knowledge.ctx.cloudChecked};
  };
  for(let step=0;step<=config.maxSteps;step++){
   const final=step===config.maxSteps;
   if(final)messages.push({role:'user',content:'已达到本次查阅轮数。请依据现有证据完成回答，并说明尚未查清的部分，不再调用工具。'});
   const result=await chat(config,messages,{signal,tools:TOOLS,toolChoice:final?'none':'auto',deadline});
   if(!result.ok)throw Object.assign(new Error(result.message),{code:result.code});
   usage=mergeUsage(usage,result.usage);reportedModel=result.reportedModel;
   const message=result.message;
   const calls=Array.isArray(message.tool_calls)?message.tool_calls:[];
   if(!calls.length){
    const text=String(message.content??'').trim();
    if(text)return finish(text);
    throw Object.assign(new Error(result.finishReason==='length'?'模型本次推理达到输出上限，尚未形成完整答案，请缩小问题范围重试。':'模型没有返回可用答案。'),{code:'EMPTY'});
   }
   // Keep provider reasoning_content intact between tool rounds. It stays server-side.
   messages.push({...message,role:'assistant',content:message.content??''});
   for(const call of calls.slice(0,6)){
    let output;
    try{output=await knowledge.run(call)}catch(error){output=String(error.message).slice(0,500)}
    messages.push({role:'tool',tool_call_id:call.id,content:output});
   }
   for(const call of calls.slice(6))messages.push({role:'tool',tool_call_id:call.id,content:'本轮工具调用过多，请基于已有证据收敛问题。'});
  }
  throw Object.assign(new Error('本次查阅达到轮数上限，请把问题拆分后重试。'),{code:'STEP_LIMIT'});
 }catch(error){
  const code=error.code??'AGENT_ERROR';
  const message=String(error.message??'问答未能完成。');
  lastConnection={state:code,message};
  return {...unavailable(documents,question,{project},{message,code}),trace:knowledge?.ctx.trace??[],model:modelMeta};
 }finally{running=false}
}
export async function askWithApi(documents,question,options={}){return askWithAgent(documents,question,options);}
export async function resolveAsk(documents,question,options={}){return askWithAgent(documents,question,options);}
function mergeUsage(a,b){
 if(!a)return b??null;if(!b)return a;
 return {prompt_tokens:(a.prompt_tokens??0)+(b.prompt_tokens??0),completion_tokens:(a.completion_tokens??0)+(b.completion_tokens??0),total_tokens:(a.total_tokens??0)+(b.total_tokens??0)};
}
export function apiStatus(){
 const config=readApiConfig();
 return {provider:config.provider+'-api',model:{id:config.model,name:config.model},installed:!!config.key,modelSupported:!!config.key,mode:'Agent · 最多 '+config.maxSteps+' 轮工具调用',thinking:config.thinking,effort:config.effort,connection:config.key?lastConnection:{state:'no-key',message:'尚未配置模型 API。'},busy:running,scope:'当前项目 · ima 检索 + 本地镜像 + 百度网盘原件',parametersNote:'后台保留推理与工具结果；网页仅显示执行步骤、答案和来源。'};
}
