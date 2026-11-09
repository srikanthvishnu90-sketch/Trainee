#!/usr/bin/env python3
"""RELEASE 10: the real-world round trip. Every resume file Trainee makes is read back by independent open-source text
extractors that run offline, none of them ours, and each must bring back every field the source holds:
  pdfminer   pdfminer.six (pure Python), text boxes in position order       PDF
  pdfminer-default  pdfminer.six's default layout analysis (boxes_flow 0.5): REPORTED ONLY. It splits a hanging-indent
             bullet's wrapped lines into their own box and can order a right-aligned date's box between them; any resume
             with hanging indents and right-aligned dates reads that way (the Word-made rater fixture does too).
  pdfium     pypdfium2 (Google's PDFium, the engine in Chrome)              PDF
  poppler    pdftotext (poppler-utils) where it is installed                PDF  (optional: reported NOT_RUN when absent)
  docx       python-docx (paragraph text)                                    DOCX
For each file: the name, the email, the phone, every entry's text and its dates, every bullet. A field "comes back" when its
words, in order, appear in the extracted text (whitespace and line breaks normalised, so a wrapped bullet still counts) and
the fields appear in the source's order. A date also has to come back on its entry's own line (pdftotext -layout, and the
PDFium line that holds the entry's last words), which is what a parser keying on "title ... dates" lines reads.

Input: a directory of <id>.pdf, <id>.docx and <id>.json ({"name","email","phone","entries":[{"text","dates"}],"bullets"}).
Output: JSON on stdout: per extractor, fields checked, fields back, in order, the misses (first 20), and the date-line checks.
Run: python3 scripts/resume-roundtrip.py <dir>"""
import json, os, re, shutil, subprocess, sys, unicodedata

def norm(s):
    s = unicodedata.normalize("NFC", s).replace("•", " ").replace(" ", " ")
    s = s.replace("ﬁ", "fi").replace("ﬂ", "fl")
    return re.sub(r"\s+", " ", s).strip().lower()

def pdfminer_text(path, flow=None):
    """flow=None: pdfminer orders text boxes by position (top to bottom); flow=0.5 is its default layout analysis, which
    puts a right-aligned date's box between a hanging-indent bullet's first and wrapped lines (reported, never asserted)."""
    from pdfminer.high_level import extract_text
    from pdfminer.layout import LAParams
    return extract_text(path, laparams=LAParams(boxes_flow=flow))

def pdfium_text(path):
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument(path)
    out = []
    for i in range(len(pdf)):
        tp = pdf[i].get_textpage()
        out.append(tp.get_text_range())
        tp.close()
    pdf.close()
    return "\n".join(out)

def poppler_text(path, layout=False):
    exe = shutil.which("pdftotext")
    if not exe:
        return None
    args = [exe] + (["-layout"] if layout else []) + [path, "-"]
    return subprocess.run(args, capture_output=True, text=True, check=True).stdout

def docx_text(path):
    import docx
    return "\n".join(p.text for p in docx.Document(path).paragraphs)

def fields(exp):
    out = [("name", exp["name"]), ("email", exp["email"]), ("phone", exp["phone"])]
    bullets = list(exp["bullets"])
    for e in exp["entries"]:
        out.append(("entry", e["text"].rstrip(",")))
        if e.get("dates"):
            out.append(("dates", e["dates"]))
    out += [("bullet", b) for b in bullets]
    return out

def check(text, exp, ordered_kinds=("name", "email", "entry")):
    t = norm(text)
    misses, back, pos_ok, last = [], 0, True, -1
    for kind, value in fields(exp):
        v = norm(value)
        i = t.find(v)
        if i < 0:
            misses.append(f"{kind}: {value[:70]}")
            continue
        back += 1
        if kind in ordered_kinds:
            # In the source's order: the next occurrence at or after the previous ordered field.
            j = t.find(v, last + 1) if last >= 0 else i
            if j < 0:
                pos_ok = False
                misses.append(f"order: {kind} {value[:50]}")
            else:
                last = j
    return {"fields": len(fields(exp)), "back": back, "in_order": pos_ok, "misses": misses[:20]}

def date_lines(text, exp):
    """Each entry's dates on the same line as the entry's last words (a layout-preserving extraction)."""
    lines = [norm(l) for l in text.splitlines() if l.strip()]
    bad = []
    for e in exp["entries"]:
        if not e.get("dates"):
            continue
        words = norm(e["text"].rstrip(",")).split(" ")
        tail = words[-1]
        d = norm(e["dates"])
        if not any(tail in l and d in l and l.index(tail) < l.rindex(d) for l in lines):
            bad.append(f"{e['text'][:50]} | {e['dates']}")
    return {"entries": sum(1 for e in exp["entries"] if e.get("dates")), "bad": bad[:20]}

def main(d):
    ids = sorted(f[:-5] for f in os.listdir(d) if f.endswith(".json"))
    report = {"files": len(ids), "extractors": {}, "date_lines": {}}
    agg = {}
    def add(name, res, key):
        a = agg.setdefault(name, {"files": 0, "fields": 0, "back": 0, "in_order": 0, "misses": []})
        a["files"] += 1; a["fields"] += res["fields"]; a["back"] += res["back"]; a["in_order"] += 1 if res["in_order"] else 0
        a["misses"] += [f"{key}: {m}" for m in res["misses"]]
    dl = {}
    for k in ids:
        exp = json.load(open(os.path.join(d, k + ".json"), encoding="utf8"))
        pdf, docx = os.path.join(d, k + ".pdf"), os.path.join(d, k + ".docx")
        add("pdfminer", check(pdfminer_text(pdf), exp), k)
        add("pdfminer-default", check(pdfminer_text(pdf, 0.5), exp), k)
        add("pdfium", check(pdfium_text(pdf), exp), k)
        pt = poppler_text(pdf)
        if pt is not None:
            add("poppler", check(pt, exp), k)
            r = date_lines(poppler_text(pdf, layout=True), exp)
            x = dl.setdefault("poppler-layout", {"entries": 0, "bad": []}); x["entries"] += r["entries"]; x["bad"] += [f"{k}: {b}" for b in r["bad"]]
        r = date_lines(pdfium_text(pdf), exp)
        x = dl.setdefault("pdfium", {"entries": 0, "bad": []}); x["entries"] += r["entries"]; x["bad"] += [f"{k}: {b}" for b in r["bad"]]
        if os.path.exists(docx):
            add("docx", check(docx_text(docx), exp), k)
    for name, a in agg.items():
        a["accuracy"] = round(a["back"] / a["fields"], 6) if a["fields"] else None
        a["misses"] = a["misses"][:20]
        report["extractors"][name] = a
    if "poppler" not in agg:
        report["extractors"]["poppler"] = "NOT_RUN: pdftotext is not installed"
    for name, x in dl.items():
        report["date_lines"][name] = {"entries": x["entries"], "on_their_line": x["entries"] - len(x["bad"]), "bad": x["bad"][:20]}
    print(json.dumps(report, indent=1))

if __name__ == "__main__":
    main(sys.argv[1])
