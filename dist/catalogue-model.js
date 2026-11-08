export function normalizeCatalogue(payload,projects){
 return {...payload,documents:(payload.documents||[]).map(d=>({...d,
  project:projects.find(p=>p.imaFolder===d.folder)?.id??d.project,
  status:d.hasText===true||d.status==='indexed'?'indexed':d.status||'catalog',
  source:d.source||'ima',chunks:d.chunks||[],size:d.size??null,modified:d.modified??null
 }))};
}
export function filterCoverage(documents,coverage){return documents.filter(d=>coverage!=='indexed'||d.status==='indexed');}
export function catalogueSnapshot(payload){
 return {...payload,documents:(payload.documents||[]).map(({chunks,...doc})=>doc)};
}
export function usableSnapshot(value){return Boolean(value&&Array.isArray(value.documents)&&value.documents.length&&value.documents.every(d=>d.id&&d.name));}
