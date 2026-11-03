#!/usr/bin/env python3
"""Bundle the Trainee career domain modules for the agent-chat edge function.

One-way: edit packages/domain, then rerun. Output is an ES module at
supabase/functions/_shared/router_core.career.js that the Deno handler imports (Deno cannot load the
domain files directly; they are plain scripts shared with the node tests). Only the Edge-safe career
modules, the career data consts they read and the Career* exports are emitted. The former full
bundle (router_core.js, the Upmore finance modules) was removed with the finance code (2026-10-28).
    python3 scripts/build-router-core.py --career-only          rebuild the career bundle
    python3 scripts/build-router-core.py --career-only --check  fail if it is stale
(--career-only is accepted and is the only mode; it is kept so existing callers and CI steps do not change.)
"""
import argparse
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
# Dependency order matters: 144 is read eagerly by 142; 151 precedes 152.
# 150-career-portal-browser.js stays Node-only (filesystem + child processes).
# The Edge host reports that missing worker explicitly; never bundle its driver.
career_names = ['120-career-access.js', '121-career-jobs.js', '122-career-profile.js', '123-career-tailor.js', '124-career-outreach.js', '125-career-intel.js', '153-career-kb.js', '126-career-track.js', '127-career-prep.js', '128-career-negotiation.js', '129-career-os.js', '132-career-apply.js', '131-career-discover.js', '133-career-packets.js', '134-career-paths.js', '135-career-graph.js', '130-career-onboarding.js', '145-career-w11-ext.js', '132-career-apply3.js', '139-career-safety.js', '136-career-season.js', '140-career-reply.js', '141-career-doorstep.js', '154-career-recommendations.js', '154-career-writing.js', '144-career-guidance.js', '142-career-router.js', '143-career-containment.js', '146-career-intake.js', '147-career-platform-drafts.js', '148-career-render.js', '149-career-portal-apply.js', '151-career-alert-watch.js', '152-career-assign.js', '155-career-batch-apply.js']
career_exports = ['CareerAccess', 'CareerJobs', 'CareerProfile', 'CareerTailor', 'CareerOutreach', 'CareerIntel', 'CareerTrack', 'CareerPrep', 'CareerNegotiation', 'CareerOS', 'CareerApply', 'CareerDiscover', 'CareerPackets', 'CareerPaths', 'CareerGraph', 'CareerOnboarding', 'CareerW11Ext', 'CareerApply3', 'CareerSafety', 'CareerSeason', 'CareerReply', 'CareerDoorstep', 'CareerRouter', 'CareerContainment', 'CareerKB', 'CareerRecommendations', 'CareerGuidance', 'CareerAlertWatch', 'CareerAssign', 'CareerWriting', 'CareerBatchApply', 'CareerRender']
# Career data the domain modules read from disk in Node (BUG-174): the firm sets (124), the company-file library
# (142's cirListOf), the interview banks (127), the knowledge-base aggregates (153), the interview patterns (127), the
# public pay data (128 payData), the target-firm guide (134) and its source checks. In the Deno bundle there is no
# packages/career-data directory, so the data is embedded and read lazily at call time by the modules.
_cir_files = sorted((root / "packages/career-data/cirs").glob("*.json"))
_bank_files = sorted((root / "packages/career-data/interview-banks").glob("*.md"))
_ds = root / "packages/career-data/datasets"
_pay = {"maps": "pay-maps.json", "lca_wages": "dol-lca-wages.json", "oews_metro": "bls-oews-metro.json", "bls_national": "bls-labor-data.json", "lca_companies": "dol-lca-fy2025q4-cir-companies.json"}


# The career artifact must stay under the platform ceiling (tests/career-staged-size.test.cjs, 4,200,000 B), and
# about 480 KB of the career modules is comments. They stay in packages/domain, where people read them; the generated
# artifact drops them. A small JS lexer finds them (strings, templates with ${} nesting, regex literals, comments), so
# nothing inside a string or a template is ever touched; a comment on its own line goes with its line, a trailing one
# goes with the spaces before it, and an inline block comment becomes one space (or a newline, if it spanned lines, so
# automatic semicolon insertion reads the code the same). The build then runs node --check on the result.
_REGEX_AFTER_WORDS = {"return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"}


