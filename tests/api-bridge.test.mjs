import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {normalizeCitations,readApiConfig,activeProvider,bindCitations} from '../api-bridge.mjs';
import {buildPrompt} from '../prompt.mjs';

import {docs} from './fixture-documents.mjs';

test('越界出处编号被剥离，有效编号保留',()=>{
 const text='依据施工许可办理资料[1]，还需环评批复[2]，另有不存在的第三份[7]。';
 assert.equal(normalizeCitations(text,2),'依据施工许可办理资料[1]，还需环评批复[2]，另有不存在的第三份。');
 assert.equal(normalizeCitations('无编号回答',2),'无编号回答');
 assert.equal(normalizeCitations('引用[1]和[2]',0),'引用和');
});

test('密钥不写入源码，配置文件可读取',()=>{
 const config=readApiConfig();
 assert.ok(config.base.startsWith('http'));
 assert.ok(config.model.length>0);
 assert.ok(config.timeout>=5000);
 assert.equal(fs.existsSync(new URL('../api-bridge.mjs',import.meta.url)),true);
 const source=fs.readFileSync(new URL('../api-bridge.mjs',import.meta.url),'utf8');
 assert.ok(!/sk-[0-9a-f]{20,}/.test(source),'源码中不应出现明文密钥');
});

test('有密钥走 API，没有密钥仅使用本地检索',()=>{assert.equal(activeProvider(),readApiConfig().key?'api':'local');});

test('提示词保留防编造规则并带上片段原文',()=>{
 const sources=[{doc:{name:'施工许可证办理所需资料(新).xlsx'},chunk:{location:'Sheet1 · 第1–5行',text:'1 | 用地规划许可证'},score:12}];
 const prompt=buildPrompt('施工许可需要哪些资料？','ruibang',sources,[]);
 assert.match(prompt,/不得把历史文件当作最新要求/);
 assert.match(prompt,/瑞邦国际大厦项目/);
 assert.match(prompt,/用地规划许可证/);
 assert.match(prompt,/\[资料1\]/);
});

test('检索到的片段都能在索引中找到原文，可回溯',()=>{
 const first=docs.find(d=>d.chunks?.length);
 assert.ok(first.chunks[0].location);
 assert.equal(typeof first.chunks[0].text,'string');
});

test('提示词带上今天日期与计划口径规则',()=>{
 const prompt=buildPrompt('现在到哪一步了？','ruibang',[],[]);
 const d=new Date();
 const pad=n=>String(n).padStart(2,'0');
 const today=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
 assert.ok(prompt.includes(today),'提示词应含今天的日期，否则模型无法做时间比对');
 assert.match(prompt,/计划口径/);
 assert.match(prompt,/实际进度需现场确认/);
 assert.match(prompt,/修改时间最新/);
});

const sampleSources=[
 {doc:{name:'中关村总进度计划.xlsx'},chunk:{location:'第19–23行'}},
 {doc:{name:'瑞邦国际大厦开工倒排进度计划.xlsx'},chunk:{location:'第1–5行'}},
 {doc:{name:'瑞邦国际大厦项目进展倒排计划.xlsx'},chunk:{location:'第21–25行'}}
];

test('引用编号写串时按最近文名纠偏，未引用的来源被剔除',()=>{
 const out=bindCitations('依据《中关村总进度计划.xlsx》第19–23行 [2]。',sampleSources);
 assert.match(out.text,/\[1\]/);
 assert.equal(out.sources.length,1);
 assert.equal(out.sources[0].doc.name,'中关村总进度计划.xlsx');
});

test('并列引用两份文件时各自归位并压缩编号',()=>{
 const text='另有《瑞邦国际大厦开工倒排进度计划.xlsx》[3] 与《瑞邦国际大厦项目进展倒排计划.xlsx》[4]。';
 const out=bindCitations(text,sampleSources);
 assert.match(out.text,/开工倒排进度计划\.xlsx》\[1\]/);
 assert.match(out.text,/项目进展倒排计划\.xlsx》\[2\]/);
 assert.equal(out.sources.length,2);
});

test('没有引用时不删来源',()=>{
 const out=bindCitations('资料里没有相关内容。',sampleSources);
 assert.equal(out.sources.length,3);
 assert.equal(out.text,'资料里没有相关内容。');
});

test('默认开启多步检索，轮数有上限',()=>{
 const config=readApiConfig();
 assert.equal(config.agent,true,'默认应启用 agent 模式');
 assert.ok(config.maxSteps>=1&&config.maxSteps<=6,'工具轮数需限制在 1–6 之间');
});
