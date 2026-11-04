// A fake browser for the real apply engine (scripts/apply.ts runApply), for tests/architect/scenarios-apply-r2*.test.ts.
// It stands in for scripts/career/portal-browser-helper.cjs (installed in the require cache under that file's own path,
// before the engine first requires it): createSession() gives the engine a session whose commands (open, discover,
// fill, readback, verify_payload, review, submit_and_capture, screenshot) follow the helper's own rules, and a page whose
// evaluate() runs the engine's in-page functions (fnDiscoverFields, fnDetectChallenge, fnPostingLocation and the
// engine's own closures) for real against a small DOM (apply-r2-dom.ts). Every request the page makes goes through the
// engine's own route handler (page.route), exactly as Playwright hands it over: the engine allows, refuses, rewrites or
// fulfills it; what the route lets through reaches the employer's site (a FakeSite), which records every application
// body it receives. That record is the ground truth the tests judge by: what the employer actually got, and how often.
// No Chromium, no network, no clock of its own.
import { createRequire } from "node:module";
import { Doc, El, inPage } from "./apply-r2-dom.ts";

const require = createRequire(import.meta.url);
const PF = require("../../../scripts/career/page-functions.cjs");
const { fnDetectChallenge, fnCaptchaTech, fnDiscoverFields } = PF;

