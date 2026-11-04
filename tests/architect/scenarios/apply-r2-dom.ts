// A small DOM for running the apply engine's own in-page functions outside a browser (tests/architect/scenarios-apply-r2*):
// fnDiscoverFields, fnDetectChallenge and fnPostingLocation (scripts/career/page-functions.cjs) and the closures
// scripts/apply.ts hands to page.evaluate run unchanged against it. Elements with attributes, children, text, form
// controls (value, checked, files, selected option, maxlength), visibility (display:none, the hidden attribute, or an
// element placed off the page, which still has a box as in a browser) and a selector engine for the selectors those
// functions use (tags, #id, .class, [attr], [attr=v], [attr*=v], descendant and child combinators, :scope >, lists).
// Not a browser: no layout, no events, no scripts. The page's own behavior is the fake browser's (apply-r2-browser.ts).

export type Attrs = Record<string, string | boolean | number | undefined>;

export class El {
  tagName: string;
  attrs = new Map<string, string>();
  children: El[] = [];
  parent: El | null = null;
  ownText = "";
  // Form state (what the person or the engine set), apart from the attributes the page was served with.
  private own = "";
  // An option's value is its value attribute (else its text); a select's is its chosen option's; any other control's is
  // what was typed or set.
  get value(): string {
    if (this.tagName === "OPTION") return this.getAttribute("value") ?? this.textContent;
    if (this.tagName === "SELECT") return this.selectedOption?.value ?? "";
    return this.own;
  }
  set value(v: string) {
    if (this.tagName === "SELECT") { const i = this.options.findIndex((o) => o.value === String(v)); this.selectedIndex = i; return; }
    this.own = String(v);
  }
  checked = false;
  files: { name: string; bytes: Uint8Array; sha256: string }[] = [];
  selectedIndex = 0;
  hiddenStyle = false;
  offscreen = false;
  doc!: Doc;
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }

  // --- attributes
  getAttribute(k: string): string | null { return this.attrs.has(k.toLowerCase()) ? this.attrs.get(k.toLowerCase())! : null; }
  setAttribute(k: string, v: string) { this.attrs.set(k.toLowerCase(), String(v)); }
  hasAttribute(k: string) { return this.attrs.has(k.toLowerCase()); }
  removeAttribute(k: string) { this.attrs.delete(k.toLowerCase()); }
  get id() { return this.getAttribute("id") ?? ""; }
  get name() { return this.getAttribute("name") ?? ""; }
  get className() { return this.getAttribute("class") ?? ""; }
  get type() {
    const t = (this.getAttribute("type") ?? "").toLowerCase();
    if (this.tagName === "INPUT") return t || "text";
    if (this.tagName === "BUTTON") return t || "submit";
    if (this.tagName === "SELECT") return "select-one";
    if (this.tagName === "TEXTAREA") return "textarea";
    return t;
  }
  get disabled() { return this.hasAttribute("disabled"); }
  get readOnly() { return this.hasAttribute("readonly"); }
  get required() { return this.hasAttribute("required"); }
  get placeholder() { return this.getAttribute("placeholder") ?? ""; }
  get autocomplete() { return this.getAttribute("autocomplete") ?? ""; }
  get maxLength() { const m = Number(this.getAttribute("maxlength")); return Number.isInteger(m) && m >= 0 && this.hasAttribute("maxlength") ? m : -1; }
  get src() { const s = this.getAttribute("src"); try { return s ? new URL(s, this.doc.url).href : ""; } catch { return s ?? ""; } }
  get action() { const a = this.getAttribute("action"); try { return new URL(a ?? "", this.doc.url).href; } catch { return this.doc.url; } }
  get method() { return (this.getAttribute("method") ?? "get").toLowerCase(); }
  get options() { return this.tagName === "SELECT" ? this.all().filter((e) => e.tagName === "OPTION") : []; }
  get form(): El | null { return this.closest("form"); }
  get elements() { return this.all().filter((e) => ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(e.tagName)); }
  get validity() {
    const empty = this.tagName === "SELECT" ? !(this.options[this.selectedIndex]?.getAttribute("value") ?? "")
      : this.type === "checkbox" || this.type === "radio" ? !(this.doc.groupOf(this).some((x) => x.checked))
      : this.type === "file" ? this.files.length === 0 : !String(this.value).trim();
    return { valid: !(this.required && empty) };
  }
  get validationMessage() { return this.validity.valid ? "" : "Please fill out this field."; }
  // --- tree
  get parentElement() { return this.parent; }
  get isConnected() { let e: El | null = this; while (e.parent) e = e.parent; return e === this.doc.root; }
  get nextElementSibling() { const p = this.parent; if (!p) return null; const i = p.children.indexOf(this); return p.children[i + 1] ?? null; }
  append(...cs: El[]) { for (const c of cs) { c.parent = this; this.children.push(c); } return this; }
  remove() { if (!this.parent) return; this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  contains(o: El | null): boolean { for (let e = o; e; e = e.parent) if (e === this) return true; return false; }
  all(): El[] { const out: El[] = []; const walk = (e: El) => { for (const c of e.children) { out.push(c); walk(c); } }; walk(this); return out; }
  cloneNode(_deep = true): El {
    const c = new El(this.tagName);
    c.doc = this.doc; c.ownText = this.ownText; c.attrs = new Map(this.attrs); c.own = this.own; c.checked = this.checked;
    c.hiddenStyle = this.hiddenStyle; c.offscreen = this.offscreen; c.selectedIndex = this.selectedIndex; c.files = this.files;
    for (const k of this.children) c.append(k.cloneNode(true));
    return c;
  }
  get textContent(): string { return this.ownText + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this.ownText = String(v); this.children = []; }
  // What a person sees: hidden subtrees and form controls' own text left out; blocks on their own lines.
  get innerText(): string {
    if (!this.visible()) return "";
    if (["INPUT", "SELECT", "TEXTAREA", "SCRIPT", "STYLE"].includes(this.tagName)) return "";
    const parts = [this.ownText, ...this.children.map((c) => c.innerText)].filter(Boolean);
    const block = ["DIV", "P", "H1", "H2", "H3", "H4", "LABEL", "LI", "FORM", "SECTION", "FIELDSET", "LEGEND", "BODY"].includes(this.tagName);
    return parts.join(block ? "\n" : " ");
  }
  // --- visibility and boxes
  visible(): boolean {
    for (let e: El | null = this; e; e = e.parent) if (e.hiddenStyle || e.hasAttribute("hidden") || (e.tagName === "INPUT" && e.type === "hidden" && e === this)) return false;
    return this.isConnected;
  }
  getClientRects() { return this.visible() ? [this.getBoundingClientRect()] : []; }
  getBoundingClientRect() {
    if (!this.visible()) return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    const x = this.offscreen ? -9999 : 10;
    return { x, y: 10, width: 200, height: 24, top: 10, left: x, right: x + 200, bottom: 34 };
  }
  get offsetParent() { return this.visible() ? this.doc.body : null; }
  // --- queries
  matches(sel: string): boolean { return parseList(sel).some((c) => matchComplex(this, c, null)); }
  closest(sel: string): El | null { const list = parseList(sel); for (let e: El | null = this; e; e = e.parent) if (list.some((c) => matchComplex(e!, c, null))) return e; return null; }
  querySelectorAll(sel: string): El[] { const list = parseList(sel); return this.all().filter((e) => list.some((c) => matchComplex(e, c, this))); }
  querySelector(sel: string): El | null { return this.querySelectorAll(sel)[0] ?? null; }
  // The control's own state, as a browser keeps it.
  get selectedOption(): El | null { return this.options[this.selectedIndex] ?? null; }
}

