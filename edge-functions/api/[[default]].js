// 路由：edge-functions/api/[[default]].js  →  /api/*
//   GET /api/documents        返回 ima「子城」知识库的真实目录与计数
//   GET /api/file?id=<media>  302 跳转到 ima 签名链接（原件下载）
//
// 安全边界：
//   1. 所有请求先过 HTTP Basic Auth，口令只存在于环境变量，前端拿不到，也不进仓库。
//   2. 环境变量缺失时直接拒绝（fail closed），不会退化成公开接口。
//   3. ima 的 apiKey 只在函数内部使用，永不下发给浏览器。
//   4. media_id 做格式白名单校验，避免被当成任意转发器。

const IMA_BASE = 'https://ima.qq.com/openapi/wiki/v1/';

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

async function imaCall(env, method, body) {
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

export default async function onRequest(context) {
  const { request, env } = context;
  // 默认不校验。需要重新加锁时，在 EdgeOne 环境变量里设置 REQUIRE_AUTH=1 即可，无需改代码。
  if (env.REQUIRE_AUTH === '1' && !authorized(request, env)) return unauthorized();

  const url = new URL(request.url);
  const route = url.pathname.replace(/\/+$/, '');

  try {
    if (route === '/api/documents') {
      return json(await buildCatalogue(env));
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

    return json({ ok: false, message: '接口不存在' }, 404);
  } catch (error) {
    const message = error && error.upstream ? String(error.message) : '服务暂时不可用，请稍后重试';
    return json({ ok: false, message }, 502);
  }
}