export interface Served { status: number; headers?: Record<string, string>; doc?: (url: string) => Doc }
export interface Received { url: string; form: FormData; entries: [string, string | { name: string; sha256: string; size: number }][] }
export interface FakeSite {
  // The employer's server: a page for a GET, an answer for a POST (the form data as the page sent it).
  serve(req: { url: string; method: string; form?: FormData; fileShas?: Record<string, string> }): Served | Promise<Served>;
  // The page's own script: after a field is filled, at the click on Submit, and on Next (true when the page moved).
  onFill?(doc: Doc, el: El): void;
  atClick?(doc: Doc): boolean | void; // false: the page's script stopped the submission (an interstitial check)
  next?(doc: Doc): boolean;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((n) => n.toString(16).padStart(2, "0")).join("");
export const sha256 = async (b: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", b as BufferSource));
const normOpt = (s: unknown) => String(s || "").toLowerCase().replace(/[’‘]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
const normPersist = (x: unknown) => String(x == null ? "" : x).replace(/\s+/g, " ").trim();
function matchOption(options: any[], value: unknown) {
  const v = normOpt(value);
  if (!v) return null;
  let hit = options.find((o) => normOpt(o.label) === v || normOpt(o.value) === v);
  if (hit) return hit;
  const head = v.split(/\s*[—–(]\s*/)[0].trim();
  hit = options.find((o) => normOpt(o.label) === head || normOpt(o.value) === head);
  if (hit) return hit;
  return options.find((o) => normOpt(o.label).startsWith(v) || v.startsWith(normOpt(o.label)) && normOpt(o.label).length > 1) ?? null;
}
const err = (code: string) => Object.assign(new Error(code), { code });

// The world the next session opens: one site at a time (the tests run one engine at a time).
let site: FakeSite | null = null;
export function useSite(s: FakeSite | null) { site = s; }
let shotSeq = 0;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function session() {
  let doc = new Doc("about:blank");
  let handler: ((route: any) => Promise<void>) | null = null;
  const MAIN = { main: true };
  let blockedNav: string | null = null;
  let observation: any = null;
  const handles = new Map<string, El>();
  let closed = false;
  const page = {
    route: async (_p: string, h: any) => { handler = h; },
    evaluate: (fn: any, arg?: unknown) => inPage(doc, fn, arg),
    url: () => doc.url,
    mainFrame: () => MAIN,
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    // A picture: the PNG signature and a few bytes naming the page (the receipt store takes only a PNG).
    screenshot: async (o: { path: string }) => { await Deno.writeFile(o.path, new Uint8Array([...PNG_SIG, ...new TextEncoder().encode(`fake ${++shotSeq} ${doc.url}`)])); },
    locator: () => { throw err("LOCATOR_NOT_FAKED"); },
  };
  // One request through the engine's route: what the route did, and the employer's answer when it went out.
  async function through(req: { url: string; method: string; main: boolean; type?: string; body?: Uint8Array; form?: FormData; fileShas?: Record<string, string> }) {
    let outcome: { kind: "aborted" } | { kind: "fulfilled"; served: Served } | null = null;
    let fetched: Served | null = null;
    const request = {
      url: () => req.url, method: () => req.method, isNavigationRequest: () => req.main, frame: () => (req.main ? MAIN : {}),
      headers: () => (req.type ? { "content-type": req.type } : {}),
      postData: () => (req.body ? new TextDecoder().decode(req.body) : null), postDataBuffer: () => req.body ?? null,
    };
    const fetchIt = async (): Promise<Served> => {
      if (!site) throw err("NO_SITE");
      fetched = await site.serve({ url: req.url, method: req.method, form: req.form, fileShas: req.fileShas });
      return fetched;
    };
    const route = {
      request: () => request,
      abort: async () => { outcome = { kind: "aborted" }; },
      continue: async () => { outcome = { kind: "fulfilled", served: await fetchIt() }; },
      fetch: async () => {
        const s = await fetchIt();
        const headers = Object.fromEntries(Object.entries(s.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
        return { status: () => s.status, headers: () => headers, text: async () => (s.doc ? s.doc(req.url).body.innerText : ""), __served: s };
      },
      fulfill: async (o: any) => {
        if (o?.response?.__served) outcome = { kind: "fulfilled", served: o.response.__served };
        else outcome = { kind: "fulfilled", served: { status: o?.status ?? 200, doc: (u) => textDoc(u, String(o?.body ?? "")) } };
      },
    };
    if (!handler) throw err("NO_ROUTE");
    await handler(route);
    return { outcome: outcome as typeof outcome, fetched: fetched as Served | null };
  }
  // A navigation (the posting's open, a redirect, the form's own submission): followed through the route, at most 6 hops.
  async function navigate(first: { url: string; method: string; type?: string; body?: Uint8Array; form?: FormData; fileShas?: Record<string, string> }) {
    let req: { url: string; method: string; main: boolean; type?: string; body?: Uint8Array; form?: FormData; fileShas?: Record<string, string> } = { ...first, main: true };
    for (let hop = 0; hop < 6; hop++) {
      const r = await through(req);
      if (!r.outcome || r.outcome.kind === "aborted") {
        blockedNav = blockedNav ?? req.url;
        doc = textDoc("chrome-error://chromewebdata/", "This site can't be reached");
        return;
      }
      const s = r.outcome.served;
      if (s.status >= 300 && s.status < 400 && s.headers?.location) {
        req = { url: new URL(s.headers.location, req.url).href, method: "GET", main: true };
        continue;
      }
      doc = s.doc ? s.doc(req.url) : textDoc(req.url, "");
      return;
    }
    doc = textDoc(req.url, "Too many redirects");
  }
  const field = (ref: string) => {
    const el = handles.get(ref);
    if (!el || !el.isConnected) throw err("STALE_OBSERVATION");
    return el;
  };
  function readOne(b: any): unknown {
    const els = (b.elementRefs || []).map((r: string) => handles.get(r)).filter(Boolean) as El[];
    let live = els.filter((e) => e.isConnected);
    if (!live.length && b.selector) {
      // Re-observed by its selector (the helper's readbackBindingFresh): the field as the page shows it now.
      const again = doc.root.all().filter((e) => ["INPUT", "SELECT", "TEXTAREA"].includes(e.tagName) && (`#${e.id}` === b.selector || `${e.tagName.toLowerCase()}[name="${e.name}"]` === b.selector));
      live = again;
    }
    if (!live.length) return undefined;
    const e = live[0];
    let v: unknown;
    if (b.inputType === "file") v = e.files[0] ? { filename: e.files[0].name, sha256: e.files[0].sha256 } : null;
    else if (b.inputType === "select") v = e.selectedOption?.textContent.trim() ?? "";
    else if (b.inputType === "checkbox") v = e.checked ? true : undefined;
    else if (b.inputType === "radio_group" || b.inputType === "checkbox_group") {
      const chosen: string[] = [];
      for (const o of b.options || []) { const el = handles.get(o.ref); if (el?.isConnected && el.checked) chosen.push(o.label); }
      v = b.inputType === "radio_group" ? chosen[0] : (chosen.length ? chosen : undefined);
    } else v = e.value;
    if (v === null || v === undefined || v === "" || (typeof v === "string" && !v.trim()) || /^select/i.test(String(v))) return undefined;
    return v;
  }
  const cmds: Record<string, (c: any) => Promise<any>> = {
    async open(c) {
      blockedNav = null;
      await navigate({ url: c.url, method: "GET" });
      if (blockedNav) return { ok: true, captcha: null, finalUrl: blockedNav, blockedNavigation: blockedNav, fieldCount: 0, captchaTech: [] };
      const captcha = await inPage(doc, fnDetectChallenge);
      const tech = await inPage(doc, fnCaptchaTech);
      return { ok: true, captcha, finalUrl: doc.url, fieldCount: 0, captchaTech: tech };
    },
    async discover() {
      const fields = await inPage(doc, fnDiscoverFields) as any[];
      const version = crypto.randomUUID();
      const all = doc.root.querySelectorAll("input,select,textarea");
      for (const f of fields) { f.ref = `${version}:f:${f.domIndex}`; handles.set(f.ref, all[f.domIndex]); }
      const controls: any[] = [];
      doc.root.querySelectorAll("button,input[type=submit],a[role=button]").forEach((el, i) => {
        if (!el.getClientRects().length) return;
        const label = (el.innerText || el.value || el.textContent || "").trim().slice(0, 200);
        const ref = `${version}:b:${i}`;
        handles.set(ref, el);
        controls.push({ ref, label, disabled: el.disabled, visible: true,
          kind: /^next$|^continue$|^review application$|^save and continue$/i.test(label) ? "next" : /submit/i.test(label) ? "submit" : "other" });
      });
      const lines = (sel: string) => doc.root.querySelectorAll(sel).filter((e) => e.getClientRects().length).map((e) => (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300)).filter(Boolean).slice(0, 12);
      observation = { version, frame: "main", origin: new URL(doc.url).origin, untrusted: true, fields, controls, instructions: lines("h1,h2,p,legend,.instructions"),
        errors: lines("[role=alert],.error,.validation-error,[aria-invalid=true]") };
      return { fields, observation };
    },
    async fill(c) {
      const b = c.binding, value = c.value;
      if (b.inputType === "file") {
        const bytes = await Deno.readFile(c.filePath);
        if (await sha256(bytes) !== value.sha256) throw err("RESUME_SHA_MISMATCH");
        const el = field(b.elementRefs[0]);
        el.files = [{ name: value.filename, bytes, sha256: value.sha256 }];
        site?.onFill?.(doc, el);
        const got = readOne(b) as any;
        return got && got.sha256 === value.sha256 ? { filled: true, verified: true } : { filled: false, reason: "value_did_not_persist" };
      }
      const els = (b.elementRefs as string[]).map(field);
      let expect: unknown;
      if (b.inputType === "select") {
        const hit = matchOption(b.options || [], value);
        if (!hit) return { filled: false, reason: "option_not_found" };
        if (hit.value === "" && (b.options || []).indexOf(hit) === 0) return { filled: false, reason: "placeholder_option" };
        els[0].selectedIndex = els[0].options.findIndex((o) => o.getAttribute("value") === hit.value);
        expect = hit.label;
      } else if (b.inputType === "radio_group" || b.inputType === "checkbox_group") {
        const hits: string[] = [];
        for (const want of Array.isArray(value) ? value : [value]) {
          const hit = matchOption(b.options || [], want);
          if (!hit) return { filled: false, reason: "option_not_found" };
          const el = field(hit.ref);
          if (b.inputType === "radio_group") for (const x of doc.groupOf(el)) x.checked = false;
          el.checked = true;
          hits.push(hit.label);
        }
        expect = b.inputType === "radio_group" ? hits[0] : hits;
      } else if (b.inputType === "checkbox") {
        const yes = value === true || value === "true";
        els[0].checked = yes;
        expect = yes ? true : "__absent__";
      } else {
        // A browser types into a box with a maxlength only up to that length (the rest of the text is dropped).
        const s = String(value), max = els[0].maxLength;
        els[0].value = max >= 0 ? s.slice(0, max) : s;
        expect = s;
      }
      for (const el of els) site?.onFill?.(doc, el);
      const got = readOne(b);
      const ok = expect === "__absent__" ? got === undefined : expect === true ? got === true
        : Array.isArray(expect) ? Array.isArray(got) && got.map(normPersist).sort().join("\n") === expect.map(normPersist).sort().join("\n")
        : got !== undefined && normPersist(got) === normPersist(expect);
      return ok ? { filled: true, verified: true, rendered: expect } : { filled: false, reason: "value_did_not_persist", wanted: String(value) };
    },
    async readback(c) {
      const answers: Record<string, unknown> = {};
      for (const b of c.bindings) { const v = readOne(b); if (v !== undefined) answers[b.field_id] = v; }
      return { answers };
    },
    async verify_payload(c) {
      const { answers } = await cmds.readback(c);
      if (answers.resume) (answers as any).resume_sha256 = (answers.resume as any).sha256;
      const mismatchedFields = Object.entries(c.payload).filter(([k, v]) => JSON.stringify(answers[k]) !== JSON.stringify(v)).map(([k]) => k);
      return { matches: mismatchedFields.length === 0, mismatchedFields };
    },
    async review(c) {
      if (await inPage(doc, fnDetectChallenge)) return { captcha: "challenge", finalUrl: doc.url };
      const fields = await inPage(doc, fnDiscoverFields) as any[];
      if (fields.some((f) => !(c.knownSelectors || []).includes(f.selector))) return { needsFields: true, finalUrl: doc.url };
      if (fields.filter((f) => !f.disabled && f.required && !f.valid).length) return { code: "FORM_VALIDATION_FAILED", finalUrl: doc.url };
      for (const control of observation.controls) {
        const el = handles.get(control.ref);
        if (!el || !el.isConnected) throw err("STALE_OBSERVATION");
        if (control.disabled !== el.disabled) return { needsFields: true, finalUrl: doc.url };
      }
      const next = observation.controls.find((x: any) => x.kind === "next" && !x.disabled);
      if (next) {
        site?.next?.(doc);
        return { advanced: true, captcha: await inPage(doc, fnDetectChallenge), finalUrl: blockedNav || doc.url, blockedNavigation: blockedNav };
      }
      return { atFinalReview: !!observation.controls.find((x: any) => x.kind === "submit" && !x.disabled), finalUrl: doc.url };
    },
    async submit_and_capture() {
      if (await inPage(doc, fnDetectChallenge)) return { captcha: "challenge", clicked: false };
      const submit = observation.controls.find((x: any) => x.kind === "submit" && !x.disabled);
      if (!submit) return { clicked: false, reason: "no_submit_control" };
      const btn = handles.get(submit.ref);
      if (!btn || !btn.isConnected) throw err("STALE_OBSERVATION");
      if (btn.disabled) return { clicked: false, reason: "submit_disabled" };
      const form = btn.form;
      if (site?.atClick?.(doc) === false) return { clicked: true, captcha: (await inPage(doc, fnDetectChallenge)) || null, finalUrl: doc.url, text: doc.body.innerText.replace(/\s+/g, " ").slice(0, 6000) };
      if (form) {
        const fd = new FormData(), fileShas: Record<string, string> = {};
        for (const el of form.elements) {
          if (!el.name || el.disabled || el.tagName === "BUTTON" || ["submit", "button", "image"].includes(el.type)) continue;
          if (el.type === "checkbox" || el.type === "radio") { if (el.checked) fd.append(el.name, el.getAttribute("value") ?? "on"); continue; }
          if (el.tagName === "SELECT") { fd.append(el.name, el.selectedOption?.getAttribute("value") ?? ""); continue; }
          if (el.type === "file") { const f = el.files[0]; fd.append(el.name, f ? new File([f.bytes as BlobPart], f.name) : new File([], "")); if (f) fileShas[el.name] = await sha256(f.bytes); continue; }
          fd.append(el.name, el.value);
        }
        const r = new Response(fd);
        const type = r.headers.get("content-type")!;
        const body = new Uint8Array(await r.arrayBuffer());
        await navigate({ url: form.action, method: form.method.toUpperCase(), type, body, form: fd, fileShas });
      }
      if (blockedNav) return { clicked: true, finalUrl: blockedNav, text: "", blockedNavigation: blockedNav };
      const captcha = await inPage(doc, fnDetectChallenge);
      return { clicked: true, captcha: captcha || null, finalUrl: doc.url, text: doc.body.innerText.replace(/\s+/g, " ").slice(0, 6000) };
    },
    async screenshot(c) { await page.screenshot({ path: c.path }); return { path: c.path }; },
  };
  return {
    send: async (cmd: any) => {
      if (closed) throw err("BROWSER_SESSION_CLOSED");
      const f = cmds[cmd.type];
      if (!f) throw err("BAD_COMMAND");
      return await f(cmd);
    },
    page: async () => page,
    close: async () => { closed = true; },
  };
}

// A plain page with some text (a refusal, an error page).
export function textDoc(url: string, text: string) {
  const d = new Doc(url);
  const p = new El("p");
  p.ownText = text;
  d.body.append(d.adopt(p));
  return d;
}

// The helper module the engine requires, by that file's own path.
export const fakeHelper = { createSession: async () => session(), detectChallenge: fnDetectChallenge, captchaTech: fnCaptchaTech };
const engineRequire = createRequire(new URL("../../../scripts/apply.ts", import.meta.url));
const helperPath = engineRequire.resolve("./career/portal-browser-helper.cjs");
(engineRequire as any).cache[helperPath] = { id: helperPath, filename: helperPath, loaded: true, exports: fakeHelper, children: [], paths: [] };
