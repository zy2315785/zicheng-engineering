import test from 'node:test';
import assert from 'node:assert/strict';
import {planImaQueries} from '../ima-query.mjs';
import {searchImaDetailed,imaCall} from '../cloud-sources.mjs';
import {fileLocation,sourceLocations} from '../dist/file-location.mjs';
import {parseRetrievalPlan,retrievalPlanMessages} from '../retrieval-plan.mjs';
import {planImaRetrieval,askWithAgent} from '../api-bridge.mjs';

const permit={media_id:'permit',title:'建筑工程施工许可证（火炬高新汽车智能工厂）桩基.pdf',path:'报建/建筑工程施工许可证（火炬高新汽车智能工厂）桩基.pdf'};
const map={baseId:'base',files:[permit]};
test('口语问题先提取文件关键词；项目特有文件名可从云端目录中提炼',()=>{
 assert.equal(planImaQueries('帮我看看施工许可证上的工期是多久',map.files)[0],'施工许可证');
 assert.equal(planImaQueries('请帮我找一下箱变接电通知', [{title:'箱变接电通知书.pdf'}])[0],'箱变接电通知');
});
test('ima 用关键词搜索，结果严格限定当前项目，并保留真实匹配片段',async()=>{
 const calls=[];
 const result=await searchImaDetailed('huoju','帮我看看施工许可证上的工期是多久',{projectMap:map,call:async(method,body)=>{
  calls.push(body.query);return {info_list:[{media_id:'another-project',title:'别的项目许可.pdf'},{media_id:'permit',highlight_content:'<em>施工许可证</em>原文'}],is_end:true};
 }});
 assert.deepEqual(calls,['施工许可证']);assert.equal(result.documents.length,1);
 assert.equal(result.documents[0].project,'huoju');assert.equal(result.documents[0].chunks[0].text,'施工许可证原文');
 assert.deepEqual(result.attempts,[{query:'施工许可证',count:1,method:'search'}]);
});
test('ima 未命中时换词再查；目录匹配只报告文件存在，不伪装成正文检索',async()=>{
 const calls=[];
 const result=await searchImaDetailed('huoju','施工许可证的进度计划',{projectMap:map,call:async(method,body)=>{calls.push(body.query);return {info_list:[],is_end:true}}});
 assert.ok(calls.length>1);assert.equal(result.attempts.at(-1).method,'catalog');
 assert.equal(result.documents[0].chunks.length,0);assert.equal(result.documents[0].status,'catalog');
 await assert.rejects(searchImaDetailed('huoju','施工许可证',{projectMap:map,call:async()=>{throw new Error('网络未完成')}}),/网络未完成/);
});
test('两个项目的文件位置保留云端路径，不再生成打开网盘的网页链接',()=>{
 for(const project of ['ruibang','huoju']){
  const location=fileLocation({id:'p',project,path:'报建/许可 & 版本2.pdf'});
  assert.ok(location.path.startsWith('/AI/'));assert.ok(location.folder.endsWith('/报建'));
  assert.equal(location.url,undefined);
 }
 assert.equal(fileLocation({project:'ruibang',path:'../x.pdf'}),null);
 assert.equal(fileLocation({project:'ruibang',path:'a.pdf',imported:true}),null);
});
test('回答仅显示去重后的文件位置，保留全部引用编号和页码，转义文件名',()=>{
 const doc={id:'permit',project:'huoju',name:'许可<img src=x>.pdf',path:'报建/许可.pdf'};
 const html=sourceLocations([{doc,chunk:{location:'第1页',text:'不应在页面显示的长篇正文'}},{doc,chunk:{location:'第2页',text:'另一段正文'}}],{local:true});
 assert.equal((html.match(/class="source-location-row"/g)||[]).length,1);
 assert.match(html,/第1页 · 第2页/);assert.match(html,/>1<\/span>/);assert.match(html,/>2<\/span>/);
 assert.ok(!html.includes('不应在页面显示'));assert.ok(!html.includes('<img'));
 assert.match(html,/许可&lt;img/);assert.match(html,/\/api\/download\/permit/);
 assert.ok(!html.includes('打开网盘'));assert.ok(!html.includes('https://pan.baidu.com'));assert.match(html,/下载原件/);
});

