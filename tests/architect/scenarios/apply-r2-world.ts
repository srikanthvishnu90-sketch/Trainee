// The employer's side of a generated form case (apply-r2-generator.ts formCase) for the fake browser
// (apply-r2-browser.ts), the person's confirmed facts and resume on disk, and the real engine run in this process
// (scripts/apply.ts runApply, as the RunEngine the workers call). Shared by scenarios-apply-r2-forms*.test.ts (memory)
// and flow-scenarios-apply-r2.test.ts (real Postgres). The site records every application body it receives: that
// record, not the product's own report, is what the tests judge by.
import { Doc, El, h } from "./apply-r2-dom.ts";
import { type FakeSite, type Received, type Served, sha256, textDoc, useSite } from "./apply-r2-browser.ts";
import { type FieldSpec, type FormCase, THANKS } from "./apply-r2-generator.ts";
import { runApply } from "../../../scripts/apply.ts";
import { normLabel } from "../../../supabase/functions/_shared/career_apply.ts";
import type { EngineControls, EngineResult, RunEngine } from "../../../workers/career-browser/approve-first.ts";

export interface World {
  c: FormCase; site: FakeSite; posts: Received[]; phase: "prepare" | "submit"; nexts: number; filledHoneypot: boolean;
  dir: string; factsPath: string; resumePath: string; stateDir: string; resumeSha: string; resumeBytes: Uint8Array;
  // The cloud worker's authorization of the one effect (RunEngine controls.beforeEffect), asked as the request leaves.
  beforeEffect?: () => Promise<void>;
}
const enc = new TextEncoder();
const POSITIVE = "owner stated in chat 2026-10-20";
export function factsFile(c: FormCase, edit = false) {
  const own = (k: string, v: string) => ({ value: v, factId: `F-${k}`, confirmed: true, user_id: c.person.id, provenance: POSITIVE, confirmation_event_id: `evt-${c.person.id.slice(-6)}-${k}` });
  const answers: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c.person.facts)) answers[k] = own(k, edit && k === "email" ? `changed.${v}` : v!);
  const saved: Record<string, unknown> = {};
  const why = c.fields.find((f) => f.kind === "why");
  if (why && c.why) saved[normLabel(why.label)] = { value: c.why, factId: `F-why-${c.n}`, confirmed: true, user_id: c.person.id, provenance: "owner typed this answer in chat", confirmation_event_id: `evt-why-${c.n}` };
  return { user_id: c.person.id, answers, saved };
}
// The person's choice for a select or radio, as the form's own option (what the employer should receive).
export function chosen(c: FormCase, f: FieldSpec) {
  const v = c.person.facts[f.kind as keyof typeof c.person.facts];
  return f.options?.find((o) => o.label === v) ?? null;
}

