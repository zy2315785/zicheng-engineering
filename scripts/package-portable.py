"""Build a portable Windows distribution; sharing credentials requires an explicit flag."""
from pathlib import Path
from datetime import datetime
import zipfile,json,sys,argparse,hashlib
sys.stdout.reconfigure(encoding='utf-8',errors='replace')
ROOT=Path(__file__).resolve().parents[1]
AI=ROOT.parent
projects=json.loads((ROOT/'projects.json').read_text(encoding='utf-8'))
sources={p['folder'] for p in projects if p.get('connected')}
args=argparse.ArgumentParser()
args.add_argument('--check-only',action='store_true')
args.add_argument('--include-credentials',action='store_true',help='Explicitly include the current DeepSeek, ima and Baidu configuration for internal trials.')
args.add_argument('--output',type=Path)
options=args.parse_args()
profile='已配置内部试用版_Windows_x64' if options.include_credentials else 'Windows便携版'
OUT=options.output or AI/('子城联合工程助手_'+profile+'_'+datetime.now().strftime('%Y%m%d')+'.zip')
OUT=OUT.resolve()
assert OUT.is_relative_to(AI.resolve()),'Package must stay in the AI workspace.'
TEMP=OUT.with_suffix('.zip.partial')
ROOT_FILES={'启动工程助手.cmd','停止工程助手.cmd','更新项目资料.cmd','使用说明.txt'}
PRIVATE_FILES={'api-config.json','cloud-config.json','cloud-map.json','ocr-cache.json'}
snapshots={}
connections={}
if options.include_credentials:
    for name in PRIVATE_FILES:
        file=ROOT/'.local'/name
        if file.is_file():snapshots[file]=file.read_bytes()
    model=json.loads(snapshots[ROOT/'.local/api-config.json'])
    cloud=json.loads(snapshots[ROOT/'.local/cloud-config.json'])
    assert model.get('key'),'DeepSeek credential missing.'
    assert all(cloud.get('ima',{}).get(k) for k in ['enabled','clientId','apiKey']),'ima configuration incomplete.'
    assert all(cloud.get('baidu',{}).get(k) for k in ['enabled','appKey','secretKey','accessToken','refreshToken']),'Baidu configuration incomplete.'
    connections={'deepseek':{'configured':True,'model':model.get('model'),'thinking':model.get('thinking',True),'effort':model.get('effort','high')},'ima':{'configured':True,'knowledgeBaseName':cloud['ima'].get('knowledgeBaseName')},'baidu':{'configured':True,'authorized':True,'root':cloud['baidu'].get('root','/AI')}}
def include(p):
    rel=p.relative_to(AI)
    if rel.parts[0] in sources:return True
    if len(rel.parts)==1:return p.name in ROOT_FILES
    if rel.parts[0]=='runtime':return '__pycache__' not in rel.parts and p.suffix!='.pyc'
    if rel.parts[0]!='zicheng-engineering':return False
    if len(rel.parts)==3 and rel.parts[1]=='.local':return options.include_credentials and p.name in PRIVATE_FILES
    if any(n in rel.parts[1:] for n in ['.git','.local','tmp','output','__pycache__','node_modules','.sites-local','.openai']):return False
    return p.suffix not in ['.zip','.log','.partial','.bak'] and not p.name.startswith('.env')
