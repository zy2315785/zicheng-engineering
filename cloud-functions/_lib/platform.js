import {getStore} from '@edgeone/pages-blob';
const IMA_BASE='https://ima.qq.com/openapi/wiki/v1/';
const BLOB_STORE='zc-index';
const BLOB_PROJECT='makers-cnwks8jmg4xl';

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
    signal: AbortSignal.timeout(10000),
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
      if (!title || /身份证|公章|通讯录|马奇年\.pdf|开票资料|^~\$/i.test(title)) continue;
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

// Node runtime cache + private persistent metadata snapshot (no document bodies).
const catalogueMemory=new Map();
const CATALOGUE_KEY='catalogue-v3.json';
function indexStore(env){return env.BLOB_TOKEN?getStore({name:BLOB_STORE,projectId:env.BLOB_PROJECT_ID||BLOB_PROJECT,token:env.BLOB_TOKEN}):getStore(BLOB_STORE);}
async function enrichCatalogue(env,data){
 const indexes=await Promise.all(['ruibang','huoju'].map(p=>loadIndex(env,p).catch(()=>null)));
 const indexed=new Map(indexes.flatMap(i=>i?.docs||[]).map(d=>[d.mediaId,d]));
 return {...data,documents:data.documents.map(d=>{const match=indexed.get(d.id);return {...d,category:match?.category||category(d.path.split('/').slice(1).join('/')),hasText:match?Boolean(match.chunks?.length):false,status:match?.chunks?.length?'indexed':'catalog'};})};
}
async function getCatalogue(env,{refresh=false}={}){
 const key=env.IMA_CLIENT_ID||'default',old=catalogueMemory.get(key);
 if(!refresh&&old&&Date.now()-old.time<60000)return old.data;
 if(old?.pending)return old.pending;
 const pending=(async()=>{
  if(!refresh){try{const saved=await indexStore(env).get(CATALOGUE_KEY,{type:'json'});if(saved?.documents?.length){catalogueMemory.set(key,{time:Date.now(),data:saved});return saved;}}catch{}}
  const data=await enrichCatalogue(env,await buildCatalogue(env));
  await indexStore(env).setJSON(CATALOGUE_KEY,data);
  catalogueMemory.set(key,{time:Date.now(),data});return data;
 })();
 catalogueMemory.set(key,{...old,pending});
 try{return await pending;}catch(error){if(old?.data){catalogueMemory.set(key,old);return {...old.data,syncFailed:true};}catalogueMemory.delete(key);throw error;}
}

async function findKnowledgeBase(env) {
  const kbName = env.IMA_KB_NAME || '子城';
  const search = await imaCall(env, 'search_knowledge_base', { query: kbName, cursor: '', limit: 20 });
  const kb = (search.info_list || []).find(b => (b.name || b.kb_name) === kbName);
  if (!kb) throw new Error(`ima 中没有名为「${kbName}」的知识库`);
  return { kbId: kb.id || kb.kb_id, kbName };
}

async function loadIndex(env, project) {
  const key = `v2/${project}.json`;
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
  if(!data || data.project!==project || data.version!==2)throw new Error('当前项目的 v2 索引尚未准备就绪');
  if (cache && data) {
    try {
      await cache.put(cacheKey, new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'max-age=600' },
      }));
    } catch { /* 写缓存失败不影响返回 */ }
  }
  return data;
}


export {imaCall,getCatalogue,findKnowledgeBase,loadIndex,authorized,unauthorized,json,extension,category};
