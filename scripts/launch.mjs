import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const AI=path.dirname(ROOT);
const LOCAL=path.join(ROOT,'.local');
const STATE=path.join(LOCAL,'server-state.json');
const INSTANCE=createHash('sha256').update(ROOT.toLowerCase()).digest('hex').slice(0,20);
const args=new Set(process.argv.slice(2));
fs.mkdirSync(LOCAL,{recursive:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function health(port){
  try{const r=await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(700)});return r.ok?await r.json():null}catch{return null}
}
function readState(){try{return JSON.parse(fs.readFileSync(STATE,'utf8'))}catch{return null}}
function openBrowser(url){
  if(args.has('--no-browser'))return;
  if(process.platform==='win32'){
    const child=spawn(process.env.ComSpec??'cmd.exe',['/d','/c','start','',url],{stdio:'ignore',windowsHide:true});
    child.on('error',()=>console.log(`请手动打开浏览器：${url}`));
  }else console.log(`请手动打开浏览器：${url}`);
}
async function freePort(port){return new Promise(resolve=>{const s=net.createServer();s.once('error',()=>resolve(false));s.listen(port,'127.0.0.1',()=>s.close(()=>resolve(true)))});}
async function stop(){
  const saved=readState();
  const current=saved?await health(saved.port):null;
  if(!current||current.instanceId!==INSTANCE||current.pid!==saved.pid){console.log('当前文件夹没有正在运行的工程助手。');return}
  if(saved.stopToken){
    const response=await fetch(`http://127.0.0.1:${saved.port}/api/shutdown`,{method:'POST',headers:{'Content-Type':'application/json','X-ZC-Stop-Token':saved.stopToken},body:'{}',signal:AbortSignal.timeout(3000)});
    if(!response.ok)throw new Error('本地服务拒绝停止请求，请核对当前文件夹。');
  }else process.kill(saved.pid);
  for(let i=0;i<30;i++){await delay(100);if(!await health(saved.port))break}
  if(await health(saved.port))throw new Error('本地服务仍在退出，请稍后重试。');
  fs.writeFileSync(STATE,'null');
  console.log('工程助手已停止。');
}
function updateIndex(){
  if(args.has('--skip-index'))return;
  const python=path.join(AI,'runtime','python','python.exe');
  if(!fs.existsSync(python))throw new Error('缺少 runtime/python/python.exe，请完整解压便携包，不要单独复制启动器。');
  console.log('正在同步已接入项目资料目录…');
  const r=spawnSync(python,['-I','-B',path.join(ROOT,'scripts','index-project.py')],{cwd:ROOT,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});
  fs.writeFileSync(path.join(LOCAL,'index.log'),(r.stdout??'')+'\n'+(r.stderr??''),'utf8');
  if(r.status!==0)throw new Error('资料索引更新失败，请查看 zicheng-engineering/.local/index.log。原文件未修改。');
  try{const stats=JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));console.log(`目录 ${stats.files} 份，可检索正文 ${stats.indexed} 份。`)}catch{console.log('资料目录已更新。')}
}
async function launch(){
  if(!fs.existsSync(path.join(AI,'瑞邦国际大厦')))throw new Error('缺少瑞邦国际大厦文件夹，请保持完整 AI 目录结构。');
  updateIndex();
  const saved=readState();
  if(saved){const live=await health(saved.port);if(live?.instanceId===INSTANCE&&live.pid===saved.pid){const url=`http://127.0.0.1:${saved.port}`;console.log(`工程助手已在运行：${url}`);openBrowser(url);return}}
  let port;
  for(let p=4173;p<4203;p++){
    const live=await health(p);
    if(live?.instanceId===INSTANCE){fs.writeFileSync(STATE,JSON.stringify({pid:live.pid,port:p}));openBrowser(`http://127.0.0.1:${p}`);console.log(`工程助手已在运行：http://127.0.0.1:${p}`);return}
    if(await freePort(p)){port=p;break}
  }
  if(!port)throw new Error('本地端口4173–4202均不可用，请关闭其他本地服务后重试。');
  const log=fs.openSync(path.join(LOCAL,'server.log'),'a');
  const stopToken=randomBytes(32).toString('hex');
  const child=spawn(process.execPath,[path.join(ROOT,'server.mjs')],{cwd:ROOT,env:{...process.env,PORT:String(port),ZC_INSTANCE_STOP_TOKEN:stopToken},detached:true,stdio:['ignore',log,log],windowsHide:true});
  fs.closeSync(log);
  child.on('error',error=>console.error(error.message));
  child.unref();
  for(let i=0;i<60;i++){
    const live=await health(port);
    if(live?.instanceId===INSTANCE&&live.pid===child.pid){
      fs.writeFileSync(STATE,JSON.stringify({pid:child.pid,port,stopToken}));
      const url=`http://127.0.0.1:${port}`;
      console.log(`工程助手已启动：${url}`);
      openBrowser(url);return;
    }
    await delay(200);
  }
  try{child.kill()}catch{}
  throw new Error('本地服务未能启动，请查看 zicheng-engineering/.local/server.log。');
}
try{if(args.has('--stop'))await stop();else if(args.has('--refresh-only'))updateIndex();else await launch()}catch(error){console.error(error.message);process.exitCode=1}
