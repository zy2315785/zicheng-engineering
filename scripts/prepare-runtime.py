"""Assemble a relocatable Windows runtime from installed, bundled runtimes."""
import json,shutil,subprocess,sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8',errors='replace')
ROOT=Path(__file__).resolve().parents[1]
AI=ROOT.parent
PY=Path(sys.executable).parent
NODE=Path(shutil.which('node'))
OUT=AI/'runtime'
node_out=OUT/'node'
python_out=OUT/'python'
node_out.mkdir(parents=True,exist_ok=True)
python_out.mkdir(parents=True,exist_ok=True)
shutil.copy2(NODE,node_out/'node.exe')
version=subprocess.check_output([str(NODE),'--version'],text=True,creationflags=subprocess.CREATE_NO_WINDOW).strip()
(node_out/'VERSION.txt').write_text(version+'\nWindows x64\n',encoding='utf-8')
for name in ['python.exe','python3.dll','python312.dll','vcruntime140.dll','vcruntime140_1.dll','LICENSE.txt']:
    shutil.copy2(PY/name,python_out/name)
ignore=shutil.ignore_patterns('__pycache__','*.pyc','site-packages','test','tests','idlelib','tkinter','turtledemo','ensurepip')
shutil.copytree(PY/'Lib',python_out/'Lib',ignore=ignore,dirs_exist_ok=True)
shutil.copytree(PY/'DLLs',python_out/'DLLs',dirs_exist_ok=True)
site=PY/'Lib/site-packages'
packages=python_out/'Lib/site-packages'
packages.mkdir(parents=True,exist_ok=True)
names=['pypdf','docx','openpyxl','PIL','lxml','et_xmlfile','typing_extensions.py']
for name in names:
    src=site/name
    if src.is_dir():shutil.copytree(src,packages/name,ignore=shutil.ignore_patterns('__pycache__','*.pyc'),dirs_exist_ok=True)
    else:shutil.copy2(src,packages/name)
for pattern in ['pypdf-*.dist-info','python_docx-*.dist-info','openpyxl-*.dist-info','pillow-*.dist-info','lxml-*.dist-info','et_xmlfile-*.dist-info','typing_extensions-*.dist-info','pillow.libs','lxml.libs']:
    for src in site.glob(pattern):
        shutil.copytree(src,packages/src.name,dirs_exist_ok=True)
(python_out/'python312._pth').write_text('.\nLib\nDLLs\nLib/site-packages\nimport site\n',encoding='ascii')
print(json.dumps({'node':str(node_out/'node.exe'),'python':str(python_out/'python.exe'),'size':sum(p.stat().st_size for p in OUT.rglob('*') if p.is_file())},ensure_ascii=False))
