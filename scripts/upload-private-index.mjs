import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {getStore} from '@edgeone/pages-blob';
const root=process.argv[2];
if(!root||!process.env.BLOB_TOKEN)throw new Error('Provide a private index directory and BLOB_TOKEN in the process environment');
const store=getStore({name:'zc-index',projectId:process.env.BLOB_PROJECT_ID||'makers-cnwks8jmg4xl',token:process.env.BLOB_TOKEN});
for(const name of ['ruibang.json','huoju.json','manifest.json']) {
 const text=readFileSync(path.join(root,name),'utf8'),data=JSON.parse(text);
 if(data.version!==2)throw new Error('Index version must be 2');
 const key='v2/'+name;
 await store.set(key,text,{contentType:'application/json'});
 const back=await store.get(key,{type:'text'});
 const hash=s=>createHash('sha256').update(s).digest('hex');
 if(hash(back)!==hash(text))throw new Error('Read-back verification failed for '+name);
 console.log(JSON.stringify({file:name,bytes:Buffer.byteLength(text),verified:true}));
}
