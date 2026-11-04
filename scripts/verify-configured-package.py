"""Extract the real configured ZIP and test an isolated, relocated installation."""
from pathlib import Path
import argparse,json,os,shutil,subprocess,sys,urllib.request,zipfile,uuid
sys.stdout.reconfigure(encoding='utf-8',errors='replace')
ROOT=Path(__file__).resolve().parents[1]
args=argparse.ArgumentParser();args.add_argument('archive',type=Path);args.add_argument('--live',action='store_true');options=args.parse_args()
STAGING=(ROOT/'tmp'/('便携包验收 新电脑 '+uuid.uuid4().hex[:8])).resolve()
assert STAGING.is_relative_to((ROOT/'tmp').resolve())
STAGING.mkdir(parents=True,exist_ok=False)
MARKER=STAGING/'验收临时目录标记.txt';MARKER.write_text('codex-configured-package-verification',encoding='utf-8')
AI=STAGING/'AI';APP=AI/'zicheng-engineering'
env={k:v for k,v in os.environ.items() if not(k.upper().startswith(('ZC_','IMA_')) or k.upper() in ['PYTHONPATH','PYTHONHOME','NODE_PATH','NODE_OPTIONS','NODE_USE_ENV_PROXY','PORT','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY'])}
env['PATH']=str(Path(os.environ['SystemRoot'])/'System32')
started=success=False
result={}

def run(executable,*arguments,timeout=180):
    process=subprocess.run([str(executable),*map(str,arguments)],cwd=APP,env=env,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=timeout,creationflags=subprocess.CREATE_NO_WINDOW)
    if process.returncode:raise RuntimeError('Verification process exit '+str(process.returncode)+': '+process.stdout[-1500:]+' '+process.stderr[-300:])
    return process.stdout.strip()

def launch(*arguments):return run(AI/'runtime/node/node.exe',APP/'scripts/launch.mjs',*arguments)