files=sorted(p for p in AI.rglob('*') if p.is_file() and include(p))
originals=[p for p in files if p.relative_to(AI).parts[0] in sources]
for name in sources:assert sum(p.is_file() for p in (AI/name).rglob('*'))==sum(p.relative_to(AI).parts[0]==name for p in originals)
index=json.loads((ROOT/'dist/project-data.json').read_text(encoding='utf-8'))
folders={p['id']:p['folder'] for p in projects if p.get('connected')}
assert all((AI/folders[d['project']]/d['path']).is_file() for d in index['documents'])
if not options.include_credentials:assert not any('.local' in p.relative_to(AI).parts for p in files)
report=dict(created=datetime.now().astimezone().isoformat(),target='Windows x64',profile=profile,files=len(files),originalProjectFiles=len(originals),uncompressedBytes=sum(p.stat().st_size for p in files),projects=[dict(id=p['id'],folder=p['folder']) for p in projects if p.get('connected')],credentialsIncluded=options.include_credentials,connections=connections,privateConfigurationFiles=sorted(p.name for p in snapshots),omitted=([] if options.include_credentials else ['密钥与授权令牌'])+['WorkBuddy会话配置','日志与临时测试','正在运行的进程状态','Git与站点发布包'])
print(json.dumps(report,ensure_ascii=False),flush=True)
if options.check_only:raise SystemExit(0)
configured_help='''子城联合工程部 · 工程知识助手（已配置内部试用版）

一、开始使用
1. 使用 Windows 10/11 64位电脑，保持联网。
2. 将压缩包完整解压到可写目录，例如 D:\\工程助手，得到完整 AI 文件夹。
3. 进入 AI 文件夹，双击“启动工程助手.cmd”，等待浏览器自动打开。
4. 已预置 DeepSeek、ima 和百度网盘连接，无需安装 Node、Python、WorkBuddy，也无需再次填写密钥。
5. 选择瑞邦国际大厦或火炬项目提问；下载原件由后台直接访问已授权的百度网盘。
不要在压缩包内直接运行，不要单独拖出启动器，不要删除 runtime。

二、本包的共享连接
DeepSeek Flash：思考模式开启，强度“高”。
ima：共用“子城”知识库内的项目资料。
百度网盘：共用已授权账号的 /AI 项目目录，后台保存访问和刷新令牌。
这些连接使用打包者的账户和配额；其他电脑不需要登录 WorkBuddy。
每台电脑的问答记录、收藏和后续配置修改各自保存在该电脑，不会自动互相同步。

三、停止与更新
双击“停止工程助手.cmd”停止本文件夹的后台。
双击“更新项目资料.cmd”重新同步本地目录。
本地文件、ima、百度网盘由资料维护人员分别同步，助手不会自动上传或删除云端文件。

四、密钥与授权失效后
本包按打包者明确要求携带当前真实密钥和百度授权令牌，仅供指定同事内部试用。
以后撤销或更换密钥/授权后，旧包中的共享连接可能停止工作。
仅删除打包者电脑上的配置文件，不会撤销别人已经拿到的凭证；需要到各服务后台撤销/重置密钥及百度账号授权。
失效后可在网页左下角“云端连接与模型设置”填写新连接，或换用新的内部包。

五、内容
已包含完整启动器、Node/Python运行环境、PDF/Word/Excel解析与OCR依赖、两个项目原件、已有资料索引与当前连接配置。
不包含 WorkBuddy 登录会话、Git、发布临时包、测试副本和历史日志。
文件未包含的工程结论不得编造；计划日期不代表实际进度。
'''
stored={'.zip','.rar','.jpg','.jpeg','.png','.webp','.pdf','.psd','.xlsx','.docx'}
OUT.parent.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(TEMP,'w',allowZip64=True,compression=zipfile.ZIP_DEFLATED,compresslevel=2) as archive:
    for number,p in enumerate(files,1):
        name='AI/'+p.relative_to(AI).as_posix()
        if options.include_credentials and p==AI/'使用说明.txt':archive.writestr(name,configured_help)
        elif p in snapshots:archive.writestr(name,snapshots[p])
        else:archive.write(p,name,compress_type=zipfile.ZIP_STORED if p.suffix.lower() in stored else zipfile.ZIP_DEFLATED,compresslevel=2)
        if number%1000==0:print(json.dumps({'packed':number,'total':len(files)}),flush=True)
    archive.writestr('AI/便携包清单.json',json.dumps(report,ensure_ascii=False,indent=2))
with zipfile.ZipFile(TEMP) as archive:
    assert archive.testzip() is None
    if options.include_credentials:
        for file,data in snapshots.items():assert archive.read('AI/'+file.relative_to(AI).as_posix())==data
TEMP.replace(OUT)
digest=hashlib.sha256()
with OUT.open('rb') as stream:
    for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
(OUT.with_suffix(OUT.suffix+'.sha256.txt')).write_text(digest.hexdigest()+'  '+OUT.name+'\n',encoding='utf-8')
result=dict(archive=str(OUT),bytes=OUT.stat().st_size,crcVerified=True,sha256=digest.hexdigest(),credentialsIncluded=options.include_credentials)
(ROOT/'.local/package-report.json').write_text(json.dumps({**report,**result},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False),flush=True)