test('短口语问题可提炼两字文件线索，不只支持上次测试的许可证问题',()=>{
 const files=[{title:'开工报告.pdf'},{title:'工程预算.xlsx'}];
 for(const query of ['开工日是什么时候','开工日期','啥时候开工'])assert.equal(planImaQueries(query,files)[0],'开工');
 assert.equal(planImaQueries('预算是多少',files)[0],'预算');
});
test('模型语义选材只能引用实际云端目录，忽略编造、越界和重复编号',()=>{
 const result=parseRetrievalPlan('```json\n{"queries":["开工报告","开工报告",null],"file_refs":["F1","F999","F1","../../x","permit"]}\n```',map.files);
 assert.deepEqual(result,{queries:['开工报告'],mediaIds:['permit']});
 assert.throws(()=>parseRetrievalPlan('not JSON',map.files));
 assert.throws(()=>parseRetrievalPlan('{}',map.files));
 assert.ok(retrievalPlanMessages('什么时候开工','huoju',map.files)[1].content.includes('"ref":"F1"'));
});
test('字段问题可由模型选择名称完全不同的云端文件，目录候选不冒充搜索正文命中',async()=>{
 const result=await searchImaDetailed('huoju','这栋楼的位置在哪',{projectMap:map,planSearch:async({files})=>({queries:['建设地点'],mediaIds:[files[0].media_id,'foreign-project']}),call:async()=>({info_list:[],is_end:true})});
 assert.equal(result.plannerUsed,true);assert.equal(result.searchCount,0);assert.equal(result.documents.length,1);
 assert.equal(result.documents[0].mediaId,'permit');assert.equal(result.documents[0].chunks.length,0);
 assert.ok(result.attempts.some(a=>a.method==='selection'&&a.count===1));
});
test('语义规划暂不可用时，按项目和路径核对本地线索，不混入未上传或其他项目文件',async()=>{
 const result=await searchImaDetailed('huoju','这栋楼的位置在哪',{projectMap:map,planSearch:async()=>{throw new Error('timeout')},localHints:[{project:'huoju',path:permit.path,name:permit.title},{project:'ruibang',path:permit.path,name:permit.title},{project:'huoju',path:'本地独有.pdf',name:'本地独有.pdf'}],call:async()=>({info_list:[],is_end:true})});
 assert.equal(result.plannerFailed,true);assert.equal(result.searchCount,0);assert.equal(result.documents.length,1);
 assert.ok(result.attempts.some(a=>a.method==='mirror'&&a.count===1));
});
test('完全无关的问题保留真实零结果，不强行填入资料',async()=>{
 const result=await searchImaDetailed('huoju','项目养了几只猫',{projectMap:map,planSearch:async()=>({queries:[],mediaIds:[]}),call:async()=>({info_list:[],is_end:true})});
 assert.equal(result.documents.length,0);assert.equal(result.searchCount,0);
});
test('实际规划接口使用当前模型配置与真实目录，输出只保留搜索词和有效文件ID',async()=>{
 let input;
 const result=await planImaRetrieval({question:'开工日是什么时候',project:'huoju',files:map.files},{configuration:{key:'test',thinking:true,effort:'high'},request:async(config,messages)=>{
  input={config,messages};return {ok:true,message:{content:'{"queries":["开工报告"],"file_refs":["F1"]}',reasoning_content:'private'}};
 }});
 assert.equal(input.config.key,'test');assert.equal(input.config.timeout,30000);assert.equal(result.mediaIds[0],'permit');
 assert.ok(!JSON.stringify(result).includes('private'));
});

