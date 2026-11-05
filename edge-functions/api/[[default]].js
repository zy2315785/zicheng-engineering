// 路由：edge-functions/api/[[default]].js  →  /api/*
//   GET /api/documents        返回 ima「子城」知识库的真实目录与计数
//   GET /api/file?id=<media>  302 跳转到 ima 签名链接（原件下载）
//
// 安全边界：
//   1. 所有请求先过 HTTP Basic Auth，口令只存在于环境变量，前端拿不到，也不进仓库。
//   2. 环境变量缺失时直接拒绝（fail closed），不会退化成公开接口。
//   3. ima 的 apiKey 只在函数内部使用，永不下发给浏览器。
//   4. media_id 做格式白名单校验，避免被当成任意转发器。

import { getStore } from '../_lib/pages-blob.js';

const IMA_BASE = 'https://ima.qq.com/openapi/wiki/v1/';
const BLOB_STORE = 'zc-index';
const BLOB_PROJECT = 'makers-cnwks8jmg4xl';
const PROJECT_KEYS = ['ruibang', 'huoju'];

const CATEGORY_RULES = [
  [['效果图'], '项目形象'],
  [['临电', '临时用电', '供电', '箱变'], '临电工程'],
  [['管线', '给水', '排水', '光缆', '燃气', '自来水'], '管线配套'],
  [['进度', '倒排', '确定事项'], '计划管理'],
  [['图纸', '设计', '审图', '勘察', '基坑', '可研', '方案文本', '桩基'], '设计技术'],
  [['合同', '协议', '保函'], '合同资料'],
  [['复工', '安全', '值班'], '安全管理'],
];

const MEDIA_TYPE = { 1: 'pdf', 3: 'doc', 5: 'xlsx', 9: 'image' };

function category(name) {
  if (name.includes('原中关村') || name.includes('2019.8.28')) return '历史参考';
  for (const [words, result] of CATEGORY_RULES) {
    if (words.some(w => name.includes(w))) return result;
  }
  return '前期报建';
}

function extension(name) {
  const m = String(name).match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : '';
}