function fieldEls(c: FormCase, f: FieldSpec, w: World): El[] {
  const submit = w.phase === "submit";
  let label = f.label, name = f.name;
  // The field the change hits: one the person's approval answered (a core fact, always answered).
  const first = c.fields.find((x) => ["first_name", "last_name", "email"].includes(String(x.kind)));
  if (submit && c.twist === "rename_label" && f === first) label = `${f.label} (as shown on your passport)`;
  if (submit && c.twist === "rename_name" && f === first) name = `${f.name}_v2`;
  const id = f.id || undefined;
  const attrs: Record<string, string | boolean | undefined> = { id, name, required: f.required };
  if (f.type === "radio") {
    let opts = f.options!;
    if (submit && c.twist === "remove_option") { const ch = chosen(c, f); opts = opts.filter((o) => o !== ch); }
    return [h("fieldset", {}, h("legend", {}, label),
      ...opts.map((o, i) => h("label", {}, h("input", { type: "radio", name, value: o.value, id: id ? `${id}_${i}` : undefined, required: f.required }), o.label)))];
  }
  if (f.type === "select") {
    let opts = f.options!;
    if (submit && c.twist === "remove_option") { const ch = chosen(c, f); opts = opts.filter((o) => o !== ch); }
    return [h("label", id ? { for: id } : {}, label), h("select", attrs, ...opts.map((o) => h("option", { value: o.value }, o.label)))];
  }
  if (f.honeypot === "dom") {
    return [h("div", { "aria-hidden": "true", "style:offscreen": true }, h("label", id ? { for: id } : {}, label),
      h("input", { ...attrs, type: "text", tabindex: "-1", autocomplete: "off", "style:offscreen": true }))];
  }
  const input = f.type === "textarea" ? h("textarea", { ...attrs, maxlength: f.maxlength }) : h("input", { ...attrs, type: f.type === "date" ? "date" : f.type, maxlength: f.maxlength });
  return id ? [h("label", { for: id }, label), input] : [h("label", {}, label, input)];
}
// The posting's page: the form, its hidden fields, its pages, its buttons, as the employer serves it now.
function formDoc(w: World, url: string) {
  const c = w.c, d = new Doc(url);
  const path = new URL(c.posting).pathname;
  let fields = [...c.fields];
  if (w.phase === "submit" && c.twist === "reorder") fields = [...fields].reverse();
  if (w.phase === "submit" && c.twist === "add_required") fields.push({ kind: "new", name: "pronouns_new", id: "f_pronouns", label: "Preferred pronouns", type: "text", required: true, page: c.pages - 1 });
  if (w.phase === "submit" && c.twist === "add_optional") fields.push({ kind: "new", name: "twitter_new", id: "f_twitter", label: "Twitter handle", type: "text", required: false, page: c.pages - 1 });
  const pages = Array.from({ length: c.pages }, (_, p) => h("div", { class: "page", "data-page": String(p), hidden: p > 0 },
    ...fields.filter((f) => f.page === p).flatMap((f) => [h("div", { class: "field" }, ...fieldEls(c, f, w))]),
    p < c.pages - 1 ? h("button", { type: "button", class: "next" }, "Next") : h("button", { type: "submit" }, "Submit application")));
  const form = h("form", { action: c.action === "same" ? path : `${path}/apply`, method: "post", class: "application" },
    ...c.hidden.map(([n, v]) => h("input", { type: "hidden", name: n, value: v })), ...pages);
  const header = h("div", { class: "job__location" }, "Austin, TX");
  d.body.append(d.adopt(h("h1", {}, `Data Analyst at ${c.employer}`)), d.adopt(header), d.adopt(form));
  if (c.twist === "captcha_open") d.body.append(d.adopt(h("iframe", { src: "https://www.google.com/recaptcha/api2/anchor?k=TESTKEY&size=normal" })));
  return d;
}
const challenge = () => h("iframe", { src: "https://www.google.com/recaptcha/api2/bframe?k=TESTKEY" });
// What the employer's page says after the one application request.
function afterPage(w: World, url: string): Served {
  const c = w.c;
  const path = new URL(c.posting).pathname;
  if (c.twist === "captcha_after") return { status: 200, doc: (u) => { const d = textDoc(u, "Please verify you are human to continue."); d.body.append(d.adopt(challenge())); return d; } };
  if (c.twist === "redirect_after") return { status: 303, headers: { location: c.redirect! } };
  const t = (s: string): Served => ({ status: 200, doc: (u) => textDoc(u, s) });
  switch (c.after) {
    case "thanks": return t(`${THANKS.en[c.n % THANKS.en.length].replace("{c}", c.employer)}`);
    case "thanks_id": return t(`Thank you for applying! Your application has been received. Confirmation number: APP-${10000 + c.n}`);
    case "moved_silent": return { status: 303, headers: { location: `${path}/done` } };
    case "same_silent": return t(`${c.employer} careers`);
    case "form_again": return { status: 200, doc: (u) => formDoc({ ...w, phase: "prepare" }, u) };
    case "errors": return { status: 200, doc: (u) => { const d = formDoc({ ...w, phase: "prepare" }, u); d.body.append(d.adopt(h("div", { role: "alert" }, "Please complete this required field."))); return d; } };
    case "dup": return t("You have already applied to this job. We have received your application.");
    case "error_words": return t("Thank you for applying. Unfortunately an error occurred and your application could not be submitted. Please try again.");
    case "foreign_thanks": return t(["Vielen Dank für Ihre Bewerbung!", "Merci pour votre candidature !", "¡Gracias por tu postulación!"][c.n % 3]);
    case "email_code": return { status: 200, doc: (u) => { const d = textDoc(u, "We emailed you a verification code. Enter it to finish your application.");
      d.body.append(d.adopt(h("form", { action: `${path}/code`, method: "post" }, h("label", { for: "code" }, "Verification code"), h("input", { id: "code", name: "code" }))));
      return d; } };
    case "http500": return { status: 500, doc: (u) => textDoc(u, "Internal Server Error") };
  }
  void url;
  return t("");
}