export class Doc {
  root: El;
  body: El;
  url: string;
  constructor(url: string) {
    this.url = url;
    this.root = new El("html");
    this.root.doc = this;
    this.body = new El("body");
    this.body.doc = this;
    this.root.append(this.body);
  }
  get baseURI() { return this.url; }
  get documentElement() { return this.root; }
  adopt(e: El) { e.doc = this; for (const c of e.children) this.adopt(c); return e; }
  querySelectorAll(sel: string) { return this.root.querySelectorAll(sel); }
  querySelector(sel: string) { return this.root.querySelector(sel); }
  getElementById(id: string) { return this.root.all().find((e) => e.id === id) ?? null; }
  groupOf(e: El) { return e.name ? this.root.all().filter((x) => x.tagName === "INPUT" && x.name === e.name && x.type === e.type) : [e]; }
}

// Builds an element: h("input", { id: "fn", name: "fn", required: true }), h("label", { for: "fn" }, "First name").
export function h(tag: string, attrs: Attrs = {}, ...kids: (El | string | null | undefined | false)[]): El {
  const e = new El(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "style:hidden") { e.hiddenStyle = true; continue; }
    if (k === "style:offscreen") { e.offscreen = true; continue; }
    e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (typeof k === "string") e.ownText += k;
    else e.append(k);
  }
  if (e.tagName === "INPUT" && e.hasAttribute("value")) e.value = e.getAttribute("value")!;
  if (e.tagName === "INPUT" && e.hasAttribute("checked")) e.checked = true;
  if (e.tagName === "SELECT") { const i = e.options.findIndex((o) => o.hasAttribute("selected")); e.selectedIndex = Math.max(0, i); }
  if (e.tagName === "OPTION" && !e.hasAttribute("value")) e.setAttribute("value", e.ownText);
  return e;
}