function base64Decode(value) {
  if (typeof atob === 'function') {
    try { return atob(value); } catch { return null; }
  }
  try {
    return Buffer.from(value, 'base64').toString('binary');
  } catch { return null; }
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(request, env) {
  const user = env.ACCESS_USER;
  const pass = env.ACCESS_PASS;
  if (!user || !pass) return false;
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = base64Decode(header.slice(6).trim());
  if (!decoded) return false;
  const index = decoded.indexOf(':');
  if (index < 0) return false;
  return constantTimeEqual(decoded.slice(0, index), user) && constantTimeEqual(decoded.slice(index + 1), pass);
}

function unauthorized() {
  // 刻意不带 WWW-Authenticate：避免浏览器弹出原生登录框卡住首屏。
  return new Response(JSON.stringify({ ok: false, message: '该接口未开放访问' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const sleep = ms => new Promise(resolve => { try { setTimeout(resolve, ms); } catch { resolve(); } });

async function imaCall(env, method, body, attempt = 0) {
  const response = await fetch(IMA_BASE + method, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'ima-openapi-clientid': env.IMA_CLIENT_ID,
      'ima-openapi-apikey': env.IMA_API_KEY,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (payload.code !== 0) {
    // 200001 = 请求频率超限，退避重试两次
    if (payload.code === 200001 && attempt < 2) {
      await sleep(600 * (attempt + 1));
      return imaCall(env, method, body, attempt + 1);
    }
    const error = new Error(`ima ${method} 失败：${payload.code} ${payload.msg || ''}`);
    error.upstream = true;
    throw error;
  }
  return payload.data || {};
}

async function listFolder(env, kbId, folderId) {
  const items = [];
  let cursor = '';
  for (let page = 0; page < 60; page += 1) {
    const data = await imaCall(env, 'get_knowledge_list', {
      knowledge_base_id: kbId,
      cursor,
      limit: 50,
      ...(folderId ? { folder_id: folderId } : {}),
    });
    items.push(...(data.folder_list || []), ...(data.knowledge_list || []));
    cursor = data.next_cursor || '';
    if (data.is_end !== false || !cursor) break;
  }
  return items;
}

async function buildCatalogue(env) {
  const kbName = env.IMA_KB_NAME || '子城';
  const search = await imaCall(env, 'search_knowledge_base', { query: kbName, cursor: '', limit: 20 });
  const kb = (search.info_list || []).find(b => (b.name || b.kb_name) === kbName);
  if (!kb) throw new Error(`ima 中没有名为「${kbName}」的知识库`);

  const kbId = kb.id || kb.kb_id;
  const documents = [];
  const projectCounts = {};
  const queue = [{ id: undefined, path: '', folder: null, depth: 0 }];

  while (queue.length) {
    const current = queue.shift();
    const items = await listFolder(env, kbId, current.id);
    for (const item of items) {
      const title = item.title || item.name || '';
      if (!title || title.startsWith('~$')) continue;
      const isFolder = Number(item.media_type) === 99;
      const path = current.path ? `${current.path}/${title}` : title;
      if (isFolder) {
        const folder = current.depth === 0 ? title : current.folder;
        if (current.depth === 0) projectCounts[folder] = 0;
        if (current.depth < 8) queue.push({ id: item.media_id, path, folder, depth: current.depth + 1 });
      } else {
        const folder = current.folder || '';
        projectCounts[folder] = (projectCounts[folder] || 0) + 1;
        documents.push({
          id: item.media_id,
          name: title,
          path,
          type: extension(title) || MEDIA_TYPE[Number(item.media_type)] || 'file',
          category: category(path),
          folder,
          mediaType: Number(item.media_type),
        });
      }
    }
  }

  return {
    ok: true,
    source: 'ima',
    knowledgeBase: kbName,
    generated: new Date().toISOString(),
    total: documents.length,
    projects: Object.entries(projectCounts).map(([folder, files]) => ({ folder, files })),
    documents,
  };
}

const CACHE_KEY = 'https://zc-internal.cache/api-documents-v1';
const CACHE_SECONDS = 600;

// 目录结果缓存 10 分钟，避免每次打开页面都完整遍历一遍 ima（会触发频率限制）。
async function getCatalogue(env) {
  let cache = null;
  try { cache = typeof caches !== 'undefined' ? caches.default : null; } catch { cache = null; }
  if (cache) {
    try {
      const hit = await cache.match(CACHE_KEY);
      if (hit) return await hit.json();
    } catch { /* 缓存不可用时直接走实时请求 */ }
  }
  const data = await buildCatalogue(env);
  if (cache) {
    try {
      await cache.put(CACHE_KEY, new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `max-age=${CACHE_SECONDS}` },
      }));
    } catch { /* 写入失败不影响本次返回 */ }
  }
  return data;
}

async function findKnowledgeBase(env) {
  const kbName = env.IMA_KB_NAME || '子城';
  const search = await imaCall(env, 'search_knowledge_base', { query: kbName, cursor: '', limit: 20 });
  const kb = (search.info_list || []).find(b => (b.name || b.kb_name) === kbName);
  if (!kb) throw new Error(`ima 中没有名为「${kbName}」的知识库`);
  return { kbId: kb.id || kb.kb_id, kbName };
}

// ima 的检索是关键词匹配，整句问句往往零命中，需要先拆出工程术语。
const TERMS = ['施工许可证', '施工许可', '施工图审查', '图审', '总进度', '倒排计划', '进度计划', '施工组织设计', '专项施工方案', '基坑围护', '地质勘察', '勘察报告', '规划许可证', '用地许可证', '开工报告', '竣工验收', '质量监督', '安全监督', '招标文件', '中标通知书', '工程合同', '工程量清单', '预算', '会议纪要', '联系单', '变更', '监理', '消防', '人防', '节能', '防雷', '国防光缆', '临电', '临时用电', '箱变', '管线', '给水', '排水', '光缆', '燃气', '自来水', '效果图', '图纸', '设计', '审图', '勘察', '桩基', '合同', '协议', '保函', '复工', '安全', '值班'];

function planQueries(question) {
  const text = String(question).replace(/[？?。！!，,、；;：:\s]+/g, ' ').trim();
  const queries = [];
  const add = value => { const v = String(value).trim(); if (v && !queries.includes(v)) queries.push(v); };
  for (const term of [...TERMS].sort((a, b) => b.length - a.length)) if (text.includes(term)) add(term);
  for (const match of text.matchAll(/[^\s]+\.(?:pdf|docx?|xlsx?|dwg|dwf)/gi)) add(match[0].replace(/\.[^.]+$/, ''));
  add(text.slice(0, 16));
  return queries.slice(0, 3);
}

async function searchFiles(env, kbId, query, limit = 8) {
  const data = await imaCall(env, 'search_knowledge', { knowledge_base_id: kbId, query, cursor: '', limit });
  return (data.info_list || [])
    .filter(i => Number(i.media_type) !== 99 && i.media_id)
    .map(i => ({ media_id: i.media_id, title: i.title || i.name || '', path: i.path || i.title || i.name || '', media_type: Number(i.media_type) }));
}

const SYSTEM_PROMPT = [
  '你是子城联合工程部的工程资料助手。',
  '下面会给你从项目资料里检索到的原文摘录（可能来自扫描件的逐页转写）。',
  '请严格依据这些摘录回答，禁止编造摘录里没有的内容、日期、金额或条款。',
  '回答结构：先用一句话给出结论；再逐条列出依据，每条注明出自哪份文件（写全文件名）；最后如果信息不完整，明确指出还缺什么。',
  '摘录里若有「看不清」或「[?]」标记，说明原件该处不清，需如实说明。',
  '全部用简体中文，控制在两百字以内。',
].join('\n');

async function answerWithModel(env, question, items, history) {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('未配置 DEEPSEEK_API_KEY');
  const base = (env.DEEPSEEK_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = env.DEEPSEEK_MODEL || 'deepseek-chat';

  const context = items.length
    ? items.map((it, i) => `【摘录${i + 1}】${it.name}${it.path && it.path !== it.name ? '（' + it.path + '）' : ''}\n${String(it.text || '').slice(0, 900)}`).join('\n\n')
    : '（没有检索到相关原文摘录）';

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const turn of (history || []).slice(-3)) {
    if (turn && turn.question) messages.push({ role: 'user', content: String(turn.question).slice(0, 300) });
    if (turn && turn.answer) messages.push({ role: 'assistant', content: String(turn.answer).slice(0, 300) });
  }
  messages.push({ role: 'user', content: `问题：${question}\n\n${context}` });

  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 900, stream: false }),
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(`模型返回 ${response.status}：${payload?.error?.message || ''}`.slice(0, 160));
    error.upstream = true;
    throw error;
  }
  return { text: payload?.choices?.[0]?.message?.content || '', model };
}

