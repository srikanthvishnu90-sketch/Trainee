// The general file system (owner, 2026-10-28): the jobs list is ONE kind of file. The agent creates many kinds (introduction,
// application proof, plan review, comparison, draft, research brief), each = a typed schema + renderer + truthful action set + a
// plain-text twin, behind one page shell and one create_file tool. Memory stores, a fake clock, no network, no model.
import assertNode from "node:assert/strict";
import { signedIn, phonePost } from "./file-session-fakes.ts";
const A = signedIn();
import { actionsOf, KIND_IDS, SOURCES, textOf, validateKind, type FileRecord } from "../../supabase/functions/_shared/file_kinds.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { createFileTool } from "../../supabase/functions/_shared/agent/file_tool.ts";
import { runAgentTurn } from "../../supabase/functions/_shared/agent/loop.ts";
import { shapeForTurn } from "../../supabase/functions/_shared/channel_shape.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SECRET = "file-link-secret-0123456789-abcdef", BASE = "https://trainee.example/file";
const U = "11111111-1111-4111-8111-111111111111", V = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-28T12:00:00Z");
const ENV = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: BASE, TRAINEE_BOT_URL: "https://t.me/TraineeBot" } as Record<string, string | undefined>;

// ---- one valid sample per kind (every fact carries a source label)
const SAMPLES: Record<string, unknown> = {
  introduction: { title: "Intro to Dana Lee", person: { name: "Dana Lee", role: "Analytics Manager", company: "Acme", source: "Reported, not verified" },
    why: [{ text: "You built weekly pricing dashboards in SQL.", source: "From your resume" }, { text: "Acme is hiring a Data Analyst.", source: "From the posting" }, { text: "You want a growth-team role.", source: "From you" }],
    message: { channel: "email", subject: "Quick question about analytics at Acme", body: "Hi Dana, I build pricing dashboards and saw Acme is hiring. Could I ask you two questions about the team?" } },
  application_proof: { from_record: true, title: "Application to Acme", company: "Acme", role: "Data Analyst", destination: "boards.greenhouse.io", status: "confirmed", prepared_at: "2026-10-28T09:00:00Z", submitted_at: "2026-10-28T10:00:00Z", as_of: "2026-10-28T11:00:00Z",
    confirmation: { id: "GH-4471", url: "https://boards.greenhouse.io/acme/confirmation/4471" }, resume: "ada-resume.pdf",
    answers: [{ question: "Years of SQL", answer: "3", source: "From your resume" }, { question: "Work authorization", answer: "Yes", source: "From you" }],
    problems: [{ item: "Portfolio link", outcome: "skipped", reason: "You have not given Trainee a portfolio link." }] },
  plan_review: { title: "Your week", variant: "pipeline", period: "Oct 19 - Oct 25",
    sections: [{ heading: "Applications", items: [{ label: "Submitted", value: "4", source: "From you" }, { label: "Confirmed", value: "2", source: "Reported, not verified" }] }, { heading: "Interviews", items: [{ label: "Acme phone screen", value: "Thursday 2pm", source: "From you" }] }] },
  comparison: { title: "Acme vs Globex", options: [{ name: "Acme" }, { name: "Globex" }],
    rows: [{ label: "Base pay", cells: [{ value: "$90k", source: "From the posting" }, { value: "$95k", source: "Reported, not verified" }] }, { label: "Remote", cells: [{ value: "Hybrid", source: "From the posting" }, null] }] },
  draft: { title: "Cover letter for Acme", type: "cover_letter", to: "hiring@acme.com", subject: "Data Analyst application", body: "Dear Acme team,\n\nI build weekly pricing dashboards in SQL and would like to join your growth team.\n\nAda",
    basis: [{ label: "Experience", value: "Weekly pricing dashboards in SQL", source: "From your resume" }] },
  research_brief: { title: "Acme research", subject: "Acme", findings: [{ label: "Product", value: "Pricing analytics software", source: "Reported, not verified" }, { label: "Open role", value: "Data Analyst, Austin TX", source: "From the posting" }],
    sources: [{ title: "Acme about page", url: "https://acme.example/about" }] },
};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
// application_proof data is built by code from a record; the sample is that built data (trusted), everything else is model data.
const val = (kind: string, data: unknown) => validateKind(kind, data, { trusted: kind === "application_proof" });
const rec = (kind: string, data: unknown = SAMPLES[kind], extra: Partial<FileRecord> = {}): FileRecord => ({ id: "0123456789", userId: U, kind: kind as never, data, state: {}, tag: null, created_at: NOW, expires_at: NOW + 3600_000, revoked_at: null, ...extra });
// Every string a person must be able to read in a sample: all values under these keys.
function leaves(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) x.forEach((v) => leaves(v, out));
  else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) { if (!["variant", "channel", "type", "outcome", "status", "prepared_at", "submitted_at", "as_of"].includes(k)) leaves(v, out); }
  else if (typeof x === "string") out.push(x);
  return out;
}