def strip_js_comments(src):
    out = []
    i, n = 0, len(src)
    stack = []  # brace depths at which an open template's ${ } closes
    depth = 0
    last = ""  # the last significant token: "" (start), "word:<w>", "num", or the punctuator itself

    def line_start(pos):
        j = pos
        while j > 0 and src[j - 1] in " \t":
            j -= 1
        return j if j == 0 or src[j - 1] == "\n" else None

    def drop_trailing_spaces():
        while out and out[-1] in (" ", "\t"):
            out.pop()

    def regex_allowed():
        if last == "" or last.startswith("word:") and last[5:] in _REGEX_AFTER_WORDS:
            return True
        return not (last.startswith("word:") or last in ("num", ")", "]", "}", "str"))

    def read_template(j):
        # j is just past a backtick (or a closing } of ${ }); copy up to the closing backtick or the next ${
        nonlocal depth
        while j < n:
            c = src[j]
            if c == "\\":
                out.append(src[j:j + 2]); j += 2; continue
            if c == "`":
                out.append(c); return j + 1, False
            if c == "$" and j + 1 < n and src[j + 1] == "{":
                out.append("${"); stack.append(depth); depth += 1; return j + 2, True
            out.append(c); j += 1
        raise SystemExit("career bundle: unterminated template literal")

    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        if c == "/" and nxt == "/":
            end = src.find("\n", i)
            end = n if end == -1 else end
            ls = line_start(i)
            if ls is not None:
                while out and out[-1] in (" ", "\t"):
                    out.pop()
                i = end + 1 if end < n else n  # the whole line, newline included
            else:
                drop_trailing_spaces()
                i = end  # keep the newline
            continue
        if c == "/" and nxt == "*":
            end = src.find("*/", i + 2)
            if end == -1:
                raise SystemExit("career bundle: unterminated block comment")
            body = src[i:end + 2]
            after = end + 2
            ls = line_start(i)
            k = after
            while k < n and src[k] in " \t":
                k += 1
            if ls is not None and (k >= n or src[k] == "\n"):
                while out and out[-1] in (" ", "\t"):
                    out.pop()
                i = k + 1 if k < n else n
            else:
                out.append("\n" if "\n" in body else " ")
                i = after
            continue
        if c in "'\"":
            j = i + 1
            while j < n and src[j] != c:
                if src[j] == "\\":
                    j += 1
                elif src[j] == "\n":
                    raise SystemExit("career bundle: newline inside a string literal")
                j += 1
            out.append(src[i:j + 1]); i = j + 1; last = "str"; continue
        if c == "`":
            out.append(c)
            i, opened = read_template(i + 1)
            last = "(" if opened else "str"
            continue
        if c == "/" and regex_allowed():
            j, in_class = i + 1, False
            while j < n:
                d = src[j]
                if d == "\\":
                    j += 2; continue
                if d == "\n":
                    raise SystemExit("career bundle: newline inside a regex literal at offset %d" % i)
                if in_class:
                    in_class = d != "]"
                elif d == "[":
                    in_class = True
                elif d == "/":
                    break
                j += 1
            j += 1
            while j < n and (src[j].isalnum() or src[j] == "_"):
                j += 1
            out.append(src[i:j]); i = j; last = "str"; continue
        if c == "{":
            depth += 1; out.append(c); i += 1; last = c; continue
        if c == "}":
            if stack and stack[-1] == depth - 1:
                depth -= 1; stack.pop(); out.append(c)
                i, opened = read_template(i + 1)
                last = "(" if opened else "str"
                continue
            depth -= 1; out.append(c); i += 1; last = c; continue
        if c.isalpha() or c in "_$":
            j = i
            while j < n and (src[j].isalnum() or src[j] in "_$"):
                j += 1
            out.append(src[i:j]); last = "word:" + src[i:j]; i = j; continue
        if c.isdigit():
            j = i
            while j < n and (src[j].isalnum() or src[j] in "._"):
                j += 1
            out.append(src[i:j]); last = "num"; i = j; continue
        out.append(c)
        if not c.isspace():
            last = c
        i += 1
    if stack:
        raise SystemExit("career bundle: unclosed template expression")
    return "".join(out)