// ------------------------------------------------------------------------------------------------ selectors
type Simple = { tag?: string; id?: string; classes: string[]; attrs: { k: string; op: string; v?: string }[]; scope?: boolean };
type Complex = { parts: Simple[]; combs: string[] }; // combs[i] joins parts[i] and parts[i+1]: " " or ">" or "+" (unsupported: never matches)
const cache = new Map<string, Complex[]>();
function parseList(sel: string): Complex[] {
  const hit = cache.get(sel);
  if (hit) return hit;
  const list = splitTop(sel, ",").map((s) => parseComplex(s.trim())).filter(Boolean) as Complex[];
  cache.set(sel, list);
  return list;
}
function splitTop(s: string, ch: string) {
  const out: string[] = [];
  let depth = 0, quote = "", cur = "";
  for (const c of s) {
    if (quote) { if (c === quote) quote = ""; cur += c; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "[" || c === "(") depth++;
    if (c === "]" || c === ")") depth--;
    if (c === ch && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}
function parseComplex(s: string): Complex | null {
  const toks: string[] = [];
  let depth = 0, quote = "", cur = "";
  for (const c of s) {
    if (quote) { if (c === quote) quote = ""; cur += c; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "[") depth++;
    if (c === "]") depth--;
    if (depth === 0 && (c === " " || c === ">" || c === "+" || c === "~")) {
      if (cur) toks.push(cur);
      cur = "";
      if (c !== " ") toks.push(c);
      continue;
    }
    cur += c;
  }
  if (cur) toks.push(cur);
  const parts: Simple[] = [], combs: string[] = [];
  let pending = " ";
  for (const t of toks) {
    if (t === ">" || t === "+" || t === "~") { pending = t; continue; }
    if (parts.length) combs.push(pending);
    pending = " ";
    parts.push(parseSimple(t));
  }
  return parts.length ? { parts, combs } : null;
}
function parseSimple(t: string): Simple {
  const s: Simple = { classes: [], attrs: [] };
  if (t === ":scope") { s.scope = true; return s; }
  let i = 0;
  const ident = () => { let o = ""; while (i < t.length && /[A-Za-z0-9_\-]/.test(t[i])) o += t[i++]; return o; };
  if (/[A-Za-z*]/.test(t[0])) { if (t[0] === "*") i++; else s.tag = ident().toUpperCase(); }
  while (i < t.length) {
    const c = t[i];
    if (c === "#") { i++; s.id = ident(); }
    else if (c === ".") { i++; s.classes.push(ident()); }
    else if (c === "[") {
      const end = t.indexOf("]", i);
      const body = t.slice(i + 1, end);
      i = end + 1;
      const m = /^([A-Za-z0-9_\-:]+)\s*(?:([*^$~|]?=)\s*(.*))?$/.exec(body.trim());
      if (!m) { s.attrs.push({ k: "\u0000never", op: "exists" }); continue; }
      let v = m[3];
      if (v !== undefined) v = v.replace(/^(['"])(.*)\1$/, "$2").replace(/\\"/g, '"');
      s.attrs.push({ k: m[1].toLowerCase(), op: m[2] ?? "exists", v });
    } else if (c === ":") { s.attrs.push({ k: "\u0000never", op: "exists" }); break; } // other pseudo-classes: unsupported, never match
    else i++;
  }
  return s;
}
function matchSimple(e: El, s: Simple, scope: El | null): boolean {
  if (s.scope) return e === scope;
  if (s.tag && e.tagName !== s.tag) return false;
  if (s.id !== undefined && e.id !== s.id) return false;
  const cls = e.className.split(/\s+/);
  if (s.classes.some((c) => !cls.includes(c))) return false;
  for (const a of s.attrs) {
    const v = a.k === "type" ? (e.hasAttribute("type") || e.tagName === "INPUT" ? e.type : null) : e.getAttribute(a.k);
    if (v === null) return false;
    if (a.op === "=" && v !== a.v) return false;
    if (a.op === "*=" && !v.includes(a.v!)) return false;
    if (a.op === "^=" && !v.startsWith(a.v!)) return false;
    if (a.op === "$=" && !v.endsWith(a.v!)) return false;
  }
  return true;
}
function matchComplex(e: El, c: Complex, scope: El | null): boolean {
  const go = (el: El, k: number): boolean => {
    if (!matchSimple(el, c.parts[k], scope)) return false;
    if (k === 0) return true;
    const comb = c.combs[k - 1];
    if (comb === ">") return !!el.parent && go(el.parent, k - 1);
    if (comb === " ") { for (let p = el.parent; p; p = p.parent) if (go(p, k - 1)) return true; return false; }
    return false; // "+", "~": not needed by the engine's own selectors
  };
  return go(e, c.parts.length - 1);
}

// Runs an in-page function against this document, as page.evaluate would: the page's globals (document, window,
// location, getComputedStyle, CSS) for the length of the call, then restored. A function that throws rejects.
export async function inPage<T>(doc: Doc, fn: (...a: any[]) => T | Promise<T>, arg?: unknown): Promise<Awaited<T>> {
  const g = globalThis as any;
  const keys = ["document", "window", "location", "getComputedStyle", "CSS"];
  const saved = keys.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  const loc = new URL(doc.url);
  try {
    for (const [k, v] of Object.entries({
      document: doc, window: g, location: { href: loc.href, hostname: loc.hostname, pathname: loc.pathname, origin: loc.origin, search: loc.search, host: loc.host },
      getComputedStyle: (el: El) => ({ display: el.visible() ? "block" : "none", visibility: "visible" }), CSS: undefined,
    })) Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
    return await fn(arg) as Awaited<T>;
  } finally {
    for (const [k, d] of saved) { if (d) Object.defineProperty(g, k, d); else delete g[k]; }
  }
}
