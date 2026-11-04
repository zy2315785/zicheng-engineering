"""扫描件 OCR：把没有文本层的 PDF 逐页识别，结果写入 .local/ocr-cache.json，并回填 project-data.json。
原始文件只读不写。支持中断续跑：已识别的页不会重复识别。
"""
import json, re, sys, time, argparse
from pathlib import Path
from datetime import datetime

ROOT = Path(__file__).resolve().parents[1]
PROJECTS = {p['id']: p['folder'] for p in json.loads((ROOT/'projects.json').read_text(encoding='utf-8')) if p.get('connected')}
DATA = ROOT / 'dist' / 'project-data.json'
CACHE = ROOT / '.local' / 'ocr-cache.json'
MAX_PAGES = 24
DPI = 200
CHUNK = 1600

sys.stdout.reconfigure(encoding='utf-8', errors='replace')


def clean(text):
    text = str(text).encode('utf-8', errors='ignore').decode('utf-8')
    text = re.sub(r'(?<!\d)1[3-9]\d{9}(?!\d)', '[手机号已隐藏]', text)
    text = re.sub(r'(?<!\w)\d{17}[0-9Xx](?!\w)', '[证件号已隐藏]', text)
    text = re.sub(r'(?<!\d)\d{12,19}(?!\d)', '[长号码已隐藏]', text)
    return re.sub(r'[ \t\u3000]+', ' ', text).strip()


def load_cache():
    try:
        return json.loads(CACHE.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def save_cache(cache):
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE.with_suffix('.tmp')
    tmp.write_text(json.dumps(cache, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    tmp.replace(CACHE)


def chunks_from_pages(pages):
    out = []
    for item in pages:
        text = clean(item.get('text', ''))
        if len(re.sub(r'\s', '', text)) < 12:
            continue
        page = item.get('page')
        for start in range(0, len(text), CHUNK):
            out.append(dict(location=f'第 {page} 页（OCR 识别）', page=page, text=text[start:start + CHUNK + 100]))
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--minutes', type=float, default=0, help='本次最多运行几分钟，0 表示不限')
    parser.add_argument('--limit-docs', type=int, default=0, help='本次最多处理几份文件')
    parser.add_argument('--dpi', type=int, default=DPI)
    args = parser.parse_args()

    data = json.loads(DATA.read_text(encoding='utf-8'))
    docs = data['documents']
    targets = [d for d in docs if d.get('status') == 'ocr' and (d.get('pages') or 0) > 0]
    if not targets:
        print(json.dumps(dict(state='done', files=0, pages=0, message='没有待识别的扫描件'), ensure_ascii=False))
        return

    cache = load_cache()
    try:
        import pymupdf
    except ImportError:
        import fitz as pymupdf
    from rapidocr_onnxruntime import RapidOCR

    engine = RapidOCR()
    started = time.time()
    budget = args.minutes * 60 if args.minutes > 0 else 0
    done_docs = done_pages = 0

    for doc in targets:
        if budget and time.time() - started > budget:
            break
        if args.limit_docs and done_docs >= args.limit_docs:
            break
        rel = doc['path']
        abs_path = ROOT.parent / PROJECTS.get(doc['project'],'') / rel
        if not abs_path.is_file():
            continue
        cache_key = doc['project']+'/'+rel
        entry = cache.get(cache_key) or (cache.get(rel) if doc['project']=='ruibang' else None)
        if not entry or entry.get('mtimeNs') != str(doc.get('mtimeNs')):
            entry = dict(mtimeNs=str(doc.get('mtimeNs')), pages=[])
            cache[cache_key] = entry
        known = {p['page'] for p in entry['pages']}
        limit = min(doc.get('pages') or 0, MAX_PAGES)
        pending = [i for i in range(1, limit + 1) if i not in known]
        if not pending:
            done_docs += 1
            continue
        print(f'OCR {doc["name"]}  待识别 {len(pending)}/{limit} 页', flush=True)
        try:
            pdf = pymupdf.open(abs_path)
        except Exception as error:
            print(f'  打开失败：{error}', flush=True)
            continue
        for page_no in pending:
            if budget and time.time() - started > budget:
                break
            try:
                pix = pdf[page_no - 1].get_pixmap(dpi=args.dpi)
                result, _ = engine(pix.tobytes('png'))
                text = '\n'.join(r[1] for r in (result or []))
            except Exception as error:
                text = ''
                print(f'  第 {page_no} 页识别失败：{error}', flush=True)
            entry['pages'].append(dict(page=page_no, text=text))
            entry['pages'].sort(key=lambda p: p['page'])
            known.add(page_no)
            done_pages += 1
            save_cache(cache)
            if page_no % 5 == 0:
                print(f'  已识别 {page_no}/{limit} 页', flush=True)
        pdf.close()
        doc['chunks'] = chunks_from_pages(entry['pages'])
        doc['ocr'] = True
        doc['status'] = 'indexed' if doc['chunks'] else 'ocr'
        doc['partial'] = len(doc['chunks']) > 0 and (doc.get('pages') or 0) > MAX_PAGES
        done_docs += 1

    data['generated'] = datetime.now().astimezone().isoformat()
    tmp = DATA.with_suffix('.ocrtmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    tmp.replace(DATA)

    remaining = [d for d in docs if d.get('status') == 'ocr']
    print(json.dumps(dict(
        state='done' if not remaining else 'partial',
        files=done_docs, pages=done_pages,
        remaining=len(remaining),
        seconds=round(time.time() - started, 1)
    ), ensure_ascii=False))


if __name__ == '__main__':
    main()
