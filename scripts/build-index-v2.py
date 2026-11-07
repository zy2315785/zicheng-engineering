"""Build private, project-scoped retrieval indexes. Never place the output in dist/."""
import argparse, hashlib, json, re, sys
from datetime import datetime, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
parser=argparse.ArgumentParser()
parser.add_argument('--private-root',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
ROOT=args.private_root
read=lambda p:json.loads(p.read_text(encoding='utf-8-sig'))
data=read(ROOT/'project-data.original.json')['documents']
inventory=read(ROOT/'ima-inventory.json')['files']
projects=read(Path(__file__).resolve().parent.parent/'projects.json')
TERMS=['开工报告','施工许可证','合同开工','合同竣工','计划开工','计划竣工','实际开工','日历天','合同工期','竣工','总进度','倒排','建设单位','施工单位','设计单位','监理单位','发包人','承包人','建筑面积','用地面积','合同价','付款','预付款','进度款','保修','违约','桩基','基坑','消防','临电','箱变','勘察','光缆','管线','规划','中标','设计','效果图','安全']
def norm(s):return str(s or '').replace('\\','/').strip().casefold()
def split_text(text,limit=1800):
    # Lossless character spans: page boundaries are handled before splitting.
    at=0
    while at<len(text):
        end=min(len(text),at+limit)
        if end<len(text):
            cut=max(text.rfind('\n',at+800,end),text.rfind('。',at+800,end))
            if cut>at:end=cut+1
        yield at,end,text[at:end]
        at=end

args.output.mkdir(parents=True,exist_ok=True)
report=[]
for project in projects:
    if not project.get('connected'):continue
    pid,folder=project['id'],project['folder']
    files=[f for f in inventory if norm(f.get('project'))==norm(folder) or norm(f.get('path')).startswith(norm(folder)+'/')]
    by_name={}
    for f in files:by_name.setdefault(norm(f['title']),[]).append(f)
    vision_path=ROOT/'rag'/pid/'transcribed.json'
    vision={norm(d['name']):d for d in read(vision_path)['docs']} if vision_path.exists() else {}
    docs=[];missing=[]
    for doc in (d for d in data if d['project']==pid):
        relative=norm(doc['path']);matches=[f for f in files if norm(f['path'])==norm(folder)+'/'+relative]
        if not matches:matches=by_name.get(norm(doc['name']),[])
        if len(matches)!=1:missing.append({'name':doc['name'],'matches':len(matches)});continue
        f=matches[0];v=vision.get(norm(doc['name']));parts=[]
        if v:
            for page in v['transcribed']:
                parts.append((f"第 {page['page']} 页（视觉转写）",str(page['text']),page['page'],'vision-transcription'))
        else:
            for c in doc.get('chunks') or []:
                text=str(c.get('text') or '')
                if not text:continue
                loc=c.get('location') or '原始文字摘录'
                m=re.search(r'第\s*(\d+)\s*页',loc)
                parts.append((loc,text,int(m[1]) if m else None,'ocr-cache' if 'OCR' in loc else 'text-layer-cache'))
        chunks=[];original_chars=0
        for loc,text,page,source in parts:
            original_chars+=len(text)
            for begin,end,piece in split_text(text):
                chunks.append({'id':hashlib.sha256((f['mediaId']+loc+str(begin)+piece).encode()).hexdigest()[:20],
                    'loc':loc+(f' · 字符 {begin+1}–{end}' if len(text)>1800 else ''),
                    'page':page,'start':begin,'end':end,'source':source,'text':piece})
        assert sum(len(c['text']) for c in chunks)==original_chars,'Text loss during splitting'
        full='\n'.join(c['text'] for c in chunks)
        observed=doc['name']+' '+full
        cloud_path=str(f['path']).replace('\\','/')
        path=cloud_path[len(folder)+1:] if cloud_path.startswith(folder+'/') else doc['path']
        docs.append({'mediaId':f['mediaId'],'name':doc['name'],'path':path,'cloudPath':cloud_path,
            'type':doc.get('type',''),'category':doc.get('category',''),'pages':doc.get('pages'),
            'keywords':[t for t in TERMS if t in observed],
            'contentHash':hashlib.sha256(full.encode()).hexdigest(),
            'coverage':{'hasText':bool(chunks),'source':'vision-transcription' if v else 'local-extraction','chars':original_chars},'chunks':chunks})
    if missing:raise SystemExit(json.dumps({'project':pid,'unresolved':missing},ensure_ascii=False))
    ids=[d['mediaId'] for d in docs]
    if len(ids)!=len(set(ids)):raise SystemExit('Ambiguous duplicate media IDs in '+pid)
    out={'version':2,'project':pid,'folder':folder,'generated':datetime.now(timezone.utc).isoformat(),'docs':docs}
    (args.output/(pid+'.json')).write_text(json.dumps(out,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    report.append({'project':pid,'files':len(docs),'chunks':sum(len(d['chunks']) for d in docs),'withText':sum(bool(d['chunks']) for d in docs),'maxChunk':max(len(c['text']) for d in docs for c in d['chunks'])})
(args.output/'manifest.json').write_text(json.dumps({'version':2,'projects':report},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
