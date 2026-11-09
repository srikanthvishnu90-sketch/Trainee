#!/usr/bin/env python3
"""Builds the format rater's fixtures (tests/architect/fixtures/resume-rater/): Word files made the way people make them
(python-docx: styles, list paragraphs, tab stops, tables, headers) and, where LibreOffice is installed, the PDF each one
saves as (embedded subset fonts, as a real upload has). Synthetic people only (TEST). Run: python3 scripts/resume-rater-fixtures.py"""
import os, shutil, subprocess, sys
from docx import Document
from docx.enum.text import WD_TAB_ALIGNMENT
from docx.shared import Pt, Inches
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

OUT = "tests/architect/fixtures/resume-rater"
JOBS = [
    ("Data Analyst, Northwind Traders (TEST),", "2022–Present", ["Built 14 Tableau dashboards used by the sales and finance teams every week", "Cut the monthly close report from three days to four hours with SQL and Python", "Trained six analysts on dbt models and code review"]),
    ("Analyst Intern, Contoso Bank (TEST),", "2021–2022", ["Reconciled 2,000 loan records a month against the core banking ledger", "Wrote the team's first data dictionary for the credit risk warehouse"]),
    ("Research Assistant, State University (TEST),", "2019–2021", ["Cleaned survey data for a 3,000-person panel study in R", "Co-wrote the methods appendix of a working paper"]),
]

def base(doc, font="Arial", size=11, margin=0.75):
    st = doc.styles["Normal"]; st.font.name = font; st.font.size = Pt(size)
    st.element.rPr.rFonts.set(qn("w:eastAsia"), font)
    st.paragraph_format.space_before = Pt(0); st.paragraph_format.space_after = Pt(0)
    for s in doc.sections:
        s.left_margin = s.right_margin = s.top_margin = s.bottom_margin = Inches(margin)
    return doc

def heading(doc, text, size=11):
    p = doc.add_paragraph(); p.paragraph_format.space_before = Pt(10); p.paragraph_format.space_after = Pt(2)
    r = p.add_run(text.upper()); r.bold = True; r.font.size = Pt(size)
    return p

def entry(doc, title, dates, width_in, space=6):
    p = doc.add_paragraph(); p.paragraph_format.space_before = Pt(space)
    p.paragraph_format.tab_stops.add_tab_stop(Inches(width_in), WD_TAB_ALIGNMENT.RIGHT)
    r = p.add_run(title); r.bold = True
    p.add_run("\t" + dates)
    return p

def bullet(doc, text, left=0.25, hang=0.15):
    p = doc.add_paragraph(style="List Bullet")
    p.paragraph_format.left_indent = Inches(left); p.paragraph_format.first_line_indent = Inches(-hang)
    p.add_run(text)
    return p

def good():
    d = base(Document())
    p = d.add_paragraph(); r = p.add_run("Morgan Example"); r.bold = True; r.font.size = Pt(16)
    d.add_paragraph("morgan.example@example.test | (555) 010-0199 | Chicago, IL")
    d.add_paragraph("linkedin.com/in/morgan-example-test")
    heading(d, "Experience")
    for i, (t, dt, bs) in enumerate(JOBS):
        entry(d, t, dt, 7.0, 0 if i == 0 else 6)
        for b in bs: bullet(d, b)
    heading(d, "Education")
    entry(d, "BS Statistics, State University (TEST),", "2021", 7.0, 0)
    heading(d, "Skills")
    d.add_paragraph("SQL, Python, R, Tableau, dbt, Excel")
    return d

def two_column():
    d = base(Document())
    p = d.add_paragraph(); r = p.add_run("Riley Sample"); r.bold = True; r.font.size = Pt(18)
    t = d.add_table(rows=1, cols=2)
    left, right = t.rows[0].cells
    left.text = "CONTACT\nriley.sample@example.test\n(555) 010-0142\n\nSKILLS\nSQL\nPython\nTableau"
    right.text = ""
    rp = right.paragraphs[0]; rp.add_run("EXPERIENCE").bold = True
    for (tt, dt, bs) in JOBS:
        right.add_paragraph(f"{tt} {dt}")
        for b in bs: right.add_paragraph("• " + b)
    return d

def header_contact():
    d = good()
    for p in list(d.paragraphs)[1:3]:
        p._element.getparent().remove(p._element)
    h = d.sections[0].header
    h.paragraphs[0].text = "morgan.example@example.test | (555) 010-0199"
    return d

def messy():
    d = base(Document(), font="Comic Sans MS", size=9, margin=0.3)
    p = d.add_paragraph(); r = p.add_run("Jordan Placeholder"); r.bold = True; r.font.size = Pt(14)
    d.add_paragraph("jordan.placeholder@example.test   (555) 010-0177")
    heading(d, "My Journey")
    for i, (t, dt, bs) in enumerate(JOBS):
        p = d.add_paragraph(); p.paragraph_format.space_before = Pt([4, 11, 7][i])
        r = p.add_run(t); r.bold = True
        p.add_run(" " * (12 + i * 5) + dt)
        for k, b in enumerate(bs): bullet(d, b, left=[0.25, 0.4, 0.3][(i + k) % 3], hang=[0.15, 0.2][k % 2])
    heading(d, "Things I Know")
    d.add_paragraph("SQL, Python, R, Tableau")
    return d

def own_match():
    """The test profile's own resume (packages/career-data/fixtures/test-resume.txt) as a Word file made the usual way: the
    name and email are the profile's, every line is one the profile was read from. The keep path's fixture."""
    d = base(Document())
    p = d.add_paragraph(); r = p.add_run("Alex Testcase"); r.bold = True; r.font.size = Pt(16)
    d.add_paragraph("Chicago, IL | alex.testcase@example.test")
    src = open("packages/career-data/fixtures/test-resume.txt", encoding="utf8").read().split("\n")
    body = src[src.index("EDUCATION"):]
    first = True
    for line in body:
        t = line.strip()
        if not t:
            continue
        if t.isupper() and len(t) < 30:
            heading(d, t); first = True
        elif t.startswith("- "):
            bullet(d, t[2:])
        elif t.startswith("SKILLS") is False and "," in t and t.split(",")[0].strip() in ("Python",):
            d.add_paragraph(t)
        else:
            q = d.add_paragraph(); q.paragraph_format.space_before = Pt(0 if first else 6); q.add_run(t).bold = True; first = False
    return d

def main():
    os.makedirs(OUT, exist_ok=True)
    made = {"good": good(), "two-column": two_column(), "header-contact": header_contact(), "messy": messy(), "own-match": own_match()}
    for name, d in made.items():
        # python-docx stamps the save time into docProps/core.xml; fixed so the fixtures are reproducible byte for byte.
        import datetime
        d.core_properties.created = d.core_properties.modified = datetime.datetime(2026, 11, 8)
        d.core_properties.author = "TEST"; d.core_properties.last_modified_by = "TEST"
        d.save(f"{OUT}/{name}.docx")
    soffice = shutil.which("soffice")
    if not soffice:
        print("NOT_RUN: LibreOffice is not installed; the PDFs were not rebuilt"); return
    for name in made:
        subprocess.run([soffice, "--headless", "--convert-to", "pdf", "--outdir", OUT, f"{OUT}/{name}.docx"], check=True, capture_output=True)
    print("wrote", ", ".join(f"{n}.docx/.pdf" for n in made))

if __name__ == "__main__":
    main()
