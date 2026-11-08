import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCatalogue,filterCoverage,catalogueSnapshot,usableSnapshot} from '../dist/catalogue-model.js';
test('metadata-only catalogue does not claim every file has searchable text',()=>{
 const payload={documents:[{id:'a',name:'原件.pdf',folder:'项目',hasText:true},{id:'b',name:'未解析.pdf',folder:'项目'},{id:'c',name:'图片.jpg',folder:'项目',hasText:false}]};
 const normalized=normalizeCatalogue(payload,[{id:'test',imaFolder:'项目'}]);
 assert.deepEqual(normalized.documents.map(d=>d.status),['indexed','catalog','catalog']);
 assert.equal(filterCoverage(normalized.documents,'indexed').length,1);
 assert.equal(filterCoverage(normalized.documents,'all').length,3);
 assert(normalized.documents.every(d=>d.project==='test'));
});
test('browser snapshot carries directory metadata, no full document body',()=>{
 const snapshot=catalogueSnapshot({documents:[{id:'a',name:'a.pdf',chunks:[{text:'private document body'}]}]});
 assert(usableSnapshot(snapshot));assert(!JSON.stringify(snapshot).includes('private document body'));
 assert(!usableSnapshot({documents:[]}));assert(!usableSnapshot({documents:[{name:'missing ID'}]}));
});