export async function world(c: FormCase, root: string): Promise<World> {
  const dir = `${root}/case-${c.n}`;
  await Deno.mkdir(dir, { recursive: true });
  const resumeBytes = enc.encode(`%PDF-1.4 TEST resume of ${c.person.id}`);
  const w: World = { c, site: null as unknown as FakeSite, posts: [], phase: "prepare", nexts: 0, filledHoneypot: false, dir,
    factsPath: `${dir}/facts.json`, resumePath: `${dir}/resume.pdf`, stateDir: `${root}/state-${c.person.id.slice(-6)}`, resumeSha: await sha256(resumeBytes), resumeBytes };
  await Deno.writeTextFile(w.factsPath, JSON.stringify(factsFile(c)));
  await Deno.writeFile(w.resumePath, resumeBytes);
  const path = new URL(c.posting).pathname;
  w.site = {
    async serve(req) {
      const u = new URL(req.url);
      if (req.method === "GET") {
        if (u.pathname === path) {
          if (c.twist === "refuse_open") return { status: c.refuse!.status, headers: c.refuse!.retryAfter ? { "retry-after": c.refuse!.retryAfter } : {}, doc: (x) => textDoc(x, "Too many requests") };
          if (c.twist === "redirect_open") return { status: 302, headers: { location: c.redirect! } };
          return { status: 200, doc: (x) => formDoc(w, x) };
        }
        if (u.pathname === `${path}/done`) return { status: 200, doc: (x) => textDoc(x, `${c.employer} careers. Back to all jobs`) };
        return { status: 404, doc: (x) => textDoc(x, "Not found") };
      }
      if (req.method === "POST" && (u.pathname === path || u.pathname === `${path}/apply`)) {
        if (w.beforeEffect) await w.beforeEffect();
        const entries: Received["entries"] = [];
        for (const [k, v] of req.form!.entries()) entries.push([k, typeof v === "string" ? v : { name: v.name, sha256: req.fileShas?.[k] ?? "", size: v.size }]);
        const rec: Received = { url: req.url, form: req.form!, entries };
        w.posts.push(rec);
        return afterPage(w, req.url);
      }
      return { status: 404, doc: (x) => textDoc(x, "Not found") };
    },
    onFill(doc, el) {
      if (c.twist === "reformat" && el.tagName === "INPUT" && ["text", "email", "tel"].includes(el.type) && el.value && !el.getAttribute("data-r2")) {
        el.setAttribute("data-r2", "1");
        el.value = el.value.toUpperCase() === el.value ? el.value.toLowerCase() : el.value.toUpperCase();
      }
      if (el.getAttribute("tabindex") === "-1" && el.value) w.filledHoneypot = true;
      void doc;
    },
    atClick(doc) {
      if (c.twist === "captcha_click") { doc.body.append(doc.adopt(challenge())); return false; }
      const form = doc.querySelector("form");
      if (c.twist === "click_rewrite") {
        const t = doc.querySelectorAll("input").find((e) => ["text", "email", "tel"].includes(e.type) && e.value && e.name);
        if (t) t.value = `${t.value} `.replace(/ $/, "") + ".";
      }
      if (c.twist === "click_add_field" && form) form.append(doc.adopt(h("input", { type: "hidden", name: "tracking_ref", value: "TEST-added-at-click" })));
      if (c.twist === "click_swap_file") {
        const f = doc.querySelectorAll("input").find((e) => e.type === "file" && e.files.length);
        if (f) f.files = [{ name: f.files[0].name, bytes: enc.encode("%PDF-1.4 another file"), sha256: "0".repeat(64) }];
      }
    },
    next(doc) {
      w.nexts++;
      const pages = doc.querySelectorAll("div.page");
      const at = pages.findIndex((p) => !p.hasAttribute("hidden"));
      if (c.twist === "back_nav" && w.nexts === 1) {
        // The page's own check sends the person back to the first page with its answers cleared.
        for (const e of pages[at].querySelectorAll("input,textarea")) { e.value = ""; e.checked = false; e.files = []; }
        return true;
      }
      if (at < 0 || at >= pages.length - 1) return false;
      pages[at].setAttribute("hidden", "");
      pages[at + 1].removeAttribute("hidden");
      if (c.twist === "captcha_next") doc.body.append(doc.adopt(challenge()));
      return true;
    },
  };
  return w;
}

// The real engine in this process, as a RunEngine: the fake browser shows this world's site; the clock is the test's.
// A local test page: the engine's once-only record lives in the person's own state folder (one per person, as one machine).
let tick = 0;
export function inProcessEngine(w: World, clock: () => number): RunEngine {
  return async (args: string[], _env?: Record<string, string>, controls?: EngineControls): Promise<EngineResult | null> => {
    useSite(w.site);
    w.beforeEffect = controls?.beforeEffect;
    const evidenceDir = `${w.dir}/ev-${++tick}`;
    const log = console.log, now = Date.now;
    let seq = 0;
    console.log = () => {};
    Date.now = () => clock() + (seq++);
    let result: any;
    try {
      const extra = args.includes("--state-dir") ? [] : ["--state-dir", w.stateDir];
      result = await runApply([...args, ...extra, "--evidence-dir", evidenceDir]);
    } catch (e: any) {
      result = { state: "not_submitted", reason: e?.code || "INVALID_APPLY_INPUT" };
    } finally {
      console.log = log;
      Date.now = now;
      useSite(null);
      w.beforeEffect = undefined;
    }
    let evidence = null;
    try { evidence = JSON.parse(await Deno.readTextFile(`${evidenceDir}/evidence.json`)); } catch { /* none */ }
    return { result, evidence };
  };
}
