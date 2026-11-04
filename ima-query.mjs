// ima's search endpoint accepts search terms; a conversational question often has no hit.
// Derive terms from engineering vocabulary and the current cloud folder's filenames.
const TERMS=['建筑工程施工许可证','施工许可证','施工许可','施工图审查','图审','总进度','倒排计划','进度计划','施工组织设计','专项施工方案','基坑围护','地质勘察','勘察报告','建设工程规划许可证','规划许可证','用地许可证','开工报告','竣工验收','质量监督','安全监督','招标文件','中标通知书','工程合同','合同','工程量清单','预算','会议纪要','联系单','变更','监理','消防','人防','节能','防雷','国防光缆'];
const clean=value=>String(value??'').normalize('NFKC').trim().slice(0,200);
export function planImaQueries(question,files=[]){
 const q=clean(question),terms=[];
 const add=value=>{value=clean(value);if(value&&!terms.includes(value))terms.push(value)};
 // Explicit filenames are the strongest hint; omit their extension for title search.
 for(const match of q.matchAll(/[^\s“”「」《》?？]+\.(?:pdf|docx?|xlsx?|dwg|txt|md|csv)/gi))add(match[0].replace(/\.[^.]+$/,''));
 const vocabulary=TERMS.filter(t=>q.includes(t)).sort((a,b)=>b.length-a.length);
 for(const term of vocabulary)if(!terms.some(t=>t.includes(term)))add(term);
 // Support project-specific names without maintaining an exhaustive dictionary.
 const names=files.map(f=>clean(f.title??f.name??f.path));
 const fragments=[];
 for(const segment of q.match(/[\p{Script=Han}A-Za-z0-9]+/gu)??[]){
  for(let length=Math.min(16,segment.length);length>=2;length--){
   for(let start=0;start+length<=segment.length;start++){
    const word=segment.slice(start,start+length);
    if(!['工程','项目','资料','文件','施工','时候','什么','是否','这个','一下','哪些'].includes(word)&&names.some(n=>n.includes(word))&&!fragments.some(w=>w.includes(word)))fragments.push(word);
   }
  }
 }
 for(const word of fragments.sort((a,b)=>b.length-a.length))if(!terms.some(t=>t.includes(word)||word.includes(t)))add(word);
 const reduced=q.replace(/^(?:请|麻烦|帮我|帮忙|我想|想要|能否|能不能|可以)?(?:查看|看看|查询|查找|了解|找出|找一下|查一下)?/,'').replace(/[?？。！!]/g,'').trim();
 if(!terms.length&&reduced.length<=32)add(reduced);
 add(q);
 return terms.slice(0,3);
}
