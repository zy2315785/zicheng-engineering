"""Refresh all configured project folders without changing source documents."""
import importlib.util,json,hashlib,sys,os
from pathlib import Path
from datetime import datetime
from PIL import Image
sys.stdout.reconfigure(encoding='utf-8',errors='replace')
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'dist'
PARSER_VERSION=3
spec=importlib.util.spec_from_file_location('document_parser',ROOT/'scripts/document-parser.py')
parser=importlib.util.module_from_spec(spec)
spec.loader.exec_module(parser)
projects=json.loads((ROOT/'projects.json').read_text(encoding='utf-8'))
previous={}
try:
    previous=json.loads((OUT/'project-data.json').read_text(encoding='utf-8'))
    cache={(d['project'],d['path']):d for d in previous['documents']}
except (OSError,ValueError,KeyError):cache={}
try:ocr_cache=json.loads((ROOT/'.local/ocr-cache.json').read_text(encoding='utf-8'))
except (OSError,ValueError):ocr_cache={}
def category(name):
    if '原中关村' in name or '2019.8.28' in name:return '历史参考'
    for words,result in [(['效果图'],'项目形象'),(['临电','临时用电','供电','箱变'],'临电工程'),(['管线','给水','排水','光缆','燃气','自来水'],'管线配套'),(['进度','倒排','确定事项'],'计划管理'),(['图纸','设计','审图','勘察','基坑','可研','方案文本','桩基'],'设计技术'),(['合同','协议','保函'],'合同资料'),(['复工','安全','值班'],'安全管理')]:
        if any(w in name for w in words):return result
    return '前期报建'
docs=[]
excluded=reused=0
assets_by_project={}
def content_hash(file):
    digest=hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
    return digest.hexdigest()

for project in projects:
    if not project.get('connected'):continue
    source=ROOT.parent/project['folder']
    if not source.is_dir():continue
    for file in sorted(source.rglob('*')):
        if not file.is_file() or file.name.startswith('~$'):continue
        rel=file.relative_to(source).as_posix()
        if any(w in rel for w in ['身份证','公章','通讯录','马奇年.pdf','开票资料']):
            excluded+=1
            continue
        ext=file.suffix.lower().lstrip('.')
        if ext not in ['pdf','docx','doc','xlsx','xls','dwg','dwf','jpg','png','jpeg','webp','rar','zip','psd','txt','md','csv','pptx']:continue
        stat=file.stat()
        prior=cache.get((project['id'],rel))
        cached_ocr=ocr_cache.get(project['id']+'/'+rel) or (ocr_cache.get(rel) if project['id']=='ruibang' else None)
        digest=None
        same_content=False
        compatible=prior and prior['size']==stat.st_size and previous.get('parserVersion')==PARSER_VERSION
        if compatible and prior.get('mtimeNs')!=str(stat.st_mtime_ns) and prior.get('contentHash'):
            digest=content_hash(file)
            same_content=digest==prior['contentHash']
        if compatible and (prior.get('mtimeNs')==str(stat.st_mtime_ns) or same_content):
            doc=dict(prior)
            doc.update(mtimeNs=str(stat.st_mtime_ns),modified=datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d'))
            reused+=1
        else:
            identity=rel if project['id']=='ruibang' else project['id']+'/'+rel
            doc=dict(id=hashlib.sha256(identity.encode()).hexdigest()[:12],name=file.name,path=rel,type=ext,size=stat.st_size,category=category(rel),project=project['id'],source='local',mtimeNs=str(stat.st_mtime_ns),modified=datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d'),status='catalog',chunks=[],pages=None,partial=False)
            try:doc.update(parser.extract(file))
            except Exception:doc['error']='正文暂未解析'
        doc['contentHash']=digest or (prior.get('contentHash') if compatible and prior.get('mtimeNs')==str(stat.st_mtime_ns) else None) or content_hash(file)
        valid_ocr=cached_ocr and (cached_ocr.get('mtimeNs')==doc['mtimeNs'] or (same_content and cached_ocr.get('mtimeNs')==prior.get('mtimeNs')))
        if doc['status']=='ocr' and valid_ocr:
            for item in cached_ocr.get('pages',[]):
                text=parser.clean(item.get('text',''))
                if text:doc['chunks'].append(dict(location=f"第 {item['page']} 页（OCR 识别）",page=item['page'],text=text))
            if doc['chunks']:doc.update(status='indexed',ocr=True)
        docs.append(doc)
    assets={}
    for key,name in project.get('images',{}).items():
        original=source/'效果图'/name
        output=OUT/'assets'/f"{project['id']}-{key}.webp"
        if original.is_file():
            if not output.exists() or output.stat().st_mtime_ns<original.stat().st_mtime_ns:
                with Image.open(original) as image:
                    image.thumbnail((1800,1300))
                    image.convert('RGB').save(output,'WEBP',quality=88)
            assets[key]='assets/'+output.name
    assets_by_project[project['id']]=assets
data=dict(project='ruibang',projects=projects,generated=datetime.now().astimezone().isoformat(),documents=docs,excluded=excluded,sourceName='多项目资料',parserVersion=PARSER_VERSION,assets=assets_by_project.get('ruibang',{}),assetsByProject=assets_by_project,indexingNote='目录按项目同步；PDF索引前24页，可按需翻页读取与OCR；旧DOC、CAD、压缩包以目录为主。')
temp=OUT/f'project-data.{os.getpid()}.tmp'
temp.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
temp.replace(OUT/'project-data.json')
(OUT/'projects.mjs').write_text('export const PROJECTS = '+json.dumps(projects,ensure_ascii=False,indent=2)+';\n',encoding='utf-8')
print(json.dumps(dict(files=len(docs),indexed=sum(d['status']=='indexed' for d in docs),ocr=sum(d['status']=='ocr' for d in docs),chunks=sum(len(d['chunks']) for d in docs),excluded=excluded,reused=reused,projects=[dict(id=p['id'],files=sum(d['project']==p['id'] for d in docs)) for p in projects if p.get('connected')]),ensure_ascii=False))
