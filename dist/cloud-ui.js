let status=null,ui={},poll=null;
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function initCloudUI(options){ui=options}
export function baiduRoot(){return status?.baidu?.root??'/AI'}
export async function refreshCloudStatus(){
 try{const r=await fetch('/api/cloud/status');if(!r.ok)throw new Error();status=await r.json()}catch{status=null}
 return status;
}
export function cloudBadge(project){
 if(!status)return '项目资料检索';
 const linked=status.ima?.projects?.some(p=>p.id===project);
 return (linked?'ima 已连接':status.ima?.configured?'ima 待验证':'ima 未配置')+' · '+(status.model?.installed?'深度思考 · 高':'模型未配置');
}
async function post(url,body={}){
 const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const value=await r.json();
 if(!r.ok||value.ok===false)throw new Error(value.message||'连接未完成，请稍后重试。');
 return value;
}
export async function openCloudSettings(){
 clearInterval(poll);await refreshCloudStatus();
 if(!status){ui.modal('云端连接','<p>当前页面未连接工程助手后台。请双击 AI 文件夹中的“启动工程助手”，在本地网页配置连接。</p>','',true);return}
 ui.modal('云端连接与模型设置',
 '<p class="form-note">检索 ima“子城”中的当前项目目录，原件下载访问百度网盘 /AI。密钥仅保存到本机后台。</p>'+
 '<div class="connection-summary"><p>'+escape(cloudBadge(ui.getProject()))+'</p><button class="button" data-cloud="check">验证当前项目 ima</button> <button class="button primary" data-cloud="baidu">连接百度网盘</button><p id="cloud-message" role="status"></p><div id="baidu-auth"></div></div>'+
 '<details class="connection-settings"><summary>修改连接配置（已配置的密钥留空即可保留）</summary><form id="cloud-settings-form" autocomplete="off">'+
 [['modelBase','模型 API 地址','url','https://api.deepseek.com/v1'],['model','模型名称','text','deepseek-flash'],['modelKey','模型 API Key','password',''],['imaClientId','ima Client ID','password',''],['imaApiKey','ima API Key','password',''],['baiduAppKey','百度网盘 AppKey','password',''],['baiduSecretKey','百度网盘 SecretKey','password','']].map(([name,label,type,value])=>'<label class="connection-field">'+label+'<input name="'+name+'" type="'+type+'" value="'+escape(value)+'" autocomplete="off" spellcheck="false"/></label>').join('')+
 '<p class="form-note">模型启用思考模式，强度“高”；支持多轮查找、原文读取、翻页与扫描页 OCR。</p><button class="button primary" type="submit">保存后台配置</button></form></details>','',true);
}
function message(text){const node=document.querySelector('#cloud-message');if(node)node.textContent=text}
document.addEventListener('submit',async event=>{
 if(event.target.id!=='cloud-settings-form')return;
 event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;
 try{await post('/api/settings',Object.fromEntries(new FormData(event.target)));event.target.reset();await openCloudSettings();message('配置已保存，请验证 ima，并完成百度网盘授权。')}catch(e){message(e.message)}finally{button.disabled=false}
});
document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-cloud]');if(!button)return;
 const action=button.dataset.cloud;
 if(action==='open')return openCloudSettings();
 if(action==='download'){
  if(status?.baidu?.connected)return;
  event.preventDefault();
  await openCloudSettings();message('请先连接百度网盘，完成后即可下载原件。');return;
 }
 button.disabled=true;
 try{
  if(action==='check'){message('正在核对当前项目 ima 目录…');const value=await post('/api/cloud/check',{project:ui.getProject()});message('ima 已连接，当前项目可访问 '+value.files+' 份文件。');await refreshCloudStatus()}
  if(action==='baidu'){
   const auth=await post('/api/cloud/baidu/start');
   const url=new URL(auth.verificationUrl);
   if(url.protocol!=='https:'||!(url.hostname==='baidu.com'||url.hostname.endsWith('.baidu.com')))throw new Error('授权地址无效。');
   const target=document.querySelector('#baidu-auth');
   target.innerHTML='<div class="baidu-auth"><strong>首次连接需要你在百度官方页面完成授权</strong><p>授权码：<b class="auth-code">'+escape(auth.userCode)+'</b></p><a class="button primary" href="'+escape(url.href)+'" target="_blank" rel="noopener noreferrer">打开百度官方授权页</a><p class="form-note">输入以上授权码，登录并确认。此页面会自动检查授权结果，凭证不会显示在网页上。</p></div>';
   message('等待百度网盘授权…');clearInterval(poll);
   const expires=Date.now()+auth.expiresIn*1000;
   poll=setInterval(async()=>{
    if(!document.querySelector('#baidu-auth')||Date.now()>expires){clearInterval(poll);return}
    try{const value=await post('/api/cloud/baidu/poll',{id:auth.id});if(value.state==='ready'){clearInterval(poll);await refreshCloudStatus();message('百度网盘已连接，原件下载已就绪。');target.innerHTML=''}else if(value.state==='expired'){clearInterval(poll);message(value.message)}}catch(e){clearInterval(poll);message(e.message)}
   },auth.interval*1000);
  }
 }catch(e){message(e.message)}finally{button.disabled=false}
});
