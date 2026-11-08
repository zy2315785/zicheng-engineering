import {json,authorized,unauthorized,getCatalogue,findKnowledgeBase,imaCall,loadIndex} from '../_lib/platform.js';
import {startAgent,advanceAgent,PROJECTS} from '../_lib/agent.js';

export async function onRequest({request,env}) {
 if(env.REQUIRE_AUTH==='1'&&!authorized(request,env))return unauthorized();
 const url=new URL(request.url),route=url.pathname.replace(/\/+$/,'');
 try {
  if(route==='/api/health'){
   const report={ok:true,build:'agent-v3-20261107',runtime:'node-cloud',agent:{multiRound:true,maxRounds:10,thinking:'high',originalReader:true},model:{configured:Boolean(env.DEEPSEEK_API_KEY),name:env.DEEPSEEK_MODEL||'deepseek-flash'},ima:{configured:Boolean(env.IMA_CLIENT_ID&&env.IMA_API_KEY)},indexVersion:2};
   if(url.searchParams.get('check')==='storage')report.index=await Promise.all(Object.keys(PROJECTS).map(async project=>{try{const data=await loadIndex(env,project);return {project,ready:true,files:data.docs.length};}catch{return {project,ready:false};}}));
   return json(report);
  }
  if(route==='/api/documents')return json(await getCatalogue(env,{refresh:url.searchParams.get('refresh')==='1'}));
  if(route==='/api/cloud/status'){
   let ready=false;try{await findKnowledgeBase(env);ready=true;}catch{}
   return json({ima:{configured:Boolean(env.IMA_CLIENT_ID),ready,projects:Object.keys(PROJECTS).map(id=>({id}))},model:{installed:Boolean(env.DEEPSEEK_API_KEY)},baidu:{connected:false}});
  }
  if(route==='/api/ask'||route==='/api/agent/step') {
   if(request.method!=='POST')return json({ok:false,message:'请使用 POST 请求'},405);
   if(Number(request.headers.get('content-length'))>600000)return json({ok:false,message:'请求内容过大'},413);
   const raw=await request.text();if(raw.length>600000)return json({ok:false,message:'请求内容过大'},413);
   let body;try{body=JSON.parse(raw);}catch{return json({ok:false,message:'请求格式无效'},400);}
   return json(route==='/api/ask'?await startAgent(env,body):await advanceAgent(env,body.cursor));
  }
  if(route==='/api/file') {
   const id=url.searchParams.get('id')||'';
   if(!/^[A-Za-z0-9_-]{8,200}$/.test(id))return json({ok:false,message:'文件标识无效'},400);
   // A signed URL is requested only after membership in an enabled project is verified.
   const indexes=await Promise.all(Object.keys(PROJECTS).map(p=>loadIndex(env,p).catch(()=>null)));
   let doc=indexes.flatMap(i=>i?.docs||[]).find(d=>d.mediaId===id);
   if(!doc){const cat=await getCatalogue(env);doc=cat.documents.find(d=>d.id===id&&Object.values(PROJECTS).some(p=>d.folder===p||d.folder.startsWith(p)));}
   if(!doc)return json({ok:false,message:'当前项目中没有该文件'},404);
   const info=await imaCall(env,'get_media_info',{media_id:id}),target=info.url_info?.url;
   if(!target||new URL(target).protocol!=='https:')return json({ok:false,message:'ima 暂未提供原件下载'},404);
   if(!Object.keys(info.url_info.headers||{}).length)return new Response(null,{status:302,headers:{Location:target,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
   const response=await fetch(target,{headers:info.url_info.headers||{},signal:AbortSignal.timeout(25000)});
   if(!response.ok)return json({ok:false,message:'原件下载暂不可用，请重试'},502);
   return new Response(response.body,{headers:{'Content-Type':response.headers.get('content-type')||'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
  return json({ok:false,message:'接口不存在'},404);
 }catch(error){
  // Provider response bodies and signed URLs must never be sent to the browser.
  const safe=/^(请选择|问题不能|后台尚未|问答会话|本次查阅|DeepSeek 调用失败|模型未|模型单轮|模型输出)/.test(error?.message||'');
  return json({ok:false,message:safe?error.message:'资料服务暂不可用，请稍后重试'},502);
 }
}