try:
    with zipfile.ZipFile(options.archive) as archive:
        names=archive.namelist()
        for name in names:
            target=(STAGING/name).resolve()
            assert name.startswith('AI/') and target.is_relative_to(STAGING)
            assert '.git' not in Path(name).parts and '.workbuddy' not in Path(name).parts
        assert 'AI/zicheng-engineering/.local/server-state.json' not in names
        assert 'AI/zicheng-engineering/.local/server.log' not in names
        manifest=json.loads(archive.read('AI/便携包清单.json'))
        assert manifest['credentialsIncluded'] is True
        for name in ['api-config.json','cloud-config.json']:
            assert archive.read('AI/zicheng-engineering/.local/'+name)==(ROOT/'.local'/name).read_bytes()
        archive.extractall(STAGING)
    print('已将完整压缩包解压到独立中文与空格路径。',flush=True)
    before=json.loads((APP/'dist/project-data.json').read_text(encoding='utf-8'))
    original_files=sum(sum(p.is_file() for p in (AI/project['folder']).rglob('*')) for project in manifest['projects'])
    assert original_files==manifest['originalProjectFiles']
    print(launch('--no-browser'),flush=True);started=True
    state=json.loads((APP/'.local/server-state.json').read_text())
    assert state.get('stopToken')
    base='http://127.0.0.1:'+str(state['port'])
    with urllib.request.urlopen(base+'/api/health') as response:health=json.load(response)
    with urllib.request.urlopen(base+'/api/cloud/status') as response:status=json.load(response)
    assert status['model']['installed'] and status['ima']['configured'] and status['baidu']['connected']
    invalid=urllib.request.Request(base+'/api/shutdown',data=b'{}',headers={'Content-Type':'application/json','X-ZC-Stop-Token':'invalid'},method='POST')
    try:urllib.request.urlopen(invalid);raise AssertionError('Invalid stop token accepted')
    except __import__('urllib.error',fromlist=['HTTPError']).HTTPError as error:assert error.code==403
    after=json.loads((APP/'dist/project-data.json').read_text(encoding='utf-8'))
    assert len(before['documents'])==len(after['documents'])
    assert sum(d['status']=='indexed' for d in before['documents'])==sum(d['status']=='indexed' for d in after['documents'])
    assert sum(len(d['chunks']) for d in before['documents'])==sum(len(d['chunks']) for d in after['documents'])
    stats=json.loads((APP/'.local/index.log').read_text(encoding='utf-8').strip())
    assert stats['reused']==len(after['documents'])
    print(launch('--no-browser'),flush=True)
    assert json.loads((APP/'.local/server-state.json').read_text())['pid']==state['pid']
    ocr_test='''from pathlib import Path
import ctypes,json,pymupdf,onnxruntime,docx,openpyxl
from rapidocr_onnxruntime import RapidOCR
engine=RapidOCR()
k=ctypes.WinDLL('kernel32',use_last_error=True)
k.GetModuleHandleW.restype=ctypes.c_void_p;k.GetModuleHandleW.argtypes=[ctypes.c_wchar_p]
k.GetModuleFileNameW.argtypes=[ctypes.c_void_p,ctypes.c_wchar_p,ctypes.c_uint]
loaded=[]
for name in ['msvcp140.dll','msvcp140_1.dll','vcruntime140.dll','vcruntime140_1.dll']:
    handle=k.GetModuleHandleW(name);assert handle
    buffer=ctypes.create_unicode_buffer(32768);assert k.GetModuleFileNameW(handle,buffer,len(buffer))
    assert Path(buffer.value).resolve().is_relative_to(Path(__import__('sys').executable).resolve().parent)
    loaded.append(name)
print(json.dumps({'ocrReady':True,'localRuntimeLibraries':loaded}))'''
    runtime=json.loads(run(AI/'runtime/python/python.exe','-I','-B','-c',ocr_test))
    # Same-sized changed content must invalidate the cache rather than reuse it.
    sample=AI/'瑞邦国际大厦'/'便携内容校验.txt'
    sample.write_text('便携校验：A001。',encoding='utf-8');launch('--refresh-only')
    first=json.loads((APP/'dist/project-data.json').read_text(encoding='utf-8'))
    first_doc=next(d for d in first['documents'] if d['name']==sample.name)
    saved=sample.stat();sample.write_text('便携校验：B002。',encoding='utf-8');os.utime(sample,ns=(saved.st_atime_ns,saved.st_mtime_ns+2000000000))
    launch('--refresh-only')
    second=json.loads((APP/'dist/project-data.json').read_text(encoding='utf-8'))
    second_doc=next(d for d in second['documents'] if d['name']==sample.name)
    assert first_doc['contentHash']!=second_doc['contentHash'] and any('B002' in c['text'] for c in second_doc['chunks'])
    result={'archive':str(options.archive),'relocatedLaunch':True,'noInstalledNodeOrPythonRequired':True,'noEnvironmentCredentials':True,'originalProjectFiles':original_files,'indexedDocumentsPreserved':len(after['documents']),'textSearchablePreserved':sum(d['status']=='indexed' for d in after['documents']),'textChunksPreserved':sum(len(d['chunks']) for d in after['documents']),'repeatStartSingleProcess':True,'changedContentInvalidatesCache':True,'invalidStopTokenRejected':True,'runtime':runtime}
    if options.live:
        live=json.loads(run(AI/'runtime/node/node.exe',APP/'scripts/verify-configured-services.mjs',timeout=240))
        assert all(live[name]['connected'] for name in ['deepseek','ima','baidu'])
        result['liveServices']=live
    success=True
finally:
    if started:
        try:print(launch('--stop'),flush=True);result['gracefulStop']=True
        except Exception as error:
            print('验收后台停止检查：'+str(error),flush=True)
            if success:raise
    if success:
        assert STAGING.is_relative_to((ROOT/'tmp').resolve()) and MARKER.read_text(encoding='utf-8')=='codex-configured-package-verification'
        shutil.rmtree(STAGING)
        result['temporaryCopyRemoved']=True
        (ROOT/'.local/configured-package-verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(result,ensure_ascii=False),flush=True)
