import test from 'node:test';
import assert from 'node:assert/strict';
import {seal,unseal,advanceAgent} from '../cloud-functions/_lib/agent.js';
import {scoreIndex,cloudQueries} from '../cloud-functions/_lib/retrieval.js';
import {parseOriginal,downloadOriginal} from '../cloud-functions/_lib/original.js';
import {zipSync,strToU8} from 'fflate';
import {onRequest} from '../cloud-functions/api/[[default]].js';
import {reconcileSavedState} from '../dist/session-data.js';
import {fileLocation,sourceLocations} from '../dist/file-location.js';
const env={DEEPSEEK_API_KEY:'unit-test-only-key',IMA_API_KEY:'unit-test-only-ima'};
test('full-width model citations retain the original file source',async()=>{
 const original=globalThis.fetch,s=state();s.reads=1;s.evidence=[{doc:{mediaId:'file-1',name:'测试许可.pdf',path:'测试许可.pdf'},chunk:{loc:'第1页',text:'测试原文'},source:'ima-original'}];
 globalThis.fetch=async()=>Response.json({choices:[{message:{content:'根据原件核对【1】。'},finish_reason:'stop'}]});
 try{const result=await advanceAgent(env,seal(s,env));assert.equal(result.text,'根据原件核对[1]。');assert.equal(result.sources.length,1);assert.equal(result.sources[0].doc.id,'file-1');}finally{globalThis.fetch=original;}
});
function state(){return {version:'agent-v3-20261107',created:Date.now(),project:'ruibang',question:'开工日期',round:0,reads:0,trace:[],evidence:[],candidates:[],catalogue:[],messages:[{role:'system',content:'fixture'}],pending:[]};}
test('encrypted continuation rejects tampering, wrong keys and expired states',()=>{
 const s=state(),token=seal(s,env);assert.deepEqual(unseal(token,env),s);assert(!token.includes(s.question));
 assert.throws(()=>unseal(token,{...env,IMA_API_KEY:'other'}));
 const b=Buffer.from(token,'base64url');b[16]^=1;assert.throws(()=>unseal(b.toString('base64url'),env));
 s.created-=31*60*1000;assert.throws(()=>unseal(seal(s,env),env));
});
test('multiple model rounds preserve reasoning and answer every tool call',async()=>{
 const original=globalThis.fetch,requests=[],calls=[0,1,2,3].map(i=>({id:'call_'+i,type:'function',function:{name:'search_docs',arguments:'{"query":"开工"}'}}));
 globalThis.fetch=async(url,options)=>{const request=JSON.parse(options.body);requests.push(request);return Response.json({choices:[{message:requests.length===1?{content:'',reasoning_content:'private reasoning fixture',tool_calls:calls}:{content:'尚缺原件，无法确定日期。'},finish_reason:'stop'}]});};
 try{
  let result=await advanceAgent(env,seal(state(),env));assert(result.pending);
  for(let i=0;i<4;i++)result=await advanceAgent(env,result.cursor,{searchTool:async()=> 'no evidence'});
  result=await advanceAgent(env,result.cursor);assert.equal(result.pending,undefined);assert.equal(result.model.effort,'high');
  assert.equal(requests.length,2);assert.equal(requests[1].messages[1].reasoning_content,'private reasoning fixture');
  assert.deepEqual(requests[1].messages.filter(m=>m.role==='tool').map(m=>m.tool_call_id),calls.map(c=>c.id));
  assert(!JSON.stringify(result).includes('private reasoning fixture'));
 }finally{globalThis.fetch=original;}
});
test('keyword retrieval covers paraphrases, preserves relevant files, rejects unrelated query',()=>{
 const index={docs:[{name:'开工报告.pdf',mediaId:'a',chunks:[{loc:'第1页',text:'监理工程师批准开工，合同开工日期 2026-09-10'}]},{name:'总进度计划.xlsx',mediaId:'b',chunks:[{loc:'Sheet1',text:'主体施工及竣工计划，合同工期 600 日历天'}]},{name:'消防意见.pdf',mediaId:'c',chunks:[{text:'消防审查意见'}]}]};
 for(const q of ['开工日期是什么时候','哪一天开始动工','开工报告上写的日期'])assert.equal(scoreIndex(index,q)[0].doc.mediaId,'a');
 assert(scoreIndex(index,'总工期有多少日历天').some(h=>h.doc.mediaId==='b'));
 assert.deepEqual(scoreIndex(index,'月球采矿机器人'),[]);assert(cloudQueries('什么时候开工').includes('开工报告'));
});
test('ima original requests preserve vendor signed headers',async()=>{
 const original=globalThis.fetch,seen=[];
 globalThis.fetch=async(url,opts)=>{seen.push({url,opts});return seen.length===1?Response.json({code:0,data:{url_info:{url:'https://files.example.test/a',headers:{'x-signed-test':'required'}}}}):new Response('file');};
 try{assert.equal(new TextDecoder().decode(await downloadOriginal(env,'scoped-id')),'file');assert.equal(seen[1].opts.headers['x-signed-test'],'required');}finally{globalThis.fetch=original;}
});
test('DOCX and XLSX parse Chinese originals with file locations',async()=>{
 const docx=zipSync({'word/document.xml':strToU8('<w:document><w:body><w:p><w:r><w:t>项目合同开工日期</w:t></w:r></w:p></w:body></w:document>')});
 assert((await parseOriginal(docx,'合同.docx')).chunks[0].text.includes('项目合同开工日期'));
 const xlsx=zipSync({'xl/sharedStrings.xml':strToU8('<sst><si><t>桩基开工</t></si></sst>'),'xl/worksheets/sheet1.xml':strToU8('<worksheet><sheetData><row r="3"><c r="A3" t="s"><v>0</v></c><c r="B3"><v>46500</v></c></row></sheetData></worksheet>')});
 const out=await parseOriginal(xlsx,'计划.xlsx');assert(out.chunks[0].text.includes('A3=桩基开工'));assert(out.chunks[0].loc.includes('3–3'));
});
test('health checks never invoke billable models or reveal credentials; unsupported project is refused',async()=>{
 const original=globalThis.fetch;globalThis.fetch=()=>{throw new Error('unexpected network');};
 try{
  const health=await onRequest({env,request:new Request('https://example.test/api/health')});const text=await health.text();assert(!text.includes(env.DEEPSEEK_API_KEY));assert(text.includes('node-cloud'));
  const bad=await onRequest({env,request:new Request('https://example.test/api/ask',{method:'POST',body:JSON.stringify({project:'unknown',question:'test'})})});assert.equal(bad.status,502);assert((await bad.json()).message.includes('请选择'));
 }finally{globalThis.fetch=original;}
});
test('cloud catalogue refresh preserves answer snapshots and stable citation numbers',()=>{
 const doc={id:'file-test',project:'ruibang',name:'许可.pdf',path:'瑞邦国际大厦/报建/许可.pdf',source:'ima',chunks:[]};
 const source={citation:7,doc:{...doc,source:'index-cache'},chunk:{location:'第1页',text:'缓存原文'}};
 const history=[{project:'ruibang',messages:[{result:{text:'原回答[7]',sources:[source]}}]}];
 const saved=reconcileSavedState([doc],history,[]).history[0].messages[0].result;
 assert.equal(saved.text,'原回答[7]');assert.equal(saved.sources[0].chunk.text,'缓存原文');assert(saved.sources[0].snapshot);
 assert.equal(fileLocation(doc).path,'/AI/瑞邦国际大厦/报建/许可.pdf');assert(sourceLocations(saved.sources).includes('>7</span>'));
 assert.equal(reconcileSavedState([],history,[]).history[0].messages[0].result.sources.length,0);
});