# The career artifact must stay under the platform's upload ceiling (tests/career-staged-size.test.cjs: 3,950,107 B
# accepted, 4,822,785 B rejected). Its embedded data is most of it, so the career-only bundle carries each data const as
# raw DEFLATE in base64 and inflates it once at load with the small pure-JS inflater below (no imports and no web globals
# such as atob or TextDecoder, which the staged ES-module sandboxes lack, so they and the Edge runtime run it unchanged). The values are identical to the plain JSON:
# tests/career-bundle-data.test.cjs decodes every one and compares it with its source files.
CAREER_INFLATE = (
    "const __careerData = (() => {"
    "const LB=[3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258],"
    "LE=[0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0],"
    "DB=[1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577],"
    "DE=[0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13],"
    "OR=[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];"
    "const build=(lens,n)=>{const count=new Uint16Array(16),symbol=new Uint16Array(n),offs=new Uint16Array(16);"
    "for(let i=0;i<n;i++)count[lens[i]]++;count[0]=0;for(let i=1;i<16;i++)offs[i]=offs[i-1]+count[i-1];"
    "for(let i=0;i<n;i++)if(lens[i])symbol[offs[lens[i]]++]=i;return{count,symbol};};"
    "const fl=new Uint8Array(288);for(let i=0;i<288;i++)fl[i]=i<144?8:i<256?9:i<280?7:8;"
    "const FL=build(fl,288),FD=build(new Uint8Array(30).fill(5),30);"
    "const inflate=(src)=>{let pos=0,bb=0,bc=0,out=new Uint8Array(src.length*4+1024),ol=0;"
    "const room=(n)=>{if(ol+n>out.length){let m=out.length*2;while(m<ol+n)m*=2;const o=new Uint8Array(m);o.set(out.subarray(0,ol));out=o;}};"
    "const bits=(n)=>{let v=bb;while(bc<n){if(pos>=src.length)throw new Error(\"career data: truncated\");v|=src[pos++]<<bc;bc+=8;}bb=v>>>n;bc-=n;return v&((1<<n)-1);};"
    "const dec=(h)=>{let code=0,first=0,index=0;for(let len=1;len<16;len++){code|=bits(1);const c=h.count[len];if(code-c<first)return h.symbol[index+(code-first)];index+=c;first+=c;first<<=1;code<<=1;}throw new Error(\"career data: bad code\");};"
    "let last;do{last=bits(1);const type=bits(2);"
    "if(type===0){bb=0;bc=0;const len=src[pos]|(src[pos+1]<<8);pos+=4;room(len);out.set(src.subarray(pos,pos+len),ol);ol+=len;pos+=len;}"
    "else if(type===1||type===2){let lc=FL,dc=FD;"
    "if(type===2){const nl=bits(5)+257,nd=bits(5)+1,nc=bits(4)+4,cl=new Uint8Array(19);for(let i=0;i<nc;i++)cl[OR[i]]=bits(3);"
    "const ch=build(cl,19),ll=new Uint8Array(nl+nd);let i=0;"
    "while(i<nl+nd){const sym=dec(ch);if(sym<16){ll[i++]=sym;continue;}let v=0,rep;"
    "if(sym===16){if(i===0)throw new Error(\"career data: bad repeat\");v=ll[i-1];rep=3+bits(2);}else if(sym===17)rep=3+bits(3);else rep=11+bits(7);"
    "if(i+rep>nl+nd)throw new Error(\"career data: bad lengths\");while(rep--)ll[i++]=v;}"
    "lc=build(ll.subarray(0,nl),nl);dc=build(ll.subarray(nl),nd);}"
    "for(;;){let sym=dec(lc);if(sym<256){room(1);out[ol++]=sym;}else if(sym===256)break;"
    "else{sym-=257;if(sym>28)throw new Error(\"career data: bad length\");const len=LB[sym]+bits(LE[sym]),ds=dec(dc);if(ds>29)throw new Error(\"career data: bad distance\");const dist=DB[ds]+bits(DE[ds]);"
    "if(dist>ol)throw new Error(\"career data: bad distance\");room(len);for(let k=0;k<len;k++){out[ol]=out[ol-dist];ol++;}}}}"
    "else throw new Error(\"career data: bad block\");}while(!last);return out.subarray(0,ol);};"
    "const B64=new Uint8Array(128);for(let i=0;i<64;i++)B64[\"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/\".charCodeAt(i)]=i;"
    "const unb64=(s)=>{let n=s.length;while(n&&s[n-1]===\"=\")n--;const out=new Uint8Array((n*3)>>2);let o=0;"
    "for(let i=0;i<n;i+=4){const a=B64[s.charCodeAt(i)],b=B64[s.charCodeAt(i+1)],c=i+2<n?B64[s.charCodeAt(i+2)]:0,d=i+3<n?B64[s.charCodeAt(i+3)]:0;"
    "out[o++]=(a<<2)|(b>>4);if(i+2<n)out[o++]=((b&15)<<4)|(c>>2);if(i+3<n)out[o++]=((c&3)<<6)|d;}return out;};"
    "const utf8=(b)=>{let s=\"\",chunk=[];for(let i=0;i<b.length;){let c=b[i++];"
    "if(c>=0xf0){c=((c&7)<<18)|((b[i++]&63)<<12)|((b[i++]&63)<<6)|(b[i++]&63);c-=0x10000;chunk.push(0xd800+(c>>10),0xdc00+(c&1023));}"
    "else if(c>=0xe0){chunk.push(((c&15)<<12)|((b[i++]&63)<<6)|(b[i++]&63));}else if(c>=0xc0){chunk.push(((c&31)<<6)|(b[i++]&63));}else chunk.push(c);"
    "if(chunk.length>=8192){s+=String.fromCharCode.apply(null,chunk);chunk=[];}}return s+String.fromCharCode.apply(null,chunk);};"
    "return (b64)=>JSON.parse(utf8(inflate(unb64(b64))));})();\n"
)
import base64, zlib
def career_data_line(name, value):
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    packed = c.compress(json.dumps(value, separators=(",", ":")).encode()) + c.flush()
    return "const %s = __careerData(\"%s\");\n" % (name, base64.b64encode(packed).decode())

