import {getDocumentProxy} from 'unpdf';
import {unzipSync,strFromU8} from 'fflate';
import {XMLParser} from 'fast-xml-parser';
import {imaCall} from './platform.js';

const MAX_BYTES=16*1024*1024;
const arr=x=>x==null?[]:Array.isArray(x)?x:[x];
const xml=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@',parseTagValue:false,processEntities:false});
function parseXml(text){if(/<!DOCTYPE|<!ENTITY/i.test(text))throw new Error('不支持含外部实体的文档');return xml.parse(text);}
function strings(value) {
 if(value==null)return ''; if(typeof value!=='object')return String(value);
 if(Array.isArray(value))return value.map(strings).join('');
 return Object.entries(value).filter(([k])=>!k.startsWith('@')).map(([,v])=>strings(v)).join('');
}
export async function downloadOriginal(env,mediaId) {
 const info=await imaCall(env,'get_media_info',{media_id:mediaId});
 const target=info.url_info?.url;
 if(!target||new URL(target).protocol!=='https:')throw new Error('ima 未提供有效原件地址');
 const response=await fetch(target,{headers:info.url_info.headers||{},signal:AbortSignal.timeout(25000)});
 if(!response.ok)throw new Error(`ima 原件下载失败（${response.status}）`);
 if(Number(response.headers.get('content-length'))>MAX_BYTES){await response.body?.cancel();throw new Error('原件超过在线解析的 16MB 限制');}
 const reader=response.body.getReader(),parts=[];let length=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>MAX_BYTES)throw new Error('原件超过在线解析的 16MB 限制');parts.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(length);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length;}return bytes;
}
export async function parseOriginal(bytes,name,{page=1,query=''}={}) {
 const ext=String(name).split('.').pop().toLowerCase();
 if(ext==='pdf') {
  const pdf=await getDocumentProxy(bytes,{maxImageSize:1000000,isEvalSupported:false,disableFontFace:true});
  try {
   const first=Math.min(pdf.numPages,Math.max(1,Number(page)||1)), chunks=[];
   for(let p=first;p<=Math.min(pdf.numPages,first+3);p++) {
    const sheet=await pdf.getPage(p),content=await sheet.getTextContent();
    const text=content.items.map(i=>(i.str||'')+(i.hasEOL?'\n':' ')).join('').trim();
    if(text.length>=20)chunks.push({loc:`第 ${p} 页`,page:p,text:text.slice(0,22000),source:'ima-original'});
    sheet.cleanup();
   }
   return {chunks,totalPages:pdf.numPages,nextPage:first+4<=pdf.numPages?first+4:null};
  } finally {await pdf.destroy();}
 }
 if(ext==='docx'||ext==='xlsx') {
  let inflated=0;
  const zip=unzipSync(bytes,{filter:file=>{
   const wanted=/^(word\/document\.xml|xl\/(sharedStrings\.xml|styles\.xml|workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/sheet\d+\.xml))$/.test(file.name);
   if(!wanted)return false;inflated+=file.originalSize;if(inflated>32*1024*1024)throw new Error('文档解压大小超限');return true;
  }});
  if(ext==='docx') {
   const data=parseXml(strFromU8(zip['word/document.xml']));
   const paragraphs=arr(data['w:document']?.['w:body']?.['w:p']).map(strings).filter(Boolean);
   const tables=arr(data['w:document']?.['w:body']?.['w:tbl']).flatMap(t=>arr(t['w:tr']).map(r=>arr(r['w:tc']).map(strings).join(' | ')));
   const lines=[...paragraphs,...tables],chunks=[];
   for(let i=0;i<lines.length;i+=15)chunks.push({loc:`段落/表格 ${i+1}–${Math.min(lines.length,i+15)}`,text:lines.slice(i,i+15).join('\n').slice(0,16000),source:'ima-original'});
   return {chunks};
  }
  const shared=zip['xl/sharedStrings.xml']?arr(parseXml(strFromU8(zip['xl/sharedStrings.xml'])).sst?.si).map(strings):[];
  const wb=zip['xl/workbook.xml']?parseXml(strFromU8(zip['xl/workbook.xml'])):{};
  const styles=zip['xl/styles.xml']?parseXml(strFromU8(zip['xl/styles.xml'])).styleSheet:{};
  const formats=arr(styles?.numFmts?.numFmt),xfs=arr(styles?.cellXfs?.xf);
  const formatCell=c=>{
   if(c['@t']==='s')return shared[Number(c.v)]??'';
   if(c['@t']==='inlineStr')return strings(c.is);
   const v=c.v??'',format=Number(xfs[Number(c['@s']||0)]?.['@numFmtId']);
   const pattern=String(formats.find(f=>Number(f['@numFmtId'])===format)?.['@formatCode']||'').replace(/"[^"]*"|\[[^\]]*\]/g,'');
   if(v!==''&&Number.isFinite(Number(v))&&((format>=14&&format<=22)||(format>=45&&format<=47)||/[ymd]/i.test(pattern))){
    const day=Number(v)+(String(wb.workbook?.workbookPr?.['@date1904'])==='1'?1462:0);
    return new Date(Math.round((day-25569)*86400000)).toISOString().replace('T',' ').replace(/\.000Z$/,'').slice(0,day%1?19:10);
   }
   return v;
  };
  const rel=zip['xl/_rels/workbook.xml.rels']?arr(parseXml(strFromU8(zip['xl/_rels/workbook.xml.rels'])).Relationships?.Relationship):[];
  const sheets=arr(wb.workbook?.sheets?.sheet),chunks=[];
  for(const [file,content]of Object.entries(zip).filter(([k])=>k.startsWith('xl/worksheets/'))) {
   const sheet=sheets.find(s=>rel.some(r=>r['@Id']===s['@r:id']&&'xl/'+String(r['@Target']).replace(/^\/?xl\//,'').replace(/^\//,'')===file));
   const title=sheet?.['@name']||file.split('/').pop();
   const rows=arr(parseXml(strFromU8(content)).worksheet?.sheetData?.row);
   for(let i=0;i<rows.length;i+=12) {
    const batch=rows.slice(i,i+12),text=batch.map(r=>`第${r['@r']}行 `+arr(r.c).map(c=>`${c['@r']}=${formatCell(c)}`).join(' | ')).join('\n');
    chunks.push({loc:`${title} · 第 ${batch[0]['@r']}–${batch.at(-1)['@r']} 行`,text:text.slice(0,16000),source:'ima-original'});
   }
  }
  return {chunks};
 }
 if(['txt','md','csv','json'].includes(ext))return {chunks:[{loc:'文本原件',text:new TextDecoder().decode(bytes).slice(0,60000),source:'ima-original'}]};
 throw new Error(`暂不支持在线解析 ${ext.toUpperCase()}，可使用文字缓存或下载原件`);
}
