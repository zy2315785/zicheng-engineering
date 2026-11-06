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
  '你是子城联合工程部的工程资料助手，依据检索到的原文摘录回答同事的问题。',
  '规则：',
  '1. 只依据摘录作答，禁止编造摘录中没有的日期、金额、条款或人名。',
  '2. 每个结论后面用方括号标注依据编号，例如 [1]、[2]，编号对应摘录序号；引用时必须写出文件全名。',
  '3. 如果多份摘录的数字或说法互相矛盾，不要挑一个，要明确指出“A 文件写 X，B 文件写 Y”，并说明差异。',
  '4. 结构固定为三段：结论（一两句）→ 依据（逐条，带 [n] 与文件名）→ 尚缺（需要补充什么材料才能确认）。',
  '5. 摘录里出现「看不清」「[?]」「未逐页收录」时，如实说明该处原件不清或未收录，不要补全。',
  '6. 全部用简体中文，正文控制在四百字以内。',
].join('\n');

// 结果不足时，让模型把问题换个说法，再检索一轮
async function expandQueriesWithModel(env, question) {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) return [];
  const base = (env.DEEPSEEK_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = env.DEEPSEEK_MODEL || 'deepseek-chat';
  const resp = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 120,
      messages: [
        { role: 'system', content: '你是工程资料检索助手。把用户的问题改写成 3 条不同的检索式，覆盖同义说法和行业习惯叫法。每行一条，不要编号，不要解释。' },
        { role: 'user', content: String(question).slice(0, 300) },
      ],
    }),
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  return text.split('\n')
    .map(line => line.replace(/^[\s\d.、)）-]+/, '').trim())
    .filter(line => line.length >= 2 && line.length <= 40)
    .slice(0, 3);
}

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

// ── 云端 agent：给模型可调用的工具，允许它多轮查阅后作答 ──
const AGENT_PROMPT = SYSTEM_PROMPT + '\n\n' +
  '你有两个工具：search_docs（换关键词检索）和 read_document（打开某份文件看全文或按关键词定位）。\n' +
  '遇到以下情况必须调用工具再查一次，不要直接下结论：\n' +
  '- 首轮摘录里没有你要的数字或条款；\n' +
  '- 多个说法可能对应同一件事（如“开工日期/合同工期”“甲方/发包人”）；\n' +
  '- 需要核对原件原文，而不是只看摘录片段。\n' +
  '最多查三轮。查到足够证据就立即作答，不要为了查而查。';

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_docs',
      description: '在当前项目资料中按关键词检索正文。可换多种说法反复调用，例如“开工日期”“合同工期”“开工报告”。',
      parameters: { type: 'object', properties: { query: { type: 'string', description: '检索关键词，2-10 字效果最好' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_document',
      description: '打开某份已检索到的文件查看更完整正文。可用 keyword 定位到关键词附近，或用 offset 从指定位置继续读。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '文件名，可只写关键部分' },
          keyword: { type: 'string', description: '要定位的关键词' },
          offset: { type: 'integer', description: '从第几个字符开始读，默认从头' },
        },
        required: ['name'],
      },
    },
  },
];

function agentFindDoc(index, name) {
  const target = String(name || '').trim();
  if (!target) return null;
  const docs = index.docs || [];
  const bare = (s) => String(s || '').replace(/\.[a-z0-9]+$/i, '');
  return docs.find(d => d.name === target)
    || docs.find(d => d.name.includes(target))
    || docs.find(d => bare(d.name).includes(bare(target)))
    || null;
}

