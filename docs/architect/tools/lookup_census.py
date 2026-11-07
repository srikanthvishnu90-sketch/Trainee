# Static census of captured application forms: which ask a location/city/school through a lookup-style widget.
import json, re, sys, html as H
from html.parser import HTMLParser
root = sys.argv[1]
m = json.load(open(f"{root}/tests/fixtures/forms-ci/manifest.json"))
LOOK = re.compile(r"\b(location|city|where (are|do) you (currently )?(live|reside|located|based)|school|university|college)\b", re.I)
class P(HTMLParser):
    def __init__(s): super().__init__(); s.labels = {}; s.cur = None; s.text = ""; s.els = []; s.stack = []
    def handle_starttag(s, t, a):
        a = dict(a)
        if t == "label": s.cur = a.get("for"); s.text = ""
        if t in ("input", "select", "div", "button") and (a.get("role") == "combobox" or a.get("aria-autocomplete") or "autocomplete" in (a.get("class") or "") or "location" in (a.get("class") or "").lower()):
            s.els.append(a)
    def handle_data(s, d):
        if s.cur is not None: s.text += d
    def handle_endtag(s, t):
        if t == "label" and s.cur is not None: s.labels[s.cur] = re.sub(r"\s+", " ", s.text).strip(); s.cur = None
out = {}
for f in m["forms"]:
    if f.get("status") != "application" or not f.get("html"): continue
    p = P(); p.feed(open(f"{root}/tests/fixtures/forms-ci/{f['html']}", encoding="utf8", errors="replace").read())
    hits = []
    for a in p.els:
        lab = p.labels.get(a.get("id") or "", "") or a.get("aria-label") or ""
        if LOOK.search(lab): hits.append((lab[:70], bool(a.get("aria-required") == "true" or a.get("required") is not None or lab.rstrip().endswith("*"))))
    fam = f["family"]; o = out.setdefault(fam, {"postings": 0, "with_lookup": 0, "with_required_lookup": 0, "examples": []})
    o["postings"] += 1
    if hits:
        o["with_lookup"] += 1
        if any(r for _, r in hits): o["with_required_lookup"] += 1
        o["examples"].append((f["id"], sorted(set(hits))[:4]))
print(json.dumps(out, indent=1))
