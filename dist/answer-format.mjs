import {escapeHtml} from './search.mjs';
const inline=value=>escapeHtml(value).replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>').replace(/`([^`\n]+)`/g,'<code>$1</code>');
export function formatAnswer(value){
 const lines=String(value??'').replace(/\r/g,'').split('\n'),out=[];
 for(let i=0;i<lines.length;i++){
  const line=lines[i].trim();if(!line)continue;
  if(line.includes('|')&&/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i+1]??'')){
   const cells=v=>v.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
   const head=cells(line);i++;
   const rows=[];while(i+1<lines.length&&lines[i+1].includes('|'))rows.push(cells(lines[++i]));
   out.push('<div class="answer-table-wrap"><table class="answer-table"><thead><tr>'+head.map(c=>'<th>'+inline(c)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(c=>'<td>'+inline(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>');continue;
  }
  const heading=/^#{1,4}\s+(.+)/.exec(line);
  if(heading){out.push('<h3>'+inline(heading[1])+'</h3>');continue}
  const list=/^(?:[-*]\s+|\d+[、.]\s*)(.+)/.exec(line);
  if(list){out.push('<p class="answer-list-item">'+inline(line.replace(/^[-*]\s+/,'• '))+'</p>');continue}
  out.push('<p>'+inline(line)+'</p>');
 }
 return out.join('');
}
