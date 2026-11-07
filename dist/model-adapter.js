import {answerQuestion} from './search.js';

/** Model and cloud credentials stay in the backend. Offline fallback is explicitly local retrieval. */
function localAnswer(documents,question,options){
  const result=answerQuestion(documents,question,options);
  return {
    ...result,
    sources:result.sources.map(({doc,chunk,...rest})=>{
      const {chunks,...metadata}=doc;
      return {...rest,doc:metadata,chunk};
    }),
    model:{provider:'本机检索',connected:false,name:'关键词检索'}
  };
}

async function post(url,body){
  const res=await fetch(url,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body),
    signal:AbortSignal.timeout(115000)
  });
  const data=await res.json();
  if(!res.ok||data?.ok===false)throw new Error(data?.message||'本次云端问答未完成，请重试。');
  return data;
}
async function askServer(question,options){
  let data=await post('/api/ask',{question,project:options.project,history:options.history??[]});
  // Each request executes one model round or one tool. Long investigations do not
  // depend on a single function invocation. The cursor is authenticated ciphertext.
  for(let step=0;data.pending&&step<95;step++){
    options.onProgress?.({trace:data.trace||[],rounds:data.rounds||0});
    data=await post('/api/agent/step',{cursor:data.cursor});
  }
  if(data.pending)throw new Error('查阅步骤达到上限，请缩小问题范围后重试。');
  if(typeof data.text!=='string'||!Array.isArray(data.sources))throw new Error('云端返回内容不完整，请重试。');
  return data;
}

export async function retrieveAnswer(documents,question,options={}){
  if(location.protocol==='file:')return localAnswer(documents,question,options);
  try{
    return await askServer(question,options);
  }catch(error){
    return {text:error?.message||'云端问答未完成，请重试。',sources:[],model:{provider:'DeepSeek',connected:false},error:true};
  }
}
