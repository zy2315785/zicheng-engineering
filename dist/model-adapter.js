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

async function askServer(question,options){
  const res=await fetch('/api/ask',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({question,project:options.project,history:options.history??[]})
  });
  if(!res.ok)throw new Error('ask '+res.status);
  const data=await res.json();
  if(!data||typeof data.text!=='string'||!Array.isArray(data.sources))throw new Error('bad payload');
  return data;
}

export async function retrieveAnswer(documents,question,options={}){
  if(location.protocol==='file:')return localAnswer(documents,question,options);
  try{
    return await askServer(question,options);
  }catch{
    return localAnswer(documents,question,options);
  }
}
