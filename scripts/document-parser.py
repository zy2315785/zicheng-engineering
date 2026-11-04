"""Read-only text extraction shared by indexing and on-demand agent reads."""
import argparse, json, re, sys, warnings
from pathlib import Path
from docx import Document
from openpyxl import load_workbook
from pypdf import PdfReader
warnings.filterwarnings('ignore')

def clean(text):
    text=str(text).encode('utf-8',errors='ignore').decode('utf-8')
    text=re.sub(r'(?<!\d)1[3-9]\d{9}(?!\d)','[手机号已隐藏]',text)
    text=re.sub(r'(?<!\w)\d{17}[0-9Xx](?!\w)','[证件号已隐藏]',text)
    text=re.sub(r'(?<!\d)\d{12,19}(?!\d)','[长号码已隐藏]',text)
    return re.sub(r'[ \t\u3000]+',' ',text).strip()

def extract(source,page_start=1,page_count=24,row_limit=800,ocr=False):
    path=Path(source)
    ext=path.suffix.lower().lstrip('.')
    out=dict(status='catalog',chunks=[],pages=None,partial=False)
    def add(text,location,page=None):
        text=clean(text)
        for start in range(0,min(len(text),200000),1600):
            chunk=dict(location=location,text=text[start:start+1900])
            if page:chunk['page']=page
            out['chunks'].append(chunk)
    if ext in ['txt','md','csv']:
        text=path.read_text(encoding='utf-8-sig',errors='replace')
        out['partial']=len(text)>200000
        add(text,'文本正文')
    elif ext=='docx':
        doc=Document(path)
        rows=[p.text for p in doc.paragraphs if p.text.strip()]
        for table in doc.tables:
            for row in table.rows:rows.append(' | '.join(c.text for c in row.cells))
        for i in range(0,len(rows),5):add('\n'.join(rows[i:i+5]),f'正文段落 {i+1}–{min(i+5,len(rows))}')
    elif ext=='xlsx':
        wb=load_workbook(path,data_only=True,read_only=True)
        for sheet in wb:
            rows=[]
            for number,row in enumerate(sheet.iter_rows(values_only=True),1):
                values=[clean(v.isoformat()[:10] if hasattr(v,'isoformat') else v) for v in row if v is not None]
                if values:rows.append((number,' | '.join(values)))
                if number>=row_limit:
                    out['partial']=True
                    break
            for i in range(0,len(rows),5):
                group=rows[i:i+5]
                add('\n'.join(x[1] for x in group),f'{sheet.title} · 第{group[0][0]}–{group[-1][0]}行')
        wb.close()
    elif ext=='pdf':
        reader=PdfReader(path)
        out['pages']=len(reader.pages)
        start=max(0,page_start-1)
        end=min(len(reader.pages),start+page_count)
        out['partial']=start>0 or end<len(reader.pages)
        engine=pdf=None
        for index in range(start,end):
            text=reader.pages[index].extract_text() or ''
            location=f'第 {index+1} 页'
            if len(re.sub(r'\s','',text))<40 and ocr:
                if engine is None:
                    import pymupdf
                    from rapidocr_onnxruntime import RapidOCR
                    pdf=pymupdf.open(path)
                    engine=RapidOCR()
                result,_=engine(pdf[index].get_pixmap(dpi=170).tobytes('png'))
                text='\n'.join(r[1] for r in (result or []))
                location+='（OCR 识别）'
                out['ocr']=True
            if len(re.sub(r'\s','',text))>=12:add(text,location,index+1)
        if pdf:pdf.close()
        if not out['chunks']:out['status']='ocr'
    elif ext in ['png','jpg','jpeg','webp']:
        out['status']='image'
        if ocr:
            from rapidocr_onnxruntime import RapidOCR
            result,_=RapidOCR()(str(path))
            add('\n'.join(r[1] for r in (result or [])),'图片 OCR 识别')
            out['ocr']=True
    elif ext in ['dwg','dwf']:out['status']='drawing'
    elif ext in ['rar','zip']:out['status']='archive'
    if out['chunks']:out['status']='indexed'
    return out

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace')
    parser=argparse.ArgumentParser()
    parser.add_argument('file')
    parser.add_argument('--start',type=int,default=1)
    parser.add_argument('--pages',type=int,default=4)
    parser.add_argument('--ocr',action='store_true')
    args=parser.parse_args()
    try:print(json.dumps(extract(args.file,max(1,args.start),min(24,max(1,args.pages)),2000,args.ocr),ensure_ascii=False))
    except Exception:print(json.dumps(dict(status='catalog',chunks=[],partial=True,error='该文件未能解析，请核对原件格式。'),ensure_ascii=False))
