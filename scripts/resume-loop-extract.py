#!/usr/bin/env python3
"""Resume loop extractor (agent2/resumes, 2026-11-09): opens each delivered resume file the way a reader's tools would and
prints one JSON line per file: {"path", "kind", "ok", "pages", "text", "error"}.

PDF: poppler (pdfinfo for the page count, pdftotext for the text) and, independently, pdfminer.six for the text.
DOCX: the zip is opened, word/document.xml read, and every paragraph's text joined; python-docx must also open it. A
DOCX has no fixed pages, so "pages" is 1 + its explicit page breaks (what Word cannot move).

Usage: python3 -I scripts/resume-loop-extract.py FILE...   (CI installs poppler-utils, pdfminer.six and python-docx)
"""
import json
import re
import subprocess
import sys
import zipfile

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def pdf(path):
    info = subprocess.run(["pdfinfo", path], capture_output=True, text=True)
    if info.returncode != 0:
        return {"ok": False, "error": "pdfinfo: " + info.stderr.strip()[:200]}
    m = re.search(r"^Pages:\s+(\d+)", info.stdout, re.M)
    pages = int(m.group(1)) if m else 0
    txt = subprocess.run(["pdftotext", "-enc", "UTF-8", path, "-"], capture_output=True, text=True)
    if txt.returncode != 0:
        return {"ok": False, "pages": pages, "error": "pdftotext: " + txt.stderr.strip()[:200]}
    out = {"ok": pages > 0 and bool(txt.stdout.strip()), "pages": pages, "text": txt.stdout}
    try:
        from pdfminer.high_level import extract_text
        out["text_pdfminer"] = extract_text(path)
    except ImportError:
        out["text_pdfminer"] = None
    except Exception as e:  # a file pdfminer cannot read does not open for a reader using it
        out["ok"] = False
        out["error"] = "pdfminer: " + str(e)[:200]
    if not out["ok"] and "error" not in out:
        out["error"] = "no pages or no text"
    return out


def docx(path):
    import xml.etree.ElementTree as ET
    try:
        with zipfile.ZipFile(path) as z:
            bad = z.testzip()
            if bad:
                return {"ok": False, "error": "corrupt member " + bad}
            root = ET.fromstring(z.read("word/document.xml"))
    except Exception as e:
        return {"ok": False, "error": "zip: " + str(e)[:200]}
    paras, breaks = [], 0
    for p in root.iter(W + "p"):
        bits = []
        for el in p.iter():
            if el.tag == W + "t":
                bits.append(el.text or "")
            elif el.tag in (W + "tab", W + "br", W + "cr"):
                bits.append(" ")
        paras.append("".join(bits))
        breaks += sum(1 for b in p.iter(W + "br") if b.get(W + "type") == "page")
        if p.find(f"{W}pPr/{W}pageBreakBefore") is not None:
            breaks += 1
    out = {"ok": any(s.strip() for s in paras), "pages": 1 + breaks, "text": "\n".join(paras)}
    try:
        import docx as python_docx
        python_docx.Document(path)
    except ImportError:
        pass
    except Exception as e:
        out["ok"] = False
        out["error"] = "python-docx: " + str(e)[:200]
    if not out["ok"] and "error" not in out:
        out["error"] = "no text"
    return out


for path in sys.argv[1:]:
    kind = "docx" if path.lower().endswith(".docx") else "pdf"
    try:
        res = (docx if kind == "docx" else pdf)(path)
    except Exception as e:
        res = {"ok": False, "error": str(e)[:200]}
    res.update({"path": path, "kind": kind})
    print(json.dumps(res))