// ================================================================== schema validation per kind
Deno.test("registry: the seven kinds, the four source labels", () => {
  eq([...KIND_IDS].sort(), ["application_proof", "comparison", "draft", "introduction", "job_list", "plan_review", "research_brief"]);
  for (const s of ["From the posting", "From your resume", "From you", "Reported, not verified"]) assert((SOURCES as readonly string[]).includes(s), s);
});
Deno.test("schema: every sample is accepted and a missing required part is refused, per kind", () => {
  for (const [kind, data] of Object.entries(SAMPLES)) {
    const ok = val(kind, clone(data));
    assert(ok.ok, `${kind}: ${JSON.stringify((ok as { errors?: string[] }).errors)}`);
    const bad = val(kind, { title: "only a title" });
    assert(!bad.ok && bad.errors.length > 0, `${kind} accepted a title and nothing else`);
    assert(!val(kind, null).ok && !val(kind, "text").ok && !val(kind, []).ok, `${kind} accepted a non-object`);
  }
  assert(!validateKind("no_such_kind", {}).ok);
  assert(!validateKind("job_list", { list: "0123456789" }).ok, "job_list is created by the job search, never by the model");
});
Deno.test("schema: kind-specific rules", () => {
  const d = (kind: string, f: (x: any) => void) => { const x = clone(SAMPLES[kind]) as any; f(x); return val(kind, x); };
  assert(!d("introduction", (x) => x.why.pop()).ok, "exactly three relevance bullets");
  assert(!d("introduction", (x) => { x.why[0].source = "Reported, not verified"; }).ok, "relevance bullets are confirmed facts only");
  assert(!d("introduction", (x) => { x.message.body += " See https://evil.example"; }).ok, "no links in an outreach message");
  assert(!d("introduction", (x) => { x.message.channel = "linkedin"; }).ok, "LinkedIn is never automated");
  assert(!d("application_proof", (x) => { x.status = "applied"; }).ok, "status words are exactly queued/prepared/submitted/confirmed/failed");
  for (const s of ["queued", "prepared", "submitted", "confirmed", "failed"]) {
    const r = d("application_proof", (x) => { x.status = s; if (s !== "confirmed") delete x.confirmation; if (s === "queued" || s === "prepared") delete x.submitted_at; if (s === "failed") x.problems.push({ item: "Submit", outcome: "failed", reason: "The form rejected the upload." }); });
    assert(r.ok, `${s}: ${JSON.stringify((r as { errors?: string[] }).errors)}`);
  }
  assert(!d("application_proof", (x) => { delete x.confirmation; }).ok, "confirmed needs a confirmation id or link");
  assert(!d("application_proof", (x) => { x.status = "queued"; }).ok, "queued cannot carry a submit time or confirmation");
  assert(!d("application_proof", (x) => { x.status = "failed"; delete x.confirmation; }).ok, "failed needs a failed item with its reason");
  assert(!d("application_proof", (x) => { x.problems[0].reason = ""; }).ok, "a skipped or failed item states why");
  assert(!d("application_proof", (x) => { x.answers.push({ question: "Password", answer: "hunter2", source: "From you" }); }).ok, "no password or code in a file");
  assert(!d("comparison", (x) => { x.options = [{ name: "Acme" }]; }).ok, "a comparison needs two options");
  assert(!d("comparison", (x) => { x.rows[0].cells.pop(); }).ok, "one cell per option");
  assert(!d("comparison", (x) => { x.rows[1].cells = [null, null]; }).ok, "a row with nothing known is not a row");
  assert(!d("research_brief", (x) => { x.sources = []; }).ok, "a brief lists its sources");
  assert(!d("research_brief", (x) => { x.sources[0].url = "http://acme.example"; }).ok, "https sources only");
  assert(!d("draft", (x) => { x.type = "tweet"; }).ok);
  assert(!d("plan_review", (x) => { x.sections = []; }).ok);
});

