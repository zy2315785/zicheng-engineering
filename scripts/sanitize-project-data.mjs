#!/usr/bin/env node
// 把 dist/project-data.json 脱敏：保留结构与文件数量，抹掉真实文件名、路径与正文摘录。
// 用法：
//   node scripts/sanitize-project-data.mjs          仅预览，不改文件
//   node scripts/sanitize-project-data.mjs --write  备份后原地脱敏
// 原文件会备份为 dist/project-data.original.json（已被 .gitignore 排除）。

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'dist', 'project-data.json');
const backup = join(root, 'dist', 'project-data.original.json');
const write = process.argv.includes('--write');

if (!existsSync(target)) {
  console.error(`未找到 ${target}`);
  process.exit(1);
}

const data = JSON.parse(readFileSync(target, 'utf8'));
const maskName = (name, i) => {
  const ext = typeof name === 'string' && name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  return `项目资料-${String(i + 1).padStart(3, '0')}${ext}`;
};

let chunkBytes = 0;
let masked = 0;

const maskList = (list) => {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  list.forEach((doc, i) => {
    if (!doc || typeof doc !== 'object') return;
    if (Array.isArray(doc.chunks)) {
      for (const c of doc.chunks) chunkBytes += String(c?.text ?? '').length;
      doc.chunks = [];
    }
    if (typeof doc.name === 'string') {
      const alias = maskName(doc.name, i);
      doc.name = alias;
      if (typeof doc.path === 'string') doc.path = alias;
      n++;
    }
    if ('contentHash' in doc) doc.contentHash = null;
  });
  return n;
};

masked += maskList(data.documents);
masked += maskList(data.excluded);

if (Array.isArray(data.projects)) {
  data.projects = data.projects.map((p) => {
    const { folder, imaFolder, baiduFolder, images, ...rest } = p ?? {};
    return rest;
  });
}

data.indexingNote = '已脱敏的公开示例数据：仅保留文件数量与分类，不含真实文件名与正文。';

console.log(`文档条目：${data.documents?.length ?? 0}`);
console.log(`已脱敏文件名：${masked} 条`);
console.log(`将清除的正文摘录合计：${(chunkBytes / 1024).toFixed(0)} KB`);

if (!write) {
  console.log('\n预览模式，未改动文件。确认后加 --write 执行。');
  process.exit(0);
}

copyFileSync(target, backup);
writeFileSync(target, JSON.stringify(data), 'utf8');
console.log(`\n已完成。原文件备份：${backup}`);