async function agentRunTool(env, index, name, rawArgs, seen) {
  let args = {};
  try { args = JSON.parse(rawArgs || '{}') || {}; } catch { args = {}; }
  if (name === 'search_docs') {
    const hits = scoreIndex(index, String(args.query || '')).slice(0, 5);
    if (!hits.length) return '没有检索到相关内容，换一种说法（同义词、简称、行业叫法）再试。';
    for (const hit of hits) if (!seen.some(d => d.name === hit.doc.name)) seen.push(hit.doc);
    return hits.map((hit, i) => `[${i + 1}] ${hit.doc.name}\n${String(hit.chunk.text || '').slice(0, 1200)}`).join('\n\n');
  }
  if (name === 'read_document') {
    const doc = agentFindDoc(index, args.name);
    if (!doc) return `未找到「${args.name}」。请先用 search_docs 确认准确文件名。`;
    if (!seen.some(d => d.name === doc.name)) seen.push(doc);
    let full = (doc.chunks || []).map(c => c.text).join('\n');

    // 不在边缘函数里现读原件：实测中文 PDF 多为扫描图或 CID 字体，
    // 需要逐页解压 + ToUnicode 映射才能还原文字，CPU 与包体都超出边缘函数限制。
    const source = '';
    if (!full.trim()) {
      return `《${doc.name}》尚未收录可检索正文，原件也无法在线解析（可能是扫描件）。可提示用户用「下载原件」查看。`;
    }
    if (args.keyword) {
      const keyword = String(args.keyword);
      const at = full.indexOf(keyword);
      if (at < 0) return `《${doc.name}》中没有出现「${keyword}」。全文开头如下：\n${full.slice(0, 1500)}`;
      return `《${doc.name}》${source}中「${keyword}」附近：\n${full.slice(Math.max(0, at - 300), at + 900)}`;
    }
    const offset = Math.max(0, Number(args.offset) || 0);
    const piece = full.slice(offset, offset + 2500);
    const more = offset + 2500 < full.length ? `\n（未读完，可继续用 offset=${offset + 2500}）` : '';
    return `《${doc.name}》${source}第 ${offset} 字起：\n${piece}${more}`;
  }
  return '未知工具。';
}

async function runAgent(env, index, question, history, seedItems) {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('未配置 DEEPSEEK_API_KEY');
  const base = (env.DEEPSEEK_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = env.DEEPSEEK_MODEL || 'deepseek-chat';
  const seed = seedItems.length
    ? seedItems.slice(0, 5).map((it, i) => `【摘录${i + 1}】${it.name}\n${String(it.text || '').slice(0, 700)}`).join('\n\n')
    : '（首轮没有检索到结果，请自行用 search_docs 检索）';

  const messages = [{ role: 'system', content: AGENT_PROMPT }];
  for (const turn of (history || []).slice(-2)) {
    if (turn && turn.question) messages.push({ role: 'user', content: String(turn.question).slice(0, 200) });
    if (turn && turn.answer) messages.push({ role: 'assistant', content: String(turn.answer).slice(0, 200) });
  }
  messages.push({ role: 'user', content: `问题：${question}\n\n<首轮检索>\n${seed}\n</首轮检索>` });

  const seen = [];
  const maxSteps = 6;
  const startedAt = Date.now();
  for (let step = 0; step <= maxSteps; step++) {
    // 超过 20 秒强制收敛，避免 6 轮把边缘函数拖到超时
    const final = step === maxSteps || Date.now() - startedAt > 20000;
    if (final) messages.push({ role: 'user', content: '已达到查阅轮数。请依据现有证据完成回答，并说明尚未查清的部分，不再调用工具。' });
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 900, stream: false, tools: AGENT_TOOLS, tool_choice: final ? 'none' : 'auto' }),
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(`模型返回 ${response.status}：${payload?.error?.message || ''}`.slice(0, 160));
      error.upstream = true;
      throw error;
    }
    const message = payload?.choices?.[0]?.message || {};
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!calls.length) {
      const text = String(message.content || '').trim();
      if (!text) throw new Error('模型没有返回答案');
      return { text, model, rounds: step, docs: seen };
    }
    messages.push({ role: 'assistant', content: message.content || '', tool_calls: calls });
    for (const call of calls.slice(0, 3)) {
      let output = '';
      try { output = await agentRunTool(env, index, call.function?.name, call.function?.arguments, seen); } catch (error) { output = '工具执行失败：' + String((error && error.message) || error).slice(0, 120); }
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(output).slice(0, 4000) });
    }
  }
  throw new Error('查阅轮数超限');
}