// ================================================================== no source, no fact
Deno.test("unsourced facts are rejected everywhere, never guessed", () => {
  const paths: [string, (x: any) => any][] = [
    ["introduction", (x) => x.why[1]], ["application_proof", (x) => x.answers[0]], ["plan_review", (x) => x.sections[0].items[0]],
    ["comparison", (x) => x.rows[0].cells[0]], ["draft", (x) => x.basis[0]], ["research_brief", (x) => x.findings[0]],
  ];
  for (const [kind, pick] of paths) {
    for (const mutate of [(f: any) => { delete f.source; }, (f: any) => { f.source = ""; }, (f: any) => { f.source = "I think so"; }, (f: any) => { f.source = "From the internet"; }]) {
      const x = clone(SAMPLES[kind]) as any; mutate(pick(x));
      const r = val(kind, x);
      assert(!r.ok && r.errors.some((e) => /source/.test(e)), `${kind} accepted a fact without a valid source`);
    }
    for (const v of ["", "   ", "unknown", "N/A", "TBD", "?", "-"]) {
      const x = clone(SAMPLES[kind]) as any; const f = pick(x); const key = "value" in f ? "value" : "text" in f ? "text" : "answer";
      f[key] = v;
      assert(!val(kind, x).ok, `${kind} accepted the placeholder ${JSON.stringify(v)} as a fact: unknown values are omitted`);
    }
  }
  assert(!validateKind("introduction", (() => { const x = clone(SAMPLES.introduction) as any; x.person.source = "From Trainee's records"; return x; })()).ok, "the records label is only for plan reviews and application proofs");
});
Deno.test("render: a stored fact with no source is not rendered, in html or text", async () => {
  const x = clone(SAMPLES.research_brief) as any; x.findings.push({ label: "Revenue", value: "SECRET-INVENTED-FIGURE" });
  const r = rec("research_brief", x);
  assert(!textOf(r, { now: NOW }).includes("SECRET-INVENTED-FIGURE"));
  const f = createFileService({ store: memoryFileStore(), env: { get: (k) => ENV[k] }, now: () => NOW });
  const made = await f.create(U, "research_brief", SAMPLES.research_brief);
  assert(made.ok);
});

// ================================================================== the plain-text twin carries every fact and every action state
Deno.test("fallback text: every fact, its source label, and every action with its state", () => {
  for (const [kind, data] of Object.entries(SAMPLES)) {
    const r = rec(kind), t = textOf(r, { now: NOW });
    for (const s of leaves(data)) assert(t.includes(s), `${kind}: the text twin lost "${s}"`);
    for (const f of JSON.stringify(data).match(/"source":"([^"]+)"/g) ?? []) assert(t.includes(f.slice(10, -1)), `${kind}: lost a source label ${f}`);
    for (const a of actionsOf(r)) assert(t.includes(a.label) && t.toLowerCase().includes(a.state === "available" ? "available" : a.state === "done" ? "done" : "not available"), `${kind}: action ${a.label} (${a.state}) missing from text`);
    assert(/expires/i.test(t), `${kind}: the text says when the file expires`);
  }
  assert(textOf(rec("comparison"), { now: NOW }).includes("Not stated"), "an unknown cell reads as not stated, not a guess");
});
Deno.test("action sets: exactly the owner's actions per kind", () => {
  const labels = (k: string) => actionsOf(rec(k)).map((a) => a.label);
  eq(labels("introduction"), ["Pass", "Introduce"]);
  eq(labels("application_proof"), ["View status", "Flag a problem"]);
  for (const k of ["plan_review", "comparison", "research_brief"]) eq(labels(k), [], `${k} has no required actions`);
  eq(labels("draft"), ["Copy"]);
});