// 从 Blob 读取某个项目的正文索引，边缘缓存 10 分钟避免反复拉 1-2MB。
async function loadIndex(env, project) {
  const key = `${project}.json`;
  const cacheKey = `https://zc-index-cache.internal/${key}`;
  let cache = null;
  try { cache = typeof caches !== 'undefined' ? caches.default : null; } catch { cache = null; }
  if (cache) {
    try { const hit = await cache.match(cacheKey); if (hit) return await hit.json(); } catch { /* 缓存不可用 */ }
  }
  const store = env.BLOB_TOKEN
    ? getStore({ name: BLOB_STORE, projectId: env.BLOB_PROJECT_ID || BLOB_PROJECT, token: env.BLOB_TOKEN })
    : getStore(BLOB_STORE);
  const data = await store.get(key, { type: 'json' });
  if (cache && data) {
    try {
      await cache.put(cacheKey, new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'max-age=600' },
      }));
    } catch { /* 写缓存失败不影响返回 */ }
  }
  return data;
}

// 中文没有空格，用 2-3 字滑窗切 n-gram，再剔除含虚词的片段。
const STOP_CHARS = new Set(['的', '了', '是', '在', '有', '和', '与', '吗', '呢', '什', '么', '怎', '哪', '谁', '多', '少', '几', '请', '帮', '我', '查', '看', '下', '这', '那', '个', '把', '被', '给', '对', '从', '到', '为', '会', '能', '要', '想', '吗', '啊', '呀', '吧']);

