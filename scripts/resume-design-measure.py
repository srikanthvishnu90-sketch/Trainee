#!/usr/bin/env python3
"""Resume design measure (r-resume-design, 2026-11-10; release item 3). Reads one JSON manifest on stdin, a list of
{"id", "pdf", "docx", "docx_pdf", "png_dir"} (docx_pdf: the Word copy as LibreOffice prints it), and prints one JSON line per case
with what a reader sees on the page, measured, not judged:

  pages, page size; every text line with its box (points from the top-left) and its largest and smallest glyph size;
  the ink box of every page as rendered to PNG at 100 dpi (poppler pdftoppm) and whether any ink touches the paper edge;
  overlapping lines (text drawn over text); the reading order poppler and pdfminer give (what an ATS parser reads);
  and the same for the Word copy, plus the text of its paragraphs in document order (what a DOCX parser reads).

The checks and the bar live in scripts/resume-design-loop.ts. Needs poppler-utils, pdfminer.six, pypdfium2 and Pillow.
"""
import json
import os
import subprocess
import sys

from PIL import Image
from pdfminer.high_level import extract_pages, extract_text
from pdfminer.layout import LAParams, LTChar, LTTextContainer, LTTextLine

DPI = 100


def lines_of(path):
    out, sizes = [], []
    pages = []
    for pno, page in enumerate(extract_pages(path, laparams=LAParams())):
        h = page.height
        pages.append({"w": round(page.width, 1), "h": round(h, 1)})
        for box in page:
            if not isinstance(box, LTTextContainer):
                continue
            for ln in box:
                if not isinstance(ln, LTTextLine):
                    continue
                text = ln.get_text().strip()
                if not text:
                    continue
                cs = [c for c in ln if isinstance(c, LTChar) and c.get_text().strip()]
                if not cs:
                    continue
                sz = [round(c.size, 2) for c in cs]
                sizes.extend(sz)
                bold = sum(1 for c in cs if "bold" in c.fontname.lower()) / len(cs)
                out.append({"page": pno + 1, "text": text, "x0": round(ln.x0, 1), "x1": round(ln.x1, 1),
                            "top": round(h - ln.y1, 1), "bottom": round(h - ln.y0, 1),
                            "size": max(sz), "min": min(sz), "bold": round(bold, 2), "bold0": "bold" in cs[0].fontname.lower()})
    return pages, out, sizes


def overlaps(lines):
    n = 0
    for i, a in enumerate(lines):
        for b in lines[i + 1:]:
            if a["page"] != b["page"]:
                continue
            dx = min(a["x1"], b["x1"]) - max(a["x0"], b["x0"])
            dy = min(a["bottom"], b["bottom"]) - max(a["top"], b["top"])
            if dx > 1 and dy > 1.5:  # glyph boxes of two lines cross: text over text
                n += 1
    return n


def ink(path, png_dir, stem):
    os.makedirs(png_dir, exist_ok=True)
    prefix = os.path.join(png_dir, stem)
    subprocess.run(["pdftoppm", "-r", str(DPI), "-png", path, prefix], check=True, capture_output=True)
    res = []
    for f in sorted(p for p in os.listdir(png_dir) if p.startswith(stem + "-") and p.endswith(".png")):
        im = Image.open(os.path.join(png_dir, f)).convert("L")
        bw = im.point(lambda v: 255 if v < 200 else 0)
        box = bw.getbbox()
        w, h = im.size
        k = 72.0 / DPI
        if box is None:
            res.append({"png": f, "empty": True})
            continue
        res.append({"png": f, "empty": False, "left": round(box[0] * k, 1), "top": round(box[1] * k, 1),
                    "right": round((w - box[2]) * k, 1), "bottom": round((h - box[3]) * k, 1),
                    "edge": box[0] == 0 or box[1] == 0 or box[2] >= w or box[3] >= h})
    return res


def poppler_text(path):
    r = subprocess.run(["pdftotext", "-enc", "UTF-8", path, "-"], capture_output=True, text=True)
    return r.stdout


def docx_text(path):
    import xml.etree.ElementTree as ET
    import zipfile
    W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    paras = []
    for p in root.iter(W + "p"):
        paras.append("".join((el.text or "") if el.tag == W + "t" else " " for el in p.iter() if el.tag in (W + "t", W + "tab", W + "br")))
    return "\n".join(paras)


def pdfium_text(path):
    try:
        import pypdfium2 as pdfium
    except ImportError:
        return None
    doc = pdfium.PdfDocument(path)
    try:
        return "\n".join(doc[i].get_textpage().get_text_range() for i in range(len(doc)))
    finally:
        doc.close()


def measure(path, png_dir, stem):
    pages, lines, sizes = lines_of(path)
    return {"text_pdfium": pdfium_text(path),"pages": pages, "lines": lines, "overlaps": overlaps(lines), "ink": ink(path, png_dir, stem),
            "text_poppler": poppler_text(path), "text_pdfminer": extract_text(path)}


for case in json.load(sys.stdin):
    row = {"id": case["id"]}
    try:
        row["pdf"] = measure(case["pdf"], case["png_dir"], "pdf")
        row["docx"] = measure(case["docx_pdf"], case["png_dir"], "docx") if case.get("docx_pdf") and os.path.exists(case["docx_pdf"]) else None
        if row["docx"] is not None:
            # A parser reading the Word file reads its paragraphs in document order, not a printout of it.
            row["docx"]["text_xml"] = docx_text(case["docx"])
    except Exception as e:  # reported as a failed case, never dropped
        row["error"] = str(e)[:300]
    print(json.dumps(row), flush=True)
