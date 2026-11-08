import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Run only as the paused project's CI build command, in its disposable checkout.
// The source dist directory, credentials and private storage are never removed.
export async function buildMaintenance(root) {
 const output=resolve(root,'paused-dist');
 await mkdir(output,{recursive:true});
 const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>服务已暂停 · 子城联合工程部</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:28px;background:#f8f6f2;color:#604c3f;font-family:system-ui,"Microsoft YaHei",sans-serif}main{max-width:620px;background:white;border:1px solid #e7dfd2;border-top:5px solid #631014;border-radius:18px;padding:48px;box-shadow:0 20px 70px #604c3f0c}.brand{font-size:17px;letter-spacing:3px;color:#631014}h1{font-size:32px;color:#631014;margin:30px 0 18px}p{font-size:19px;line-height:1.9;margin:0}small{display:block;border-top:1px solid #eee6db;margin-top:32px;padding-top:22px;font-size:14px;color:#948575}</style></head><body><main><div class="brand">子城联合 · 工程部</div><h1>境外站点已暂停服务</h1><p>工程知识助手已暂时关闭此访问入口，项目资料查询、问答和原件下载暂停提供。</p><small>项目配置已保留，恢复时间由工程部另行通知。</small></main></body></html>`;
 await Promise.all(['index.html','404.html'].map(name=>writeFile(resolve(output,name),html)));
 const entry=resolve(root,'cloud-functions/api/[[default]].js');
 await mkdir(dirname(entry),{recursive:true});
 await writeFile(entry,`export function onRequest() { return new Response(JSON.stringify({ok:false,paused:true,message:'境外站点已暂停服务'}),{status:503,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Retry-After':'86400'}}); }\n`);
 const configPath=resolve(root,'edgeone.json');
 const config=JSON.parse(await readFile(configPath,'utf8'));
 config.outputDirectory='paused-dist';
 config.headers=[{source:'/(.*)',headers:[{key:'Cache-Control',value:'no-store'}]}];
 await writeFile(configPath,JSON.stringify(config,null,2)+'\n');
 return {output,entry};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 await buildMaintenance(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
 console.log('Paused site built; public API routes return 503 without upstream calls.');
}
