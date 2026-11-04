import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {localDocumentPath,projectConfig} from '../project-files.mjs';
import {validateRelative,allowedDownloadURL,baiduRequest} from '../baidu-drive.mjs';
import {linkCloudToLocal} from '../knowledge-tools.mjs';
import {cloudStatus} from '../cloud-sources.mjs';
import {askWithAgent,bindCitations} from '../api-bridge.mjs';
import {formatAnswer} from '../dist/answer-format.mjs';
const docs=JSON.parse(fs.readFileSync(new URL('../dist/project-data.json',import.meta.url))).documents;

test('百度目录与下载请求遇到短暂网络故障会有限重试，永久HTTP错误不重复访问',async()=>{
 let calls=0;const sleep=async()=>{};
 const response=await baiduRequest('https://pan.baidu.com/test',{}, {sleep,fetcher:async()=>{if(++calls===1)throw new TypeError('fetch failed');return new Response('ok')}});
 assert.equal(response.status,200);assert.equal(calls,2);
 calls=0;
 const denied=await baiduRequest('https://pan.baidu.com/test',{}, {sleep,fetcher:async()=>{calls++;return new Response('',{status:403})}});
 assert.equal(denied.status,403);assert.equal(calls,1);
 calls=0;
 await assert.rejects(baiduRequest('https://pan.baidu.com/test',{}, {sleep,fetcher:async()=>{calls++;throw new TypeError('fetch failed')}}),error=>error.code==='BAIDU_NETWORK');
 assert.equal(calls,3);
});
test('同一文件多处摘录保留其行号引用，不按相同文件名强行改为第一段',()=>{
 const sources=[{doc:{name:'清单.xlsx'},chunk:{location:'第1–5行'}},{doc:{name:'清单.xlsx'},chunk:{location:'第6–10行'}}];
 const result=bindCitations('《清单.xlsx》第1–5行[1]，第6–10行[2]。',sources);
 assert.equal(result.sources.length,2);assert.match(result.text,/第6–10行\[2\]/);
});
test('模型答案表格可读，外部文本中的脚本与HTML不会执行',()=>{
 const html=formatAnswer('## 结论\n**依据**\n| 文件 | 内容 |\n|---|---|\n| 原文 | <img src=x onerror=alert(1)> |');
 assert.match(html,/<table/);assert.match(html,/<strong>依据<\/strong>/);assert.ok(!html.includes('<img'));assert.match(html,/&lt;img/);
});
test('两个项目原件均在各自目录内解析，同名文件不会混入其他项目',()=>{
 for(const project of ['ruibang','huoju']){
  const doc=docs.find(d=>d.project===project&&d.type==='pdf');
  assert.ok(localDocumentPath(doc).includes(projectConfig(project).folder));
  assert.throws(()=>localDocumentPath({...doc,path:'../使用说明.txt'}));
 }
});
test('百度下载拒绝上级路径、敏感排除项和非官方跳转',()=>{
 for(const value of ['../x','/x','x/../../a','通讯录.xlsx','x//a'])assert.throws(()=>validateRelative(value));
 assert.deepEqual(validateRelative('报建/施工许可证.pdf'),['报建','施工许可证.pdf']);
 for(const url of ['https://evil.example/file','http://d.pcs.baidu.com/f','https://baidu.com.evil.example/f','https://u:p@d.pcs.baidu.com/f'])assert.throws(()=>allowedDownloadURL(url));
 assert.equal(allowedDownloadURL('https://d.pcs.baidu.com/file/a').hostname,'d.pcs.baidu.com');
});
test('云端文件按项目与路径关联本地镜像，同名冲突不误绑',()=>{
 const local=[{id:'a',project:'ruibang',name:'许可.pdf',path:'报建/许可.pdf',type:'pdf'},{id:'b',project:'huoju',name:'许可.pdf',path:'许可.pdf',type:'pdf'}];
 const out=linkCloudToLocal([{id:'ima-x',project:'ruibang',name:'许可.pdf',path:'报建/许可.pdf'}],local,'ruibang');
 assert.equal(out[0].id,'a');assert.equal(out[0].localId,'a');
});
test('云端状态不向浏览器输出任何密钥或授权令牌',()=>{
 const text=JSON.stringify(cloudStatus());
 for(const key of ['apiKey','secretKey','accessToken','refreshToken','clientId'])assert.ok(!text.includes('"'+key+'"'));
});
test('Agent 每次先检索 ima，启用高强度思考，并保留工具轮次中的推理字段',async()=>{
 const requests=[],order=[];
 const original=globalThis.fetch;
 let count=0;
 const source={doc:{id:'x',project:'ruibang',name:'清单.xlsx',path:'清单.xlsx'},chunk:{location:'第1行',text:'第一项为登记表'}};
 globalThis.fetch=async(url,options)=>{
  assert.ok(String(url).startsWith('https://api.deepseek.com/'));
  const body=JSON.parse(options.body);requests.push(body);order.push('model');
  const message=++count===1?{role:'assistant',content:'',reasoning_content:'provider-private-test',tool_calls:[{id:'call-1',type:'function',function:{name:'read_document',arguments:'{"name":"清单.xlsx"}'}}]}:{role:'assistant',content:'第一项是登记表[1]。',reasoning_content:'private-final'};
  return new Response(JSON.stringify({model:'deepseek-flash',choices:[{message,finish_reason:'stop'}],usage:{total_tokens:10,prompt_tokens:5,completion_tokens:5}}),{status:200});
 };
 try{
  const result=await askWithAgent(docs,'第一项是什么？',{configuration:{key:'test-only',base:'https://api.deepseek.com/v1',model:'deepseek-flash',name:'DeepSeek',thinking:true,effort:'high',maxTokens:16384,maxSteps:2,timeout:20000},knowledgeFactory:()=>({ctx:{sources:[source],trace:[],cloudChecked:true},search:async()=>{order.push('ima');return '[1] 第一项为登记表'},run:async()=>{order.push('read');return '[1] 第一项为登记表'}})});
  assert.deepEqual(order,['ima','model','read','model']);
  assert.equal(requests[0].thinking.type,'enabled');
  assert.equal(requests[0].reasoning_effort,'high');
  assert.equal(requests[1].messages.find(m=>m.tool_calls)?.reasoning_content,'provider-private-test');
  assert.equal(result.kind,'generated');assert.equal(result.cloudChecked,true);
  assert.ok(!JSON.stringify(result).includes('provider-private-test'));
 }finally{globalThis.fetch=original}
});
test('ima 失败时不静默调用模型，明确返回未完成与本地备用摘录',async()=>{
 const original=globalThis.fetch;let called=false;
 globalThis.fetch=async()=>{called=true;throw new Error('unexpected')};
 try{
  const result=await askWithAgent(docs,'施工许可',{configuration:{key:'test',name:'Test',model:'test'},knowledgeFactory:()=>({ctx:{trace:[]},search:async()=>{throw Object.assign(new Error('ima 尚未完成连接'),{code:'IMA_UNAVAILABLE'})}})});
  assert.equal(called,false);assert.equal(result.kind,'unavailable');assert.equal(result.error,'IMA_UNAVAILABLE');assert.match(result.text,/仅展示本地检索/);
 }finally{globalThis.fetch=original}
});