// ── 云端读原件：ima 签名地址下载 + PDF 文本层抽取 ──
async function fetchImaOriginal(env, mediaId) {
  if (!mediaId) return null;
  const info = await imaCall(env, 'get_media_info', { media_id: mediaId });
  const target = info && info.url_info && info.url_info.url;
  if (!target) return null;
  const response = await fetch(target);
  if (!response.ok) return null;
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > 12 * 1024 * 1024) return null; // 超过 12MB 不解析，避免拖垮边缘函数
  return new Uint8Array(buffer);
}

async function inflateBytes(bytes) {
  for (const format of ['deflate', 'deflate-raw']) {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (error) { /* 试下一种 */ }
  }
  return null;
}

const PDF_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };

function decodePdfString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = raw[i + 1];
    i++;
    if (PDF_ESCAPES[next] !== undefined) { out += PDF_ESCAPES[next]; continue; }
    if (/[0-7]/.test(next || '')) {
      let oct = next;
      while (oct.length < 3 && /[0-7]/.test(raw[i + 1] || '')) { oct += raw[++i]; }
      out += String.fromCharCode(parseInt(oct, 8));
      continue;
    }
  }
  return out;
}

function extractPdfText(raw) {
  const pieces = [];
  const re = /\((?:\\.|[^\\()])*\)\s*Tj|\[(?:[^\]]|\\.)*\]\s*TJ|T\*|\bET\b/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const token = match[0];
    if (token === 'T*' || token === 'ET') { pieces.push('\n'); continue; }
    const inner = token.slice(0, token.lastIndexOf(']') >= 0 ? token.lastIndexOf(']') + 1 : token.lastIndexOf(')') + 1);
    const strings = inner.match(/\((?:\\.|[^\\()])*\)/g) || [];
    for (const item of strings) pieces.push(decodePdfString(item.slice(1, -1)));
    if (!strings.length && inner !== token) pieces.push(' ');
  }
  return pieces.join('').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