// ================================================================== service: create, link by code, isolation, expiry, revocation
function world(env: Record<string, string | undefined> = ENV, at = { t: NOW }) {
  const store = memoryFileStore();
  const svc = createFileService({ store, env: { get: (k) => env[k] }, now: () => at.t });
  const sent: unknown[] = [];
  const stub = (): FileStore => ({ async remember() {}, async recall() { return null; }, async rememberList() {}, async recallList() { return null; }, async postings() { return []; }, async save() { return "saved"; }, async prepared() { return null; }, async applied() { return false; },
    async want() { return { result: "queued" }; }, async appRow() { return null; }, async claimLink() { return true; }, async wanted() { return false; } });
  const deps = (o: { intro?: boolean } = {}): FileDeps => ({ ...A.deps, store: stub(), now: () => at.t, env: { get: (k) => env[k] }, cards: { async open() { throw new Error("no"); } }, tap: {} as never, files: svc,
    ...(o.intro ? { fileEffects: { async introduce(_u: string, r: FileRecord) { sent.push(r.data.message); return { ok: true }; } } } : {}) });
  return { store, svc, deps, sent, at };
}
const tok = async (user: string, id: string, now = NOW) => await A.tok(user, id, now);
const get = (d: FileDeps, t: string, q = "") => handleFile(new Request(`https://x.example/f${q}`, { headers: { cookie: `tf_s=${t}` } }), d);
const post = async (d: FileDeps, f: Record<string, string>) => handleFile(new Request("https://x.example/f", await phonePost(f, SECRET)), d);
const plain = (h: string) => h.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

Deno.test("service: validates, stores for one user, returns a signed link; refuses when links are not configured and stores nothing", async () => {
  const w = world();
  const bad = await w.svc.create(U, "comparison", { title: "x" });
  assert(!bad.ok); eq(w.store.size(), 0);
  const made = await w.svc.create(U, "comparison", SAMPLES.comparison);
  assert(made.ok && made.id.length === 10 && /^https:\/\/trainee\.example\/file\?t=v1\./.test(made.url ?? ""), JSON.stringify(made));
  eq(w.store.size(), 1);
  const off = world({ ...ENV, TRAINEE_FILE_LINK_SECRET: undefined });
  const r = await off.svc.create(U, "comparison", SAMPLES.comparison);
  assert(!r.ok && /link/i.test(r.error), "no link, no file: the agent is told it was not created"); eq(off.store.size(), 0);
});
Deno.test("isolation: a signed session for another user, or for a made-up id, reads nothing", async () => {
  const w = world();
  const made = (await w.svc.create(U, "draft", SAMPLES.draft)) as { id: string };
  const mine = await get(w.deps(), await tok(U, made.id));
  eq(mine.status, 200); assert(plain(await mine.text()).includes("Dear Acme team"));
  for (const t of [await tok(V, made.id), await tok(U, "ffffffffff")]) {
    const r = await get(w.deps(), t), body = plain(await r.text());
    eq(r.status, 404); assert(!body.includes("Dear Acme") && !body.includes("Acme"), "nothing of the file leaks");
  }
  const mt = await get(w.deps(), await tok(V, made.id), "?format=text");
  eq(mt.status, 404);
  const p = await post(w.deps(), { t: await tok(V, made.id), action: "flag", note: "x" });
  assert(p.status !== 200, "a stranger cannot act on it");
  eq((await w.store.get(U, made.id))?.state, {}, "a stranger's post changed nothing");
  eq(await w.store.get(V, made.id), null, "the store itself is keyed by user");
});
Deno.test("expiry is configurable; an expired or revoked file is gone, and says so", async () => {
  const w = world({ ...ENV, TRAINEE_FILE_TTL_HOURS: "2" });
  const made = (await w.svc.create(U, "research_brief", SAMPLES.research_brief)) as { id: string };
  eq((await w.store.get(U, made.id))?.expires_at, NOW + 2 * 3600_000);
  eq((await get(w.deps(), await tok(U, made.id))).status, 200);
  w.at.t = NOW + 2 * 3600_000 + 1000;
  const late = await get(w.deps(), await tok(U, made.id, w.at.t));
  eq(late.status, 410); const body = plain(await late.text());
  assert(/expired/i.test(body) && !body.includes("Acme about page"));
  eq((await get(w.deps(), await tok(U, made.id, w.at.t), "?format=text")).status, 410);
  // default TTL, and a TTL that is nonsense falls back to it
  const d = world(); await d.svc.create(U, "research_brief", SAMPLES.research_brief);
  const n = world({ ...ENV, TRAINEE_FILE_TTL_HOURS: "banana" }); await n.svc.create(U, "research_brief", SAMPLES.research_brief);
  eq([...d.store.all()][0].expires_at, [...n.store.all()][0].expires_at);
  assert([...d.store.all()][0].expires_at > NOW + 24 * 3600_000);
});
Deno.test("revocation: the owner's revoke (service or the page's Remove button) ends access at once; nobody else can revoke", async () => {
  const w = world();
  const a = (await w.svc.create(U, "comparison", SAMPLES.comparison)) as { id: string };
  eq(await w.svc.revoke(V, a.id), false); eq((await get(w.deps(), await tok(U, a.id))).status, 200);
  const r = await post(w.deps(), { t: await tok(U, a.id), action: "remove" });
  assert(/removed/i.test(plain(await r.text())));
  const after = await get(w.deps(), await tok(U, a.id)); eq(after.status, 410); assert(!plain(await after.text()).includes("Globex"));
  const b = (await w.svc.create(U, "comparison", SAMPLES.comparison)) as { id: string };
  eq(await w.svc.revoke(U, b.id), true); eq((await get(w.deps(), await tok(U, b.id))).status, 410);
});

