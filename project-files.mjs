import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const APP_ROOT=path.dirname(fileURLToPath(import.meta.url));
export const AI_ROOT=path.dirname(APP_ROOT);
export const PROJECTS=JSON.parse(fs.readFileSync(path.join(APP_ROOT,'projects.json'),'utf8'));
export const projectConfig=id=>PROJECTS.find(p=>p.id===id&&p.connected);
export const normalizeName=value=>String(value??'').normalize('NFKC').replace(/[\s（）()·、，,._-]/g,'').toLowerCase();
export const isExcluded=value=>/身份证|公章|通讯录|马奇年\.pdf|开票资料|(?:^|\/)~\$/i.test(String(value??''));

export function localDocumentPath(doc){
  const project=projectConfig(doc?.project);
  if(!project||!doc.path||isExcluded(doc.path))throw Object.assign(new Error('资料不在已接入项目范围内。'),{status:403});
  const root=path.resolve(AI_ROOT,project.folder);
  const target=path.resolve(root,doc.path);
  if(!target.startsWith(root+path.sep))throw Object.assign(new Error('资料路径无效。'),{status:403});
  if(!fs.existsSync(target))throw Object.assign(new Error('本地原件已删除或更新。'),{status:404});
  if(!fs.realpathSync(target).startsWith(fs.realpathSync(root)+path.sep))throw Object.assign(new Error('不允许访问项目外文件。'),{status:403});
  return target;
}