async function pdfTextLayer(bytes) {
  const latin = new TextDecoder('latin1').decode(bytes);
  const chunks = [];
  const re = /stream\r?\n?([\s\S]*?)endstream/g;
  let match;
  let count = 0;
  while ((match = re.exec(latin)) !== null && count < 260) {
    count++;
    // 起点 = 匹配处 + "stream\r\n" 的长度；必须再减掉结尾 "endstream" 的 9 个字符
    const start = match.index + (match[0].length - match[1].length - 'endstream'.length);
    let length = match[1].length;
    // endstream 前常有 \r\n，留着会让解压器报“尾部有多余字节”
    while (length > 0 && (bytes[start + length - 1] === 0x0d || bytes[start + length - 1] === 0x0a || bytes[start + length - 1] === 0x20)) length--;
    const raw = bytes.subarray(start, start + length);
    let decoded = null;
    if (raw.length > 2) decoded = await inflateBytes(raw);
    const text = decoded ? extractPdfText(new TextDecoder('latin1').decode(decoded)) : extractPdfText(match[1]);
    if (text && text.length > 20) chunks.push(text);
  }
  return chunks.join('\n').slice(0, 20000);
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

// 工程资料里的同义说法：用户问“开工日期”，文件里写“合同工期”，纯字面匹配会漏。
const SYNONYM_GROUPS = [
  ['开工日期', '开工', '动工', '合同工期', '开工报告', '开工令', '施工许可'],
  ['竣工日期', '竣工', '完工', '交工', '验收'],
  ['建设单位', '发包人', '甲方', '业主', '开发单位'],
  ['施工单位', '承包人', '乙方', '总承包', '总承包单位', '承建', '中标单位'],
  ['监理单位', '监理', '总监', '总监理工程师'],
  ['设计单位', '设计人', '设计院', '设计负责人'],
  ['造价', '合同价', '合同造价', '中标价', '合同金额', '签约合同价', '合同价格'],
  ['面积', '建筑面积', '总建筑面积', '计容面积', '用地面积'],
  ['许可', '许可证', '审批', '批文', '备案'],
  ['质保', '保修', '缺陷责任', '质量保证'],
  ['违约', '罚款', '赔偿', '违约金'],
  ['付款', '支付', '进度款', '预付款', '结算'],
];

function expandTerms(question) {
  const extra = [];
  for (const group of SYNONYM_GROUPS) {
    if (group.some(t => question.includes(t))) extra.push(...group);
  }
  return extra;
}

// 关键词打分：命中次数 × 词长权重，文件名命中额外加权。
function scoreIndex(index, question) {
  const terms = [...new Set(
    planQueries(question)
      .concat(chineseTerms(question))
      .concat(expandTerms(question))
  )]
    .filter(t => t.length >= 2)
    .slice(0, 48);
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
      let indexForRetry = null;

      // 优先用 Blob 里的正文索引；不可用或没命中时才回退 ima 文件检索
      try {
        const index = await loadIndex(env, indexProject);
        if (index && Array.isArray(index.docs)) {
          indexForRetry = index;
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

      // 第二轮：命中太少时换说法再检索（多轮检索）
      if (indexForRetry && items.length < 4) {
        try {
          const extraQueries = await expandQueriesWithModel(env, question);
          const seen = new Set(items.map(it => (it.doc.mediaId || it.doc.name) + '|' + (it.chunk?.loc || '')));
          for (const query of extraQueries) {
            for (const hit of scoreIndex(indexForRetry, query)) {
              const key = (hit.doc.mediaId || hit.doc.name) + '|' + (hit.chunk.loc || '');
              if (seen.has(key)) continue;
              seen.add(key);
              items.push({ name: hit.doc.name, path: hit.doc.path || hit.doc.name, text: hit.chunk.text || '', doc: hit.doc, chunk: hit.chunk });
              if (items.length >= 8) break;
            }
            if (items.length >= 8) break;
          }
          if (items.length) mode = 'index';
        } catch (error) { /* 扩展检索失败不影响主流程 */ }
      }

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
      let agentRounds = 0;
      try {
        // 先走 agent：模型可多轮调工具查阅；失败或超时自动退回单轮，保证一定能答
        if (indexForRetry && items.length >= 2) {
          try {
            const agent = await runAgent(env, indexForRetry, question, body.history, items);
            text = agent.text;
            model = agent.model;
            agentRounds = agent.rounds;
            if (agent.docs.length) {
              items = agent.docs.slice(0, 6).map(doc => ({
                name: doc.name,
                path: doc.path || doc.name,
                text: ((doc.chunks || [])[0] || {}).text || '',
                doc,
                chunk: (doc.chunks || [])[0] || null,
              }));
            }
          } catch (error) { /* 退回单轮作答 */ }
        }
        if (!text) {
          const answer = await answerWithModel(env, question, items, body.history);
          text = answer.text;
          model = answer.model;
        }
      } catch (error) {
        modelError = String((error && error.message) || error).slice(0, 200);
        const names = items.slice(0, 5).map((it, i) => `${i + 1}. ${it.name}`).join('\n');
        text = `大模型暂时不可用（${modelError}）。\n\n已从资料中检索到 ${items.length} 项相关内容：\n${names || '（无）'}\n\n请先按上述文件人工核对；管理员修复模型密钥后即可正常作答。`;
      }

      const sources = items.slice(0, 8).map(item => ({
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

      return json({ ok: true, text, sources, mode: agentRounds ? 'agent' : mode, rounds: agentRounds, model: { provider: 'DeepSeek', connected: true, name: model }, files: items.length });
    }

    return json({ ok: false, message: '接口不存在' }, 404);
  } catch (error) {
    const message = error && error.upstream ? String(error.message) : '服务暂时不可用，请稍后重试';
    const detail = env.DEBUG === '1' && error ? String(error.stack || error.message).slice(0, 400) : undefined;
    return json({ ok: false, message, detail }, 502);
  }
}