function chineseTerms(question, max = 24) {
  const text = String(question).replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, ' ');
  const grams = new Set();
  for (const run of text.split(/\s+/)) {
    if (!run) continue;
    for (let size = 3; size >= 2; size -= 1) {
      for (let i = 0; i + size <= run.length; i += 1) {
        const piece = run.slice(i, i + size);
        if (size === 2 && /^[0-9A-Za-z]+$/.test(piece)) continue;
        if ([...piece].some(ch => STOP_CHARS.has(ch))) continue;
        grams.add(piece);
      }
    }
  }
  return [...grams].slice(0, max);
}

// 关键词打分：命中次数 × 词长权重，文件名命中额外加权。
function scoreIndex(index, question) {
  const terms = [...new Set(planQueries(question).concat(chineseTerms(question)))]
    .filter(t => t.length >= 2)
    .slice(0, 32);
  const hits = [];
  for (const doc of index.docs || []) {
    const nameHit = terms.reduce((s, t) => s + (doc.name.includes(t) ? 4 : 0), 0);
    for (const chunk of doc.chunks || []) {
      const text = chunk.text || '';
      let score = nameHit;
      for (const term of terms) {
        let from = 0;
        let count = 0;
        while (count < 5) {
          const at = text.indexOf(term, from);
          if (at === -1) break;
          count += 1;
          from = at + term.length;
        }
        if (count) score += count * (term.length >= 4 ? 4 : term.length === 3 ? 3 : 2);
      }
      if (score > 0) {
        // 长度归一化：500 字的许可证命中一次，比 40 万字的合同命中三次更说明问题
        const norm = score / Math.sqrt(1 + text.length / 800);
        hits.push({ doc, chunk, score: norm });
      }
    }
  }
  hits.sort((a, b) => b.score - a.score);
  // 同一份文档最多贡献 2 个片段，避免超大文档（如几十万字的 Excel）挤掉其他文件
  const seen = new Map();
  const picked = [];
  for (const hit of hits) {
    const key = hit.doc.mediaId || hit.doc.name;
    const used = seen.get(key) || 0;
    if (used >= 2) continue;
    seen.set(key, used + 1);
    picked.push(hit);
    if (picked.length >= 8) break;
  }
  return picked;
}