CAREER_DATA = {
    "CAREER_FIRM_SETS_JSON": json.loads((root / "packages/career-data/firm-sets.json").read_text()),
    "CAREER_PAY_JSON": {k: json.loads((_ds / f).read_text()) for k, f in _pay.items()},
    "CAREER_FIRM_GUIDE_JSON": json.loads((root / "packages/career-data/firm-guide.json").read_text()),
    "CAREER_CIRS_JSON": [json.loads(f.read_text()) for f in _cir_files],
    "CAREER_INTERVIEW_BANKS_JSON": {f.stem: f.read_text() for f in _bank_files},
    "CAREER_KB_JSON": json.loads((root / "packages/career-data/kb-aggregates.json").read_text()),
    "CAREER_PATTERNS_JSON": json.loads((root / "packages/career-data/interview-patterns.json").read_text()),
    "CAREER_SOURCE_CHECKS_JSON": json.loads((root / "packages/career-data/source-checks.json").read_text()),
}

career_content = "// Generated by scripts/build-router-core.py --career-only; edit packages/domain instead (comments are stripped here).\n"
career_content += strip_js_comments("\n".join((root / "packages/domain" / n).read_text() for n in career_names))
career_content += "\n" + CAREER_INFLATE + "".join(career_data_line(k, v) for k, v in CAREER_DATA.items())
career_content += "export { " + ", ".join(career_exports) + " };\n"

parser = argparse.ArgumentParser()
parser.add_argument("--check", action="store_true")
parser.add_argument("--career-only", action="store_true")
args = parser.parse_args()
target = root / "supabase/functions/_shared/router_core.career.js"
content = career_content
module_count = len(career_names)
if args.check:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Router bundle is stale: %s (run python3 scripts/build-router-core.py --career-only)" % target.relative_to(root))
    print("Router bundle verified")
else:
    target.write_text(content)
    # The stripped artifact must still parse as a module; a lexer mistake fails the build here, never at deploy.
    import shutil, subprocess, tempfile
    with tempfile.TemporaryDirectory() as tmp:
        probe = Path(tmp) / "router_core.career.mjs"
        shutil.copyfile(target, probe)
        subprocess.run(["node", "--check", str(probe)], check=True)
    print("Router bundle built: %d modules, %d bytes" % (module_count, len(content)))
