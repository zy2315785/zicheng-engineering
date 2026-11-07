// These aliases expand retrieval only; they never establish equivalence of dates or amounts.
export const CONCEPTS = [
 ['开工','开工日期','动工','开工报告','开工令','合同开工','计划开工','实际开工','施工许可证'],
 ['竣工','完工','交工','合同竣工','竣工日期','总进度','工期'],
 ['工期','合同工期','日历天','总进度','进度计划','倒排'],
 ['建设单位','发包人','甲方','业主'], ['施工单位','承包人','乙方','总承包','中标'],
 ['监理','总监','监理单位'], ['设计单位','设计院','设计负责人'],
 ['造价','合同价','中标价','合同金额','签约合同价','工程款'],
 ['付款','支付','预付款','进度款','结算'], ['质保','保修','缺陷责任'],
 ['面积','建筑面积','计容','用地面积'], ['施工许可','施工许可证','建施证'],
 ['规划','建设工程规划许可证','用地规划'], ['桩基','试桩','管桩','灌注桩'],
 ['临电','临时用电','箱变','变压器'], ['地质','勘察','岩土'],
 ['消防','消火栓','防火'], ['管线','给水','排水','光缆','燃气'],
 ['进度','进展','完成情况','倒排','台账','总进度'], ['违约','罚款','赔偿','违约金'],
];
const normalize = s => String(s || '').normalize('NFKC').toLowerCase();
const STOP = /[的了是在有和与吗呢什么怎哪谁多少几请帮我查查看下这个那么什么时候一下]/;
export function queryTerms(question) {
 const text = normalize(question), direct = new Set();
 for (const group of CONCEPTS) for (const term of group) if (text.includes(term)) direct.add(term);
 for (const word of text.match(/[a-z0-9_-]{3,}/g) || []) direct.add(word);
 for (const run of text.match(/[\u4e00-\u9fff]+/g) || []) {
  for (let n=4;n>=2;n--) for (let i=0;i+n<=run.length;i++) {
   const t=run.slice(i,i+n); if (!STOP.test(t)) direct.add(t);
  }
 }
 const expanded = new Set();
 for (const g of CONCEPTS) if (g.some(t=>text.includes(t))) for (const t of g) if(!direct.has(t)) expanded.add(t);
 return {direct:[...direct].slice(0,48), expanded:[...expanded].slice(0,40)};
}
export function cloudQueries(question) {
 const {direct, expanded}=queryTerms(question);
 const terms=[...new Set([...direct.filter(t=>CONCEPTS.some(g=>g.includes(t))), ...expanded])];
 return (terms.length?terms:[String(question).replace(/请|帮我|是什么|什么时候|多少|[？?]/g,'').trim().slice(0,24)]).filter(Boolean).slice(0,4);
}
export function scoreIndex(index, question, limit=8) {
 const {direct,expanded}=queryTerms(question), hits=[];
 if (!direct.length) return [];
 for(const doc of index.docs||[]) {
  const name=normalize(doc.name), metadata=normalize([doc.category,...doc.keywords||[]].join(' '));
  for(const chunk of doc.chunks||[]) {
   const text=normalize(chunk.text), primary=direct.filter(t=>text.includes(t)||name.includes(t));
   if (!primary.length&&!expanded.some(t=>text.includes(t)||name.includes(t))) continue;
   let score=0;
   for(const term of direct) {
    const w=term.length>=4?5:term.length===3?3:1.5;
    if(name.includes(term)) score+=w*6;
    if(text.includes(term)) score+=w*2;
    if(metadata.includes(term)) score+=w*.4;
   }
   for(const term of expanded) {if(name.includes(term))score+=3; if(text.includes(term))score+=1;}
   score/=Math.min(1.7,Math.sqrt(1+text.length/4000));
   if(/原中关村|历史参考|2019\.8\.28/.test(doc.name+' '+doc.category))score*=.65;
   hits.push({doc,chunk,score});
  }
 }
 hits.sort((a,b)=>b.score-a.score);
 const perDoc=new Map(), picked=[];
 for(const h of hits){const id=h.doc.mediaId||h.doc.name,n=perDoc.get(id)||0;if(n>=2)continue;perDoc.set(id,n+1);picked.push(h);if(picked.length>=limit)break;}
 return picked;
}
export function excerpt(text, query, length=1600) {
 const s=String(text||''), {direct}=queryTerms(query);
 const terms=direct.sort((a,b)=>b.length-a.length);
 const at=terms.map(t=>s.toLowerCase().indexOf(t)).find(n=>n>=0)??0;
 return s.slice(Math.max(0,at-300),Math.max(0,at-300)+length);
}