export default async function onRequest(context) {
  const { request, env } = context;
  // 默认不校验。需要重新加锁时，在 EdgeOne 环境变量里设置 REQUIRE_AUTH=1 即可，无需改代码。
  if (env.REQUIRE_AUTH === '1' && !authorized(request, env)) return unauthorized();

  const url = new URL(request.url);
  const route = url.pathname.replace(/\/+$/, '');

  try {
    if (route === '/api/documents') {
      return json(await getCatalogue(env));
    }

    if (route === '/api/file') {
      const id = url.searchParams.get('id') || '';
      if (!/^[A-Za-z0-9_-]{8,200}$/.test(id)) return json({ ok: false, message: '缺少有效的文件标识' }, 400);

      const info = await imaCall(env, 'get_media_info', { media_id: id });
      const target = info.url_info && info.url_info.url;
      if (!target) {
        return json({ ok: false, message: '该文件未开放下载，请到 ima 客户端查看原文' }, 404);
      }

      const name = url.searchParams.get('name') || '';
      let location = target;
      if (name) {
        const disposition = `attachment;filename*=UTF-8''${encodeURIComponent(name)}`;
        location += (target.includes('?') ? '&' : '?') + 'response-content-disposition=' + encodeURIComponent(disposition);
      }
      return new Response(null, {
        status: 302,
        headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
      });
    }

    if (route === '/api/cloud/status') {
      let imaOk = false;
      try { await findKnowledgeBase(env); imaOk = true; } catch { imaOk = false; }
      return json({
        ima: { configured: Boolean(env.IMA_CLIENT_ID), ready: imaOk, projects: [{ id: 'ruibang' }, { id: 'huoju' }] },
        model: { installed: Boolean(env.DEEPSEEK_API_KEY) },
        baidu: { connected: false },
      });
    }

    if (route === '/api/health') {
      const report = {
        build: 'health-v2-20261105',
        hasKey: Boolean(env.DEEPSEEK_API_KEY),
        keyLen: String(env.DEEPSEEK_API_KEY || '').length,
        hasSpace: /\s/.test(String(env.DEEPSEEK_API_KEY || '')),
        base: env.DEEPSEEK_BASE || '(默认)',
        modelEnv: env.DEEPSEEK_MODEL || '(默认)',
        hasBlobToken: Boolean(env.BLOB_TOKEN),
        blob: null,
        ima: null,
        modelCall: null,
      };
      try {
        const idx = await loadIndex(env, 'ruibang');
        report.blob = idx ? `ok docs=${idx.docs.length}` : 'null';
      } catch (error) { report.blob = 'ERR ' + String((error && error.message) || error).slice(0, 180); }
      try {
        const { kbId } = await findKnowledgeBase(env);
        report.ima = 'ok ' + kbId;
      } catch (error) { report.ima = 'ERR ' + String((error && error.message) || error).slice(0, 180); }
      try {
        const r = await answerWithModel(env, '测试', [], []);
        report.modelCall = 'ok ' + String(r.text || '').slice(0, 20);
      } catch (error) { report.modelCall = 'ERR ' + String((error && error.message) || error).slice(0, 220); }
      return json({ ok: true, report });
    }

    if (route === '/api/ask') {
      if (request.method !== 'POST') return json({ ok: false, message: '请使用 POST 请求' }, 405);
      const body = await request.json().catch(() => ({}));
      const question = String(body.question || '').trim().slice(0, 2000);
      if (!question) return json({ ok: false, message: '问题不能为空' }, 400);

      const project = String(body.project || '').trim();
      const indexProject = PROJECT_KEYS.includes(project) ? project : PROJECT_KEYS[0];
      let items = [];
      let mode = 'ima';

      // 优先用 Blob 里的正文索引；不可用或没命中时才回退 ima 文件检索
      try {
        const index = await loadIndex(env, indexProject);
        if (index && Array.isArray(index.docs)) {
          const scored = scoreIndex(index, question);
          if (scored.length) {
            mode = 'index';
            items = scored.map(h => ({
              name: h.doc.name,
              path: h.doc.path || h.doc.name,
              text: h.chunk.text || '',
              doc: h.doc,
              chunk: h.chunk,
            }));
          }
        }
      } catch (error) { /* Blob 未配置或不可用，走 ima 回退 */ }

      if (!items.length) {
        const { kbId } = await findKnowledgeBase(env);
        const collected = new Map();
        for (const query of planQueries(question)) {
          if (collected.size >= 8) break;
          for (const hit of await searchFiles(env, kbId, query, 8)) {
            if (!collected.has(hit.media_id)) collected.set(hit.media_id, hit);
          }
        }
        items = [...collected.values()].slice(0, 8).map(file => ({
          name: file.title,
          path: file.path,
          text: '',
          doc: { mediaId: file.media_id, name: file.title },
          chunk: null,
        }));
      }

      let text = '';
      let model = '';
      let modelError = '';
      try {
        const answer = await answerWithModel(env, question, items, body.history);
        text = answer.text;
        model = answer.model;
      } catch (error) {
        modelError = String((error && error.message) || error).slice(0, 200);
        const names = items.slice(0, 5).map((it, i) => `${i + 1}. ${it.name}`).join('\n');
        text = `大模型暂时不可用（${modelError}）。\n\n已从资料中检索到 ${items.length} 项相关内容：\n${names || '（无）'}\n\n请先按上述文件人工核对；管理员修复模型密钥后即可正常作答。`;
      }

      const sources = items.slice(0, 3).map(item => ({
        doc: {
          id: item.doc.mediaId || item.doc.id,
          name: item.name,
          path: item.path,
          type: extension(item.name),
          category: category(item.path || item.name),
          project: indexProject,
          source: 'ima',
          size: null,
        },
        chunk: { location: item.chunk?.loc || (item.text ? '正文摘录' : 'ima 检索命中'), text: (item.text || '').slice(0, 200) },
      }));

      return json({ ok: true, text, sources, mode, model: { provider: 'DeepSeek', connected: true, name: model }, files: items.length });
    }

    return json({ ok: false, message: '接口不存在' }, 404);
  } catch (error) {
    const message = error && error.upstream ? String(error.message) : '服务暂时不可用，请稍后重试';
    const detail = env.DEBUG === '1' && error ? String(error.stack || error.message).slice(0, 400) : undefined;
    return json({ ok: false, message, detail }, 502);
  }
}
