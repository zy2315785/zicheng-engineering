import {PROJECTS} from './projects.mjs';
import {escapeHtml as e} from './search.mjs';

export function fileLocation(doc,{root='/AI'}={}){
 const project=PROJECTS.find(p=>p.id===doc?.project&&p.connected);
 if(!project||doc.imported||!doc.path)return null;
 const parts=String(doc.path).replaceAll('\\','/').split('/');
 const rootParts=String(root).split('/').filter(Boolean);
 if(!parts.length||[...rootParts,project.baiduFolder,...parts].some(p=>!p||p==='.'||p==='..'||/[\u0000-\u001f]/.test(p)))return null;
 const fullPath='/'+[...rootParts,project.baiduFolder,...parts].join('/');
 const folder=fullPath.slice(0,fullPath.lastIndexOf('/'));
 return {path:fullPath,folder};
}

export function sourceLocations(sources=[],{root='/AI'}={}){
 const groups=new Map();
 sources.forEach((source,index)=>{
  const key=source.doc.project+'|'+source.doc.path+'|'+source.doc.id;
  if(!groups.has(key))groups.set(key,{doc:source.doc,refs:[],locations:new Set()});
  const group=groups.get(key);group.refs.push(index+1);
  if(source.chunk?.location)group.locations.add(source.chunk.location);
 });
 if(!groups.size)return '';
 return '<section class="source-locations" aria-label="回答依据的文件位置"><div class="source-location-heading">文件位置 <span>百度网盘 · 原件可追溯</span></div>'+[...groups.values()].map(({doc,refs,locations})=>{
  const location=fileLocation(doc,{root});
  const content='<span class="location-refs">'+refs.map(n=>'<span class="citation-number">'+n+'</span>').join('')+'</span><span class="location-copy"><strong>'+e(doc.name)+'</strong><small>'+e([...locations].join(' · ')||'文件目录')+'</small><span class="location-path">'+e(location?.path??'浏览器临时导入 · 尚无网盘位置')+'</span></span>';
  return '<div class="source-location-row"><div class="source-location">'+content+'</div>'+(location?'<a class="location-download" href="/api/download/'+encodeURIComponent(doc.id)+'" target="_blank" rel="noopener" data-cloud="download" aria-label="从百度网盘下载 '+e(doc.name)+'">下载原件 <span class="download-arrow" aria-hidden="true">↓</span></a>':'')+'</div>';
 }).join('')+'</section>';
}
