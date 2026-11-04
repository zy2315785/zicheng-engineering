"""Copy the app/runtime to a new path and test without installed runtimes."""
from pathlib import Path
import os,shutil,subprocess,json,urllib.request,sys

sys.stdout.reconfigure(encoding='utf-8',errors='replace')
ROOT=Path(__file__).resolve().parents[1]
AI=ROOT.parent
TEMP=ROOT/'tmp'/'便携验证 新电脑路径'/'AI'
assert TEMP.resolve().is_relative_to((ROOT/'tmp').resolve())
if TEMP.exists():shutil.rmtree(TEMP)
TEMP.mkdir(parents=True)
shutil.copytree(AI/'runtime',TEMP/'runtime')
shutil.copytree(ROOT,TEMP/'zicheng-engineering',ignore=shutil.ignore_patterns('.git','.local','tmp','output','__pycache__'))
for name in ['启动工程助手.cmd','停止工程助手.cmd','更新项目资料.cmd','使用说明.txt']:
    shutil.copy2(AI/name,TEMP/name)
S=TEMP/'瑞邦国际大厦'
S.mkdir()
index=json.loads((ROOT/'dist/project-data.json').read_text(encoding='utf-8'))
sample_names=['施工许可证办理所需资料(新).xlsx','瑞邦国际大厦项目进展倒排计划.xlsx','瑞邦国际大厦项目国防光缆安全措施审批表.docx','瑞邦国际大厦项目（主体阶段施工许可证）.pdf']
sample=[next(d['path'] for d in index['documents'] if d['project']=='ruibang' and d['name']==n) for n in sample_names]
for name in sample:
    target=S/name
    target.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(AI/'瑞邦国际大厦'/name,target)
env={k:v for k,v in os.environ.items() if k.upper() not in ['PYTHONPATH','PYTHONHOME','NODE_PATH','PORT']}
env['PATH']=str(Path(os.environ['SystemRoot'])/'System32')
node=TEMP/'runtime/node/node.exe'
launcher=TEMP/'zicheng-engineering/scripts/launch.mjs'
def run(*args):
    r=subprocess.run([str(node),str(launcher),*args],cwd=TEMP,env=env,capture_output=True,text=True,encoding='utf-8',timeout=100,creationflags=subprocess.CREATE_NO_WINDOW)
    if r.returncode:raise RuntimeError(r.stdout+'\n'+r.stderr)
    return r.stdout
started=False
try:
    print(run('--no-browser').strip())
    started=True
    state=json.loads((TEMP/'zicheng-engineering/.local/server-state.json').read_text())
    base=f"http://127.0.0.1:{state['port']}"
    with urllib.request.urlopen(base+'/project-data.json') as r:data=json.load(r)
    assert len(data['documents'])==len(sample)
    assert sum(d['status']=='indexed' for d in data['documents'])==len(sample)
    assert not data['assets']
    pdf=next(d for d in data['documents'] if d['type']=='pdf')
    with urllib.request.urlopen(base+'/api/files/'+pdf['id']) as r:assert r.read(5)==b'%PDF-'
    first_pid=state['pid']
    print(run('--no-browser').strip())
    assert json.loads((TEMP/'zicheng-engineering/.local/server-state.json').read_text())['pid']==first_pid
    (S/sample[0]).unlink()
    (S/'新增工程说明.txt').write_text('便携测试：项目新资料能够加入检索。',encoding='utf-8')
    print(run('--refresh-only').strip())
    updated=json.loads((TEMP/'zicheng-engineering/dist/project-data.json').read_text(encoding='utf-8'))
    assert not any(d['name']==sample[0] for d in updated['documents'])
    assert any(d['name']=='新增工程说明.txt' and d['chunks'] for d in updated['documents'])
    print(json.dumps({'portable':True,'newPath':str(TEMP),'indexedSamples':len(sample),'rawPdfPreview':True,'repeatStartSingleProcess':True,'directoryChangesSynced':True},ensure_ascii=False))
finally:
    if started:print(run('--stop').strip())
    assert TEMP.resolve().is_relative_to((ROOT/'tmp').resolve())
    shutil.rmtree(TEMP)