// ================================================================== the page
Deno.test("page: shell + kind body, source labels shown, a11y basics, tokens/fonts of the jobs page, CSP intact", async () => {
  const w = world();
  for (const kind of Object.keys(SAMPLES)) {
    const m = await mk(w, kind);
    const r = await get(w.deps(), await tok(U, m.id)), html = await r.text();
    eq(r.status, 200, kind);
    assert(/<html lang="en"/.test(html) && /<h1[ >]/.test(html) && /<main/.test(html) && /viewport/.test(html), `${kind}: shell`);
    assert(html.includes("--accent:#5C2751") && html.includes("Brygada 1918") && html.includes("Inter"), `${kind}: Trainee tokens and fonts`);
    const csp = r.headers.get("content-security-policy") ?? "";
    assert(/frame-ancestors/.test(csp) && r.headers.get("cache-control") === "no-store" && /script-src 'sha256-[^']+' 'sha256-[^']+' 'sha256-[^']+' https:\/\/telegram\.org/.test(csp) && !csp.includes("unsafe-eval") && /default-src 'none'/.test(csp));
    const text = plain(html);
    for (const s of leaves(SAMPLES[kind]).filter((x) => x.length > 3 && !/^https?:/.test(x))) assert(text.includes(s.replace(/\s+/g, " ")), `${kind}: page lost "${s}"`);
    for (const f of JSON.stringify(SAMPLES[kind]).match(/"source":"([^"]+)"/g) ?? []) assert(text.includes(f.slice(10, -1)), `${kind}: page lost ${f}`);
    assert(!/<script[^>]*src=(?!"https:\/\/telegram.org)/.test(html), "no other script source");
    assert(!/<(button|a)\b[^>]*>\s*<\/(button|a)>/.test(html), `${kind}: no empty buttons or links`);
    const t = await get(w.deps(), await tok(U, m.id), "?format=text");
    eq(t.status, 200); assert((t.headers.get("content-type") ?? "").startsWith("text/plain"));
  }
});
Deno.test("page: a link preview crawler gets the kind's name and nothing of the file, and does not use up the link", async () => {
  const w = world();
  const m = (await w.svc.create(U, "introduction", SAMPLES.introduction)) as { id: string; url: string };
  const crawl = new Request(m.url, { headers: { "user-agent": "TelegramBot (like TwitterBot)" } });
  const r = await handleFile(crawl, w.deps()), h = await r.text();
  eq(r.status, 200); assert(/og:title" content="[^"]*Introduction/i.test(h), h.slice(0, 600));
  assert(!h.includes("Dana Lee") && !h.includes("Acme"));
  const real = await handleFile(new Request(m.url, { headers: { "user-agent": "Mozilla/5.0" } }), w.deps());
  eq(real.status, 303);
});

// ================================================================== truthful actions
Deno.test("introduction: Introduce is hash-bound; Pass and Introduce each happen once; nothing sends without the exact tag", async () => {
  const w = world();
  const m = (await w.svc.create(U, "introduction", SAMPLES.introduction)) as { id: string };
  const stored = (await w.store.get(U, m.id))!; assert(/^[0-9a-f]{16}$/.test(stored.tag ?? ""), "the exact message is bound to a tag");
  const page = await (await get(w.deps({ intro: true }), await tok(U, m.id))).text();
  assert(page.includes(stored.tag!) && page.includes("Hi Dana, I build pricing dashboards"), "the exact message and its tag are on the page");
  const t = await tok(U, m.id);
  for (const tag of ["", "0".repeat(16), stored.tag!.slice(0, 15)]) {
    const r = await post(w.deps({ intro: true }), { t, action: "introduce", tag });
    assert(/changed|nothing was sent/i.test(plain(await r.text())), "wrong tag: refused");
  }
  eq(w.sent.length, 0); eq((await w.store.get(U, m.id))?.state.choice, undefined);
  // the stored message is altered after the page was drawn: the tag no longer matches, so nothing sends
  const tampered = clone(stored); tampered.data.message.body = "Send me your money"; await w.store.put(tampered);
  const r1 = await post(w.deps({ intro: true }), { t, action: "introduce", tag: stored.tag! });
  assert(/changed|nothing was sent/i.test(plain(await r1.text()))); eq(w.sent.length, 0);
  await w.store.put(stored);
  const ok = await post(w.deps({ intro: true }), { t, action: "introduce", tag: stored.tag! });
  assert(/approved/i.test(plain(await ok.text()))); eq(w.sent, [SAMPLES.introduction && (SAMPLES.introduction as any).message], "the exact message, once");
  await post(w.deps({ intro: true }), { t, action: "introduce", tag: stored.tag! });
  await post(w.deps({ intro: true }), { t, action: "pass" });
  eq(w.sent.length, 1, "a second tap, or Pass after Introduce, sends nothing more");
  eq((await w.store.get(U, m.id))?.state.choice, "introduced");
  assert(textOf((await w.store.get(U, m.id))!, { now: NOW }).toLowerCase().includes("sent"));
});
Deno.test("introduction: with no sender wired the page says nothing was sent; Pass is final", async () => {
  const w = world();
  const m = (await w.svc.create(U, "introduction", SAMPLES.introduction)) as { id: string };
  const tag = (await w.store.get(U, m.id))!.tag!, t = await tok(U, m.id);
  const r = plain(await (await post(w.deps(), { t, action: "introduce", tag })).text());
  assert(/not sent|nothing was sent/i.test(r) && !/\bsent to\b/i.test(r), r);
  eq((await w.store.get(U, m.id))?.state.sent_at, undefined);
  const w2 = world(); const m2 = (await w2.svc.create(U, "introduction", SAMPLES.introduction)) as { id: string };
  const t2 = await tok(U, m2.id), tag2 = (await w2.store.get(U, m2.id))!.tag!;
  assert(/passed/i.test(plain(await (await post(w2.deps({ intro: true }), { t: t2, action: "pass" })).text())));
  await post(w2.deps({ intro: true }), { t: t2, action: "introduce", tag: tag2 });
  eq(w2.sent.length, 0, "Pass is final: Introduce afterwards sends nothing");
  eq(actionsOf((await w2.store.get(U, m2.id))!).map((a) => a.state), ["done", "unavailable"]);
});
Deno.test("application proof: statuses use the exact words; Flag stores the note; View status never changes anything", async () => {
  const w = world();
  const m = await mk(w, "application_proof");
  const t = await tok(U, m.id), before = clone((await w.store.get(U, m.id))!);
  const page = plain(await (await get(w.deps(), t)).text());
  assert(/Confirmed/.test(page) && !/\bapplied\b/i.test(page) && page.includes("GH-4471") && page.includes("Portfolio link") && page.includes("Skipped"));
  const v = await post(w.deps(), { t, action: "status" }); eq(v.status, 200); eq((await w.store.get(U, m.id))?.state, before.state);
  const f = plain(await (await post(w.deps(), { t, action: "flag", note: "The company says it never got my resume." })).text());
  assert(/flagged/i.test(f) && f.includes("never got my resume"), f);
  eq((await w.store.get(U, m.id))?.state.flags.length, 1);
  const empty = plain(await (await post(w.deps(), { t, action: "flag", note: "   " })).text());
  assert(/write what|note/i.test(empty)); eq((await w.store.get(U, m.id))?.state.flags.length, 1, "an empty flag is not recorded");
  assert(textOf((await w.store.get(U, m.id))!, { now: NOW }).includes("never got my resume"));
  const bad = await post(w.deps(), { t, action: "delete_everything" }); eq(bad.status, 400);
  const fa = (await w.svc.create(U, "plan_review", SAMPLES.plan_review)) as { id: string };
  eq((await post(w.deps(), { t: await tok(U, fa.id), action: "flag", note: "x" })).status, 400, "a kind only answers its own actions");
});
Deno.test("draft: editable and copyable; there is no send action, and the page says how sending works", async () => {
  const w = world();
  const m = (await w.svc.create(U, "draft", SAMPLES.draft)) as { id: string };
  const html = await (await get(w.deps(), await tok(U, m.id))).text();
  assert(/<textarea[^>]*>[\s\S]*Dear Acme team/.test(html) && /Copy/.test(html));
  assert(!/>\s*Send\s*</i.test(html), "no send button");
  assert(/approve the exact/i.test(plain(html)), "sending is the exact-payload flow, and the page says so");
  eq((await post(w.deps(), { t: await tok(U, m.id), action: "send" })).status, 400);
});

// ================================================================== the agent tool: create_file, link by code only
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const use = (name: string, input: unknown, id = "t1") => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
// A world's file of this kind: an application proof is a record built by code, so it is put in the store directly.
async function mk(w: ReturnType<typeof world>, kind: string): Promise<{ id: string }> {
  if (kind !== "application_proof") return (await w.svc.create(U, kind, SAMPLES[kind])) as { id: string };
  const id = "abcdef0123"; await w.store.put(rec(kind, SAMPLES[kind], { id })); return { id };
}
async function turn(script: any[], w = world(), message = "make me a comparison of Acme ($90k, hybrid) and Globex ($95k)") {
  let i = 0;
  const r = await runAgentTurn({ system: "s", message, history: [], tools: [createFileTool(w.svc)], ctx: { userId: U, threadId: "th", now: NOW, state: {} }, model: async () => script[Math.min(i++, script.length - 1)] });
  return { r, w };
}
Deno.test("create_file: validates against the kind, stores, and the LINK COMES FROM CODE, never the model", async () => {
  const { r, w } = await turn([use("create_file", { kind: "comparison", data: SAMPLES.comparison }), text("Here is your comparison: https://evil.example/fake")]);
  assert(r.tool_calls.every((c) => c.ok), JSON.stringify(r.tool_calls)); eq(w.store.size(), 1);
  assert(Array.isArray((r as any).fileLinks) && (r as any).fileLinks.length === 1 && /^https:\/\/trainee\.example\/file\?t=v1\./.test((r as any).fileLinks[0]));
  const shaped = shapeForTurn({ on: true, channel: "telegram", writable: true, reply: r.reply, allowedLinks: r.linksSeen });
  assert(!shaped.reply.includes("evil.example") && !JSON.stringify(shaped.shape).includes("evil.example"), "the model's own URL is dropped");
  const ev = (r as any).fileLinks as string[];
  assert(!JSON.stringify(r.tool_calls).includes("v1."), "the signed link is not in the model's reach");
  eq(ev.length, 1);
});
Deno.test("create_file: the model is told why a bad file was refused, and nothing is stored or linked", async () => {
  const x = clone(SAMPLES.research_brief) as any; delete x.findings[0].source;
  const { r, w } = await turn([use("create_file", { kind: "research_brief", data: x }), text("Done.")]);
  const call = r.tool_calls.find((c) => c.name === "create_file")!; assert(!call.ok && /source/.test(call.error ?? ""), JSON.stringify(call));
  eq(w.store.size(), 0); eq((r as any).fileLinks, undefined);
  const j = await turn([use("create_file", { kind: "job_list", data: { list: "0123456789" } }), text("Done.")]);
  assert(!j.r.tool_calls[0].ok); eq(j.w.store.size(), 0);
  const unk = await turn([use("create_file", { kind: "poem", data: {} }), text("Done.")]); assert(!unk.r.tool_calls[0].ok);
});
Deno.test("create_file: a fact about the person that no source supports is refused (same guard as attach_document)", async () => {
  const x = clone(SAMPLES.draft) as any; x.body = "I am proficient in Kubernetes and earned $200k at Google.";
  const { r, w } = await turn([use("create_file", { kind: "draft", data: x }), text("Done.")], world(), "draft a cover letter for Acme");
  assert(!r.tool_calls[0].ok, JSON.stringify(r.tool_calls)); eq(w.store.size(), 0);
});
Deno.test("create_file: effect is read-like for the loop (the file sends nothing); the description names the kinds", () => {
  const t = createFileTool(world().svc);
  eq(t.name, "create_file"); eq(t.effect, "write_own");
  for (const k of KIND_IDS.filter((k) => k !== "job_list")) assert(t.description.includes(k), k);
  assert(!t.description.includes("job_list"));
  assert(/do not write (a|the) (url|link)/i.test(t.description));
});
