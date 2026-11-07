import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROJECTS,answerQuestion,searchDocuments,escapeHtml,planIntent,dateSpan,localToday} from '../dist/search.js';
import {reconcileSavedState} from '../dist/session-data.js';
import {docs} from './fixture-documents.mjs';
test('项目清单完整，瑞邦与火炬已接入原始目录',()=>{
 assert.equal(PROJECTS.length,11);
 assert.equal(PROJECTS.filter(p=>p.connected).length,2);
 assert.ok(docs.length>100);
 assert.ok(docs.some(d=>d.project==='ruibang'));assert.ok(docs.some(d=>d.project==='huoju'));assert.equal(new Set(docs.map(d=>d.id)).size,docs.length);
});
test('施工许可办理优先找到所需资料清单',()=>{
 const a=answerQuestion(docs,'施工许可证办理需要哪些资料？',{project:'ruibang'});
 assert.equal(a.sources[0].doc.name,'施工许可证办理所需资料(新).xlsx');
 assert.ok(a.sources[0].chunk.text.includes('资料'));
});
test('进度询问定位真实计划文件，摘录可追溯',()=>{
 const a=answerQuestion(docs,'查看项目进展倒排计划',{project:'ruibang'});
 assert.equal(a.kind,'extract');
 assert.equal(a.sources[0].doc.name,'瑞邦国际大厦项目进展倒排计划.xlsx');
 for(const s of a.sources.filter(s=>s.chunk)){
  const original=docs.find(d=>d.id===s.doc.id);
  assert.ok(original.chunks.some(c=>c.text===s.chunk.text&&c.location===s.chunk.location));
 }
});
test('切换至未接入项目不泄露瑞邦资料',()=>{
 const a=answerQuestion(docs,'瑞邦临电招标',{project:'changshui'});
 assert.equal(a.kind,'empty'); assert.equal(a.sources.length,0);
 assert.equal(searchDocuments(docs,'施工许可',{project:'changshui'}).length,0);
});
test('范围外问题不编造回答',()=>{
 const a=answerQuestion(docs,'火星基地的超空间引擎在哪里？',{project:'ruibang'});
 assert.equal(a.sources.length,0);
 assert.equal(a.kind,'empty');
 const unknownChecklist=answerQuestion(docs,'火星基地需要哪些资料？',{project:'ruibang'});
 assert.equal(unknownChecklist.sources.length,0);
});
test('敏感文件不进入索引，用户及文档文本可安全显示',()=>{
 assert.ok(docs.every(d=>!['身份证','公章','通讯录'].some(s=>d.path.includes(s))));
 assert.equal(escapeHtml('<img src=x onerror="alert(1)">'),'&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});
test('限定分类保持检索范围',()=>{
 const a=searchDocuments(docs,'临电',{project:'ruibang',category:'临电工程'});
 assert.ok(a.length>0);
 assert.ok(a.every(s=>s.doc.category==='临电工程'));
});
test('补充项目文本可以查询，原项目数据隔离',()=>{
 const supplemental={id:'test',name:'质量巡检.txt',path:'浏览器导入/质量巡检.txt',type:'txt',project:'changshui',category:'补充资料',status:'indexed',chunks:[{location:'文本段1',text:'质量巡检由项目负责人组织。'}]};
 const a=answerQuestion([...docs,supplemental],'质量巡检由谁组织？',{project:'changshui'});
 assert.equal(a.sources.length,1);assert.equal(a.sources[0].doc.id,'test');
});
test('私有目录集成：删除文件退出索引，新增进度计划已接入',{skip:!process.env.TEST_PRIVATE_DATA},()=>{
 const source=fileURLToPath(new URL('../../瑞邦国际大厦/',import.meta.url));
 assert.ok(docs.every(d=>fs.existsSync(path.join(path.dirname(source),PROJECTS.find(p=>p.id===d.project).folder,d.path))));

 assert.ok(docs.some(d=>d.name==='中关村总进度计划.xlsx'&&d.chunks.length));
});
test('删除文件的历史摘录与收藏会清除',()=>{
 const oldDoc={id:'deleted',project:'ruibang',chunks:[{location:'段1',text:'旧内容'}]};
 const old=[{project:'ruibang',messages:[{question:'旧问题',result:{kind:'extract',text:'原回答',sources:[{doc:oldDoc,chunk:oldDoc.chunks[0]}]}}]}];
 const result=reconcileSavedState(docs,old,['deleted',docs[0].id]);
 assert.equal(result.history[0].messages[0].result.sources.length,0);
 assert.match(result.history[0].messages[0].result.text,/已删除或更新/);
 assert.deepEqual(result.favorites,[docs[0].id]);
});
test('文件内容改变会使旧摘录失效，仍有效的引用保留',()=>{
 const current=docs.find(d=>d.chunks.length);
 const old=[{project:'ruibang',messages:[{result:{text:'原回答',sources:[{doc:current,chunk:{location:'段1',text:'不再存在的旧段落'}}]}},{result:{text:'有效回答',sources:[{doc:current,chunk:current.chunks[0]}]}}]}];
 const result=reconcileSavedState(docs,old,[]);
 assert.equal(result.history[0].messages[0].result.sources.length,0);
 assert.equal(result.history[0].messages[1].result.sources.length,1);
 assert.equal(result.history[0].messages[1].result.text,'有效回答');
 assert.equal(result.history[0].messages[1].result.sources[0].doc.chunks,undefined);
});
test('进度类口语问题能定位到覆盖今天的总进度计划',()=>{
 assert.equal(planIntent('现在工程完成到哪一步了？'),true);
 assert.equal(planIntent('施工许可证办理需要哪些资料？'),false);
 const a=answerQuestion(docs,'现在工程完成到哪一步了？',{project:'ruibang'});
 assert.equal(a.sources[0].doc.name,'中关村总进度计划.xlsx');
 const span=dateSpan(a.sources[0].chunk.text);
 assert.ok(span,'选中的片段应含成对日期');
 const today=localToday();
 assert.ok(span.min<=today&&today<=span.max,'摘录区间应覆盖今天，而不是表头');
});
test('进度意图不会抢走用户点名的文件，也不把无正文图纸顶上来',()=>{
 const a=searchDocuments(docs,'查看项目进展倒排计划',{project:'ruibang',limit:6});
 assert.equal(a[0].doc.name,'瑞邦国际大厦项目进展倒排计划.xlsx');
 assert.ok(a.every(s=>s.doc.chunks?.length),'进度类问题不应返回无正文的图纸');
});