test('内容词未命中时会查询实际选中文件名，而非连续发送同类字段词',async()=>{
 const calls=[];
 const result=await searchImaDetailed('huoju','在哪里',{projectMap:map,planSearch:async()=>({queries:['建设地点','项目地址','所在地'],mediaIds:['permit']}),call:async(method,body)=>{
  calls.push(body.query);return {info_list:body.query===permit.title.replace(/\.pdf$/,'')?[{media_id:'permit'}]:[],is_end:true};
 }});
 assert.equal(calls.length,2);assert.equal(result.searchCount,1);assert.equal(result.documents[0].mediaId,'permit');
});
test('ima 模糊搜索返回很多同项目文件时，优先保留模型选中的实际文件及匹配片段',async()=>{
 const files=Array.from({length:12},(_,i)=>({media_id:'f'+i,title:'相关'+i+'.pdf',path:'相关'+i+'.pdf'}));
 const result=await searchImaDetailed('huoju','面积是多少',{projectMap:{baseId:'base',files},planSearch:async()=>({queries:['面积'],mediaIds:['f11']}),call:async()=>({info_list:files.map(f=>({media_id:f.media_id,highlight_content:'正文'+f.media_id})),is_end:true})});
 assert.equal(result.documents.length,8);assert.equal(result.documents[0].mediaId,'f11');assert.equal(result.documents[0].chunks[0].text,'正文f11');
});
test('ima 对短暂网络故障、下游错误和限流有限重试，鉴权失败不重试',async()=>{
 const credentials={enabled:true,clientId:'test',apiKey:'test'},sleep=async()=>{};
 let calls=0;
 const out=await imaCall('search_knowledge',{}, {credentials,sleep,fetcher:async()=>{calls++;if(calls===1)throw new TypeError('fetch failed');return Response.json({code:0,data:{ok:true}})}});
 assert.equal(calls,2);assert.equal(out.ok,true);
 calls=0;
 await imaCall('search_knowledge',{}, {credentials,sleep,fetcher:async()=>Response.json(++calls===1?{code:110010}:{code:0,data:{}})});
 assert.equal(calls,2);
 calls=0;
 await assert.rejects(imaCall('search_knowledge',{}, {credentials,sleep,fetcher:async()=>{calls++;return new Response('',{status:401})}}),/401/);
 assert.equal(calls,1);
 calls=0;
 await assert.rejects(imaCall('search_knowledge',{}, {credentials,sleep,fetcher:async()=>{calls++;throw new TypeError('fetch failed')}}),/重试后仍不可用/);
 assert.equal(calls,3);
});

test('模型规划遇到一次连接中断会自动重试，不立刻放弃语义选材',async()=>{
 const original=globalThis.fetch;let count=0;
 globalThis.fetch=async()=>{if(++count===1)throw new TypeError('fetch failed');return Response.json({choices:[{message:{content:'{"queries":["许可"],"file_refs":["F1"]}'}}]})};
 try{
  const result=await planImaRetrieval({question:'在哪里',project:'huoju',files:map.files},{configuration:{key:'test',base:'https://api.deepseek.com/v1',model:'test',timeout:30000}});
  assert.equal(count,2);assert.deepEqual(result.mediaIds,['permit']);
 }finally{globalThis.fetch=original}
});
test('生产 Agent 将语义规划接入预检索，最终回答仍使用高强度思考',async()=>{
 const original=globalThis.fetch,requests=[];
 globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);requests.push(body);return Response.json({choices:[{message:{role:'assistant',content:requests.length===1?'{"queries":["施工许可证"],"file_refs":["F1"]}':'以许可证为依据[1]。'}}]})};
 try{
  const result=await askWithAgent([],'在哪里',{project:'huoju',configuration:{key:'test',base:'https://api.deepseek.com/v1',model:'test',name:'Test',thinking:true,effort:'high',maxTokens:4096,maxSteps:1,timeout:30000},knowledgeFactory:(docs,{planSearch})=>({ctx:{sources:[{doc:{id:'permit',name:permit.title,project:'huoju',path:permit.path},chunk:{text:'正文',location:'第1页'}}],trace:[],cloudChecked:true},search:async()=>{
   const plan=await planSearch({question:'在哪里',project:'huoju',files:map.files});assert.deepEqual(plan.mediaIds,['permit']);return '[1] 施工许可证';
  }})});
  assert.equal(result.kind,'generated');assert.equal(requests.length,2);assert.equal(requests[1].thinking.type,'enabled');assert.equal(requests[1].reasoning_effort,'high');
 }finally{globalThis.fetch=original}
});
