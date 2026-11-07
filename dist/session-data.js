/** Drop deleted or changed source excerpts from browser history. */
export function reconcileSavedState(documents,history,favorites) {
  const known=new Map(documents.map(d=>[d.id,d]));
  const cleanHistory=history.map(session=>({...session,messages:session.messages.map(message=>{
    if(!message.result)return message;
    let changed=false;
    const sources=(message.result.sources??[]).flatMap(source=>{
      const current=known.get(source.doc?.id);
      if(!current||current.project!==session.project){changed=true;return []}
      // A cloud catalogue contains metadata only. It cannot prove that a saved
      // excerpt disappeared. Preserve it as a dated snapshot while the file exists.
      if(current.source==='ima'&&['ima','index-cache'].includes(source.doc?.source)){
        const {chunks,...metadata}=current;
        return [{...source,doc:{...metadata,source:source.doc.source},chunk:source.chunk,snapshot:true}];
      }
      let chunk=null;
      if(source.chunk){
        chunk=current.chunks?.find(c=>c.location===source.chunk.location&&c.text===source.chunk.text);
        if(!chunk){changed=true;return []}
      }
      const {chunks,...doc}=current;
      return [{...source,doc,chunk}];
    });
    return {...message,result:{...message.result,sources,...(changed?{
      kind:sources.length?'extract':'empty',
      text:sources.length?'部分原引用资料已删除或更新，已移除对应内容。以下仅保留仍可核对的资料摘录，请重新提问获取最新检索结果。':'原引用资料已删除或更新，此条历史回答的资料摘录已移除。请重新提问。'
    }:{})}};
  })}));
  return {history:cleanHistory,favorites:favorites.filter(id=>known.has(id))};
}
