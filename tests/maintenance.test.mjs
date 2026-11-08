import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {buildMaintenance} from '../scripts/build-maintenance.mjs';

test('暂停部署隔离静态入口，所有API返回503且不访问任何上游服务',async()=>{
 const root=await mkdtemp(resolve(tmpdir(),'zc-maintenance-'));
 try {
  await mkdir(resolve(root,'dist'));
  await writeFile(resolve(root,'dist/index.html'),'original workspace');
  await writeFile(resolve(root,'edgeone.json'),JSON.stringify({outputDirectory:'dist',cloudFunctions:{maxDuration:120}}));
  const {output,entry}=await buildMaintenance(root);
  assert.equal(await readFile(resolve(root,'dist/index.html'),'utf8'),'original workspace');
  assert.match(await readFile(resolve(output,'index.html'),'utf8'),/境外站点已暂停服务/);
  const config=JSON.parse(await readFile(resolve(root,'edgeone.json'),'utf8'));
  assert.equal(config.outputDirectory,'paused-dist');
  assert.equal(config.cloudFunctions.maxDuration,120);
  const code=await readFile(entry,'utf8');
  const {onRequest}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
  for(const route of ['/api/health','/api/documents','/api/ask','/api/agent/step','/api/file?id=example']) {
   const result=await onRequest({request:new Request('https://example.test'+route),get env(){throw new Error('paused API must not read credentials')}});
   assert.equal(result.status,503);
   assert.equal(result.headers.get('cache-control'),'no-store');
   assert.equal((await result.json()).paused,true);
  }
 }finally {
  // This test deletes only the exact temporary directory created by mkdtemp.
  assert.ok(root.startsWith(resolve(tmpdir(),'zc-maintenance-')));
  await rm(root,{recursive:true,force:true});
 }
});
