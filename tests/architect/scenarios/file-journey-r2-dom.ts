// A small page runtime for the jobs page's own script (file_page.ts FEED_SCRIPT), so the script path of an Apply runs in a test:
// the page's HTML parsed into nodes, the script run unchanged against them, its fetch answered by the real handler, and what the
// person would be left with read back (the list, where focus is, what the live region says, how many requests went out).
// Not a browser: our own well-formed markup only (no error recovery), simple selectors only (tag, .class, #id, lists), no layout.
// tests/architect/scenarios-file-journey-r2*.test.ts use it to hold the script path to the plain-form path: one request each, the
// same page after it.

const VOID = new Set(["meta", "link", "input", "img", "br", "hr", "rect"]);
const RAW = new Set(["script", "style", "title"]);
export class Node {
  tag: string | null; text = ""; attrs = new Map<string, string>(); kids: Node[] = []; parent: Node | null = null; page: Page | null = null;
  constructor(tag: string | null) { this.tag = tag; }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  setAttribute(k: string, v: string) { this.attrs.set(k, String(v)); }
  get id() { return this.attrs.get("id") ?? ""; }
  get tagName() { return (this.tag ?? "").toUpperCase(); }
  get className() { return this.attrs.get("class") ?? ""; }
  get classList() { const c = this.className.split(/\s+/).filter(Boolean); return { contains: (x: string) => c.includes(x) }; }
  set disabled(v: boolean) { if (v) this.attrs.set("disabled", ""); else this.attrs.delete("disabled"); }
  get disabled() { return this.attrs.has("disabled"); }
  get textContent(): string { return this.tag === null ? this.text : this.kids.map((k) => k.textContent).join(""); }
  set textContent(v: string) { const t = new Node(null); t.text = String(v); this.setKids([t]); }
  get innerHTML(): string { return this.kids.map(serialize).join(""); }
  set innerHTML(html: string) { this.setKids(parse(html)); }
  setKids(ks: Node[]) { for (const k of ks) k.parent = this; this.kids = ks; }
  all(): Node[] { const out: Node[] = []; const walk = (n: Node) => { for (const k of n.kids) if (k.tag) { out.push(k); walk(k); } }; walk(this); return out; }
  matches(sel: string) { return sel.split(",").some((s) => simple(this, s.trim())); }
  querySelector(sel: string) { return this.all().find((n) => n.matches(sel)) ?? null; }
  closest(sel: string) { for (let n: Node | null = this; n; n = n.parent) if (n.tag && n.matches(sel)) return n; return null; }
  getElementById(id: string) { return this.all().find((n) => n.id === id) ?? null; }
  get root(): Node { let n: Node = this; while (n.parent) n = n.parent; return n; }
  focus() { const p = pageOf(this); if (p) p.active = this; }
  submit() { const p = pageOf(this); if (p) p.nativeSubmit(this); }
}
function pageOf(n: Node) { return n.root.page; }
function simple(n: Node, s: string): boolean {
  const m = /^([a-z0-9]*)((?:[.#][A-Za-z0-9_-]+)*)$/.exec(s);
  if (!m) throw new Error(`selector not supported here: ${s}`);
  if (m[1] && n.tag !== m[1]) return false;
  for (const part of m[2].match(/[.#][A-Za-z0-9_-]+/g) ?? []) {
    if (part[0] === "." && !n.classList.contains(part.slice(1))) return false;
    if (part[0] === "#" && n.id !== part.slice(1)) return false;
  }
  return true;
}
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const escT = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escA = (s: string) => escT(s).replace(/"/g, "&quot;");
export function serialize(n: Node): string {
  if (n.tag === null) return n.parent && RAW.has(n.parent.tag ?? "") ? n.text : escT(n.text);
  const attrs = [...n.attrs.entries()].map(([k, v]) => v === "" && k !== "value" ? ` ${k}` : ` ${k}="${escA(v)}"`).join("");
  return VOID.has(n.tag) ? `<${n.tag}${attrs}>` : `<${n.tag}${attrs}>${n.kids.map(serialize).join("")}</${n.tag}>`;
}
export function parse(html: string): Node[] {
  const top = new Node("#frag"), stack: Node[] = [top];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  const cur = () => stack[stack.length - 1];
  while ((m = re.exec(html))) {
    if (m[1]) { const t = m[1].toLowerCase(); for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === t) { stack.length = i; break; } continue; }
    if (m[2]) {
      const n = new Node(m[2].toLowerCase());
      for (const a of m[3].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) n.attrs.set(a[1].toLowerCase(), unesc(a[2] ?? a[3] ?? a[4] ?? ""));
      n.parent = cur(); cur().kids.push(n);
      if (RAW.has(n.tag!)) {
        const end = html.toLowerCase().indexOf(`</${n.tag}>`, re.lastIndex);
        const t = new Node(null); t.text = html.slice(re.lastIndex, end < 0 ? html.length : end); t.parent = n; n.kids.push(t);
        re.lastIndex = end < 0 ? html.length : end + n.tag!.length + 3;
      } else if (!VOID.has(n.tag!)) stack.push(n);
      continue;
    }
    if (m[4]) { const t = new Node(null); t.text = unesc(m[4]); t.parent = cur(); cur().kids.push(t); }
  }
  for (const k of top.kids) k.parent = null;
  return top.kids;
}
// The fields a form posts (its inputs with a name, in order), as the browser's FormData would collect them.
export function formBody(f: Node): [string, string][] { return f.all().filter((n) => n.tag === "input" && n.getAttribute("name")).map((n) => [n.getAttribute("name")!, n.getAttribute("value") ?? ""]); }

// One page in one tab. post(body) is the server (the real handler behind the test's cookie jar); every request the page makes,
// by the script's fetch or by the form posting itself, goes through it and is counted.
export class Page {
  html!: Node; title = ""; active: Node | null = null; requests = 0; private inflight: Promise<unknown> | null = null; private queued: [string, string][][] = [];
  constructor(public href: string, html: string, private post: (body: string) => Promise<string>) { this.load(html); }
  load(html: string) {
    const kids = parse(html);
    const h = kids.find((k) => k.tag === "html") ?? (() => { const x = new Node("html"); x.setKids(kids); return x; })();
    this.html = h; h.page = this; this.title = h.querySelector("title")?.textContent ?? ""; this.active = null;
  }
  get body() { return this.html.querySelector("body")!; }
  nativeSubmit(f: Node) { this.queued.push(formBody(f)); }
  // Runs the page's inline scripts (the CSP lets only these run) with the window they expect.
  run() {
    const page = this;
    const doc = {
      getElementById: (id: string) => page.html.getElementById(id), querySelector: (s: string) => page.html.querySelector(s),
      get body() { return page.body; }, get title() { return page.title; }, set title(t: string) { page.title = t; },
    };
    class FormData { pairs: [string, string][]; constructor(f: Node) { this.pairs = formBody(f); } [Symbol.iterator]() { return this.pairs[Symbol.iterator](); } }
    class DOMParser { parseFromString(t: string) { const p = new Page(page.href, t, async () => ""); return { getElementById: (id: string) => p.html.getElementById(id), get title() { return p.title; }, body: p.body }; } }
    const fetchShim = (_u: string, init: { body: string }) => { page.requests++; const r = page.post(init.body).then((text) => ({ text: async () => text })); page.inflight = r; return r; };
    for (const s of this.html.all().filter((n) => n.tag === "script" && !n.getAttribute("src"))) {
      new Function("window", "document", "fetch", "DOMParser", "FormData", "URLSearchParams", "location", "getComputedStyle", s.textContent)({ fetch: fetchShim, DOMParser }, doc, fetchShim, DOMParser, FormData, URLSearchParams, { href: this.href }, () => ({ backgroundColor: "rgb(0, 0, 0)" }));
    }
  }
  // The person taps the submit button of a form: the root's submit listener (the script's in-place flip) runs, else the form posts
  // itself and its answer becomes the page. Returns once every request the tap caused is answered and drawn.
  async tap(form: Node): Promise<void> {
    let prevented = false;
    const root = this.html.getElementById("root") as (Node & { _l?: ((e: unknown) => void)[] }) | null;
    for (const l of root?._l ?? []) l({ target: form, preventDefault() { prevented = true; } });
    if (!prevented) this.nativeSubmit(form);
    for (let round = 0; round < 5; round++) {
      while (this.inflight) { const p = this.inflight; this.inflight = null; await p.catch(() => {}); for (let i = 0; i < 50; i++) await Promise.resolve(); }
      const q = this.queued.shift();
      if (!q) break;
      this.requests++;
      this.load(await this.post(new URLSearchParams(q).toString()));
      this.run();
    }
  }
}
// The page's script registers its submit listener on #root; a form's own submit() posts it natively.
Object.assign(Node.prototype, {
  addEventListener(this: Node & { _l?: ((e: unknown) => void)[] }, t: string, f: (e: unknown) => void) { if (t === "submit") (this._l ??= []).push(f); },
});


