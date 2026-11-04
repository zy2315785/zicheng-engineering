import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {readApiConfig} from '../api-bridge.mjs';
import {searchIma} from '../cloud-sources.mjs';
import {fetchBaiduFile} from '../baidu-drive.mjs';
import {localDocumentPath} from '../project-files.mjs';

const result={};
async function check(name,run){
 try{result[name]=await run()}catch(error){result[name]={connected:false,error:error.code??error.name??'CHECK_FAILED'};process.exitCode=1}
}
await check('deepseek',async()=>{
 const c=readApiConfig();let response;
 for(let attempt=0;attempt<2;attempt++){
  try{response=await fetch(c.base+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+c.key},body:JSON.stringify({model:c.model,max_tokens:512,thinking:{type:'enabled'},reasoning_effort:c.effort,messages:[{role:'user',content:'请只回复：连接成功'}]}),signal:AbortSignal.timeout(40000)});break}catch(error){if(attempt===1)throw error}
 }
 if(!response.ok)throw Object.assign(new Error('Model probe failed'),{code:'MODEL_HTTP_'+response.status});
 const data=await response.json();if(!data.choices?.[0]?.message?.content)throw Object.assign(new Error('No response'),{code:'MODEL_EMPTY'});
 return {connected:true,model:data.model,thinking:true,effort:c.effort};
});
await check('ima',async()=>{
 const documents=await searchIma('ruibang','开工');
 if(!documents.length)throw Object.assign(new Error('No matching file'),{code:'IMA_NO_RESULT'});
 return {connected:true,matchedFiles:documents.length,project:'ruibang'};
});
await check('baidu',async()=>{
 const data=JSON.parse(fs.readFileSync(new URL('../dist/project-data.json',import.meta.url)));
 const doc=data.documents.find(d=>d.project==='ruibang'&&d.name==='工程建设参建单位情况登记表.xlsx');
 if(!doc)throw Object.assign(new Error('Missing test document'),{code:'DOCUMENT_MISSING'});
 const {response}=await fetchBaiduFile(doc);
 const bytes=Buffer.from(await response.arrayBuffer());
 const digest=value=>createHash('sha256').update(value).digest('hex');
 const same=digest(bytes)===digest(fs.readFileSync(localDocumentPath(doc)));
 if(!same)throw Object.assign(new Error('Original mismatch'),{code:'ORIGINAL_MISMATCH'});
 return {connected:true,downloadBytes:bytes.length,matchesLocalOriginal:true};
});
console.log(JSON.stringify(result));
