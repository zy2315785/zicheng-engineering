import test from 'node:test';
import assert from 'node:assert/strict';
import { rankChunksBM25 } from '../edge-functions/_lib/bm25.mjs';

const chunk = (text, loc = '第1页') => ({ text, loc });
const doc = (mediaId, name, chunks) => ({ mediaId, name, path: name, chunks });

test('BM25 检索直接命中的工程文件名和正文', () => {
  const index = { docs: [
    doc('plan', '总进度计划.xlsx', [chunk('2026年11月的主体施工工期计划')]),
    doc('meeting', '会议记录.pdf', [chunk('工地每周有会议，内容涉及施工安全')]),
  ] };
  const hits = rankChunksBM25(index, ['进度计划', '工期'], ['施工'], 8);
  assert.equal(hits[0].doc.mediaId, 'plan');
  assert.ok(hits[0].score > 0);
});

test('同义词可以补足没有直接词命中的正文', () => {
  const index = { docs: [doc('contract', '合同.pdf', [chunk('建设工程合同工期为365日')])] };
  const hits = rankChunksBM25(index, ['开工日期'], ['合同工期'], 8);
  assert.equal(hits[0].doc.mediaId, 'contract');
});

test('不会返回无关内容；每个文件至多保留两段', () => {
  const index = { docs: [
    doc('a', '施工合同.pdf', [chunk('合同价款500万元', '一'), chunk('合同变更20万元', '二'), chunk('合同验收条件', '三')]),
    doc('b', '效果图.png', [chunk('彩色效果图')]),
  ] };
  const matches = rankChunksBM25(index, ['合同'], [], 8);
  assert.equal(matches.filter(x => x.doc.mediaId === 'a').length, 2);
  assert.ok(matches.every(x => x.doc.mediaId === 'a'));
  assert.deepEqual(rankChunksBM25(index, ['跨星系传送门'], []), []);
});

test('兼容中文数字与大小写的全文匹配', () => {
  const index = { docs: [doc('power', '临电表.xlsx', [chunk('主变容量为８００KVA')])] };
  assert.equal(rankChunksBM25(index, ['800kva'], [])[0].doc.mediaId, 'power');
});

test('缺少索引或缺少正文时安全返回空列表', () => {
  assert.deepEqual(rankChunksBM25(null, ['合同']), []);
  assert.deepEqual(rankChunksBM25({docs:[doc('a','目录.pdf',[])]}, ['目录']), []);
});
