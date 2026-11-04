export {PROJECTS} from './projects.js';

const groups = [
  ['临电','临时用电','箱变','800kva','供电'],
  ['施工许可','施工许可证','报建','办证'],
  ['管线','地下管线','管网','迁改'],
  ['进度','倒排','计划','工期'],
  ['基坑','围护','支护'],
  ['安全','复工','自查'],
  ['招标','投标','招标要求'],
  ['图纸','施工图','审图'],
  ['光缆','国防光缆']
];
const noise = ['请问','帮我','查找','一下','查询','这个项目','瑞邦国际大厦项目','瑞邦国际大厦','需要','哪些','怎么','什么','要求','资料','文件','项目','一下','告诉我','相关','工程','办理','有哪些','的','吗','？','?','。'];
export function keywords(query) {
  let s = query.toLowerCase().replace(/\s+/g,'');
  for(const word of noise) s=s.replaceAll(word,' ');
  let terms = s.split(/[\s，,、：:；;！!]+/).filter(t=>t.length>1);
  for(const g of groups) if(g.some(w=>s.includes(w))) terms.push(...g);
  for(const part of [...terms]) if(/[\u4e00-\u9fff]{3,}/.test(part)) {
    for(let i=0;i<part.length-1;i++) terms.push(part.slice(i,i+2));
  }
  return [...new Set(terms)].filter(t=>t.length>1);
}
const PLAN_NAME=/进度|倒排|计划|工期|节点|里程碑/;
const PLAN_QUERY=/进度|进展|倒排|计划|工期|节点|里程碑|形象|完成到|到哪|干到|施工到|做到/;
const DATE_RE=/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/g;
const DAY=86400000;

/** 是否为“现在做到哪一步”这类需要时间锚点的问题。 */
export function planIntent(query){return PLAN_QUERY.test(String(query??''))}

export function localToday(base=new Date()){
  return Date.UTC(base.getFullYear(),base.getMonth(),base.getDate());
}

/** 片段里所有 20xx 日期的最小/最大跨度，用于判断是否覆盖今天。 */
export function dateSpan(text){
  const hits=[...String(text??'').matchAll(DATE_RE)].map(m=>Date.UTC(+m[1],+m[2]-1,+m[3])).filter(Number.isFinite);
  if(hits.length<2)return null;
  return {min:Math.min(...hits),max:Math.max(...hits)};
}

/** 选覆盖今天且区间最窄的片段：表头“2026-01-01到2028-02-28”跨度太大，让位给具体工序行。 */
export function datedChunk(chunks,today=localToday()){
  let best=null,bestScore=-Infinity;
  for(const chunk of chunks??[]){
    const span=dateSpan(chunk?.text);
    if(!span)continue;
    const score=(span.min<=today&&today<=span.max)
      ?10000-(span.max-span.min)/DAY
      :-Math.min(Math.abs(today-span.min),Math.abs(today-span.max))/DAY;
    if(score>bestScore){bestScore=score;best=chunk}
  }
  return {chunk:best,score:bestScore};
}

export function searchDocuments(documents,query,{project='ruibang',category='全部资料',limit=8,today=localToday()}={}) {
  const terms=keywords(query);
  const plan=planIntent(query);
  return documents.filter(d=>d.project===project&&(category==='全部资料'||d.category===category)).map(d=>{
    const title=(d.name+' '+d.category+' '+d.path).toLowerCase();
    let titleScore=terms[0]&&d.name.toLowerCase().includes(terms[0])?12:0;
    for(const t of terms) if(title.includes(t)) titleScore+=t.length>3?12:5;
    let best=null, contentScore=0;
    for(const chunk of d.chunks??[]) {
      let score=0; const txt=chunk.text.toLowerCase();
      for(const t of terms) if(txt.includes(t)) score+=t.length>3?7:2;
      if(score>contentScore) {contentScore=score;best=chunk;}
    }
    let intentBoost=0;
    if(titleScore>0&&/需要|所需|办理|准备/.test(query)&&/资料|材料|流程/.test(query)&&/所需|流程|各项手续|前期手续|需提供/.test(d.name)) intentBoost=22;
    const isPlan=plan&&PLAN_NAME.test(d.name+d.category+d.path)&&(d.chunks?.length??0)>0;
    const dated=isPlan?datedChunk(d.chunks,today):{chunk:null,score:-Infinity};
    // 进度类问题：计划类文件优先，且摘录直接切到覆盖今天的那几行；
    // 用户已点名文件时不抢它的位置，只用日期判断优先级。
    if(isPlan){
      intentBoost+=28;
      if(titleScore===0&&dated.score>1000)intentBoost+=14;
    }
    const chunk=isPlan&&dated.chunk?dated.chunk:best??d.chunks?.[0]??null;
    const score=titleScore+contentScore+intentBoost+(d.category==='历史参考'?-8:0)+(titleScore>0&&d.chunks?.length?2:0);
    return {doc:d,score,chunk,contentMatched:contentScore>0};
  }).filter(r=>query.trim()?r.score>=5:true).sort((a,b)=>b.score-a.score||a.doc.name.localeCompare(b.doc.name,'zh-CN'))
    .filter((r,i,all)=>!query.trim()||r.score>=Math.max(5,(all[0]?.score??0)*.28)).slice(0,limit);
}
export function answerQuestion(documents,question,options={}) {
  if(options.project && !documents.some(d=>d.project===options.project)) return {kind:'empty',text:'该项目尚未接入资料，暂时无法提供有依据的回答。可以切换至瑞邦国际大厦项目进行试用。',sources:[]};
  const sources=searchDocuments(documents,question,{...options,limit:4});
  if(!sources.length) return {kind:'empty',text:'当前项目资料中没有找到与这个问题明确相关的内容。请补充专业、文件名称或具体事项；也可以在项目资料库中查看已有文件。',sources:[]};
  const readable=sources.filter(s=>s.chunk);
  return {kind:readable.length?'extract':'catalog',text:readable.length?'已从当前项目资料中找到以下相关内容。下方展示资料原文摘录，可点击来源继续核对。':'已找到相关文件，但这些文件尚未解析出可检索正文。可以先查看目录或在本地预览原件。',sources};
}
export function escapeHtml(v='') {return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
