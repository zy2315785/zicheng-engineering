import {PROJECTS} from './projects.js';
import {escapeHtml as e} from './search.js';

export function fileLocation(doc,{root='/AI'}={}){
 const project=PROJECTS.find(p=>p.id===doc?.project&&p.connected);
 if(!project||doc.imported||!doc.path)return null;
 const parts=String(doc.path).replaceAll('\\','/').split('/');
 if([project.folder,project.imaFolder,project.baiduFolder].includes(parts[0]))parts.shift();
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
  const group=groups.get(key);group.refs.push(source.citation??index+1);
  if(source.chunk?.location)group.locations.add(source.chunk.location+(source.doc.source==='index-cache'?'（文字缓存）':''));
 });
 if(!groups.size)return '';
 return '<section class="source-locations" aria-label="回答依据的文件位置"><div class="source-location-heading">文件位置 <span>ima · 原件可追溯</span></div>'+[...groups.values()].map(({doc,refs,locations})=>{
  const location=fileLocation(doc,{root});
  const content='<span class="location-refs">'+refs.map(n=>'<span class="citation-number">'+n+'</span>').join('')+'</span><span class="location-copy"><strong>'+e(doc.name)+'</strong><small>'+e([...locations].join(' · ')||'文件目录')+'</small><span class="location-path">'+e(location?.path??'ima 云端 · 可直接下载')+'</span></span>';
  return '<div class="source-location-row"><div class="source-location">'+content+'</div>'+(doc.id?'<a class="location-download" href="/api/file?id='+encodeURIComponent(doc.id)+'&name='+encodeURIComponent(doc.name)+'" target="_blank" rel="noopener" aria-label="从 ima 下载 '+e(doc.name)+'">下载原件 <span class="download-arrow" aria-hidden="true">↓</span></a>':'')+'</div>';
 }).join('')+'</section>';
}
