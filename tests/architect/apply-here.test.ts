// "Apply here" intake and no-download delivery (owner, 2026-10-29): the person texts a posting link (or "apply to this"); ONE short line
// and ONE Apply button follow; several links become one list link; nothing is attached by default. Memory stores and fake transports:
// no network, no model, no database.
import assertNode from "node:assert/strict";
import { applyHereAsk, applyHereTurn } from "../../supabase/functions/_shared/apply_here.ts";
import { memoryPostingsDb, type FetchFeed, type Posting } from "../../supabase/functions/_shared/career_ingest.ts";
import { hashTag, parseJobTap, refOf, sendJobCards, tapJob, type JobDeps, type JobStore, type PreparedRow } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { attachAsked, attachTool } from "../../supabase/functions/_shared/agent/attach_tool.ts";
import { NO_ATTACH_RULE, SHAPE_RULES, shapeRulesFor } from "../../supabase/functions/_shared/agent/prompt.ts";
import { briefPublisherFor, deliverResearch, researchParts, withBriefLink, type ResearchReply } from "../../supabase/functions/_shared/research_reply.ts";
import { statusLine } from "../../supabase/functions/_shared/career_apply_status.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const U = "11111111-1111-4111-8111-111111111111", NOW = Date.parse("2026-10-29T12:00:00Z"), H = "ab".repeat(32), H2 = "cd".repeat(32);
const CARD = "44444444-4444-4444-8444-444444444444";
const gh = (n: number) => `https://boards.greenhouse.io/acme/jobs/${n}`;

function posting(n: number, extra: Partial<Posting> = {}): Posting {
  return { job_id: `greenhouse:acme:${n}`, company: "Acme", title: `Data Analyst ${n}`, location: "Austin, TX", url: gh(n), description: "Build dashboards with SQL.", provider: "greenhouse", board: "acme",
    first_seen_at: "2026-10-27T12:00:00Z", last_seen_at: "2026-10-28T12:00:00Z", closed_at: null, posted_at: "2026-10-26T12:00:00Z", ...extra } as Posting;
}
async function world(ns: number[], extra: Partial<Posting> = {}) {
  const db = memoryPostingsDb(), fetched: string[] = [];
  for (const n of ns) await db.put(posting(n, extra));
  const fetchFeed: FetchFeed = async (b) => { fetched.push(b.board); return []; };
  const run = (message: string, o: { last?: { url?: string } | null; facts?: any[] } = {}) =>
    applyHereTurn({ message, now: NOW, db, fetchFeed, apps: async () => [], facts: o.facts ?? [], last: o.last ?? null });
  return { db, fetched, run };
}
function memStore(init: { prepared?: PreparedRow | null } = {}) {
  const mem = new Map<string, any>(), log = { wants: [] as string[] };
  let prepared = init.prepared ?? null;
  const store: JobStore = {
    async remember(u, ref, job, s) { mem.set(`${u}|job|${ref}`, { job, shownAs: s }); }, async recall(u, ref) { return mem.get(`${u}|job|${ref}`) ?? null; },
    async rememberList(u, id, refs) { mem.set(`${u}|list|${id}`, refs); }, async recallList(u, id) { return mem.get(`${u}|list|${id}`) ?? null; },
    async postings(ids) { return ids.map((id) => ({ job_id: id, provider: "greenhouse", description: "Build dashboards with SQL.", first_seen_at: "2026-10-27T12:00:00Z", posted_at: "2026-10-26T12:00:00Z" })); },
    async save() { return "saved"; }, async prepared() { return prepared; }, async applied() { return false; },
    async want(_u, job) { log.wants.push(job.job_id); return { result: "queued" }; },
  };
  return { store, log, mem, setPrepared: (p: PreparedRow | null) => { prepared = p; } };
}
const prep = (hash = H): PreparedRow => ({ id: "33333333-3333-4333-8333-333333333333", job_id: "greenhouse:acme:1", company: "Acme", url: gh(1), payload_hash: hash, state: "ready", card_lines: [],
  payload: { resume_sha256: "f".repeat(64), resume_name: "ada-resume.pdf", fields: [{ name: "first_name", label: "First name", value: "Ada" }, { name: "cover", label: "Cover note", value: "I built the pricing model." }] } });
function deps(m: ReturnType<typeof memStore>, o: { links?: boolean; hash?: () => string } = {}): JobDeps {
  const hash = o.hash ?? (() => H);
  return { store: m.store, now: () => NOW, env: { get: () => undefined },
    cards: { async open(_u, ids) { return { id: CARD, items: [{ n: 1, prepared_id: ids[0], payload_hash: hash() }], shown_at: new Date(NOW).toISOString() } as any; } },
    tap: { async card(_u, id) { return { id, items: [{ n: 1, prepared_id: prep().id, payload_hash: hash() }], state: "open", user_id: U } as any; }, async prepared() { return [{ id: prep().id, payload_hash: hash(), company: "Acme" }]; },
      async answer(_u, _c, approve) { return approve.length ? [{ n: 1, company: "Acme", result: "queued" }] : []; } },
    ...(o.links === false ? {} : { feedLinks: async () => ({ webApp: "https://trainee.example/file?list=0123456789", url: "https://trainee.example/file?t=v1.x.y" }) }) } as JobDeps;
}
const sender = () => { const sent: { text: string; buttons?: any[][] }[] = []; return { sent, send: { photo: async () => ({ ok: true }), text: async (a: any) => { sent.push(a); return { ok: true, id: String(sent.length) }; } } }; };
const buttonsOf = (sent: { buttons?: any[][] }[]) => sent.flatMap((s) => (s.buttons ?? []).flat());

// ------------------------------------------------------------------ (2) intake: one link -> one line, one button
Deno.test("one posting link: ONE short line and ONE Apply button; the index is read first, no fetch", async () => {
  const w = await world([1]);
  const r = (await w.run(`apply here ${gh(1)}`))!;
  eq(r.status, "ready");
  eq(r.hits.length, 1);
  assert(!r.reply.includes("\n") && r.reply.length < 160, r.reply);
  assert(/tap Apply/i.test(r.reply));
  eq(w.fetched, [], "on file: no fetch");
  const m = memStore(), t = sender();
  await sendJobCards({ userId: U, hits: r.hits, deps: deps(m), send: t.send });
  eq(t.sent.length, 1);
  const b = buttonsOf(t.sent);
  eq(b.length, 1);
  eq(b[0].text, "Apply");
});

Deno.test("a bare pasted link, and 'apply to this' about the one posting just shown, are asks; a question, the past and a negation are not", async () => {
  const w = await world([1]);
  eq((await w.run(gh(1)))?.hits.length, 1, "a bare link");
  eq((await w.run("apply to this", { last: { url: gh(1) } }))?.hits.length, 1, "this = the last shown");
  eq(await w.run("apply to this"), null, "nothing shown: not this turn's");
  eq(await w.run(`how do I apply to ${gh(1)}?`), null);
  eq(await w.run(`I applied to ${gh(1)} yesterday`), null);
  eq(await w.run(`don't apply to ${gh(1)}`), null);
  eq(await w.run("what's the weather"), null);
});

Deno.test("not on file: the one permitted fetch of the employer's own board; nothing else is read", async () => {
  const db = memoryPostingsDb(), fetched: string[] = [];
  const fetchFeed: FetchFeed = async (b) => { fetched.push(`${b.provider}:${b.board}`); return [{ job_id: "greenhouse:acme:7", ats_id: "7", company: "Acme", title: "Analyst", url: gh(7), location: "Austin, TX", description: "SQL work." }]; };
  const r = await applyHereTurn({ message: `apply here ${gh(7)}`, now: NOW, db, fetchFeed, apps: async () => [], facts: [] });
  eq(r?.hits.length, 1);
  eq(fetched, ["greenhouse:acme"]);
  eq((await db.get("greenhouse:acme:7"))?.title, "Analyst", "stored as the ingest stores it");
});

Deno.test("blocked hosts are refused by name and never opened: LinkedIn, Indeed, Handshake on any suffix", async () => {
  const w = await world([1]);
  for (const u of ["https://www.linkedin.com/jobs/view/123", "https://uk.indeed.com/viewjob?jk=1", "https://app.joinhandshake.com/jobs/1"]) {
    const r = (await w.run(`apply here ${u}`))!;
    eq(r.hits, [], u);
    assert(/LinkedIn, Indeed or Handshake/.test(r.reply) && /yourself/.test(r.reply), r.reply);
  }
  eq(w.fetched, [], "no fetch for a blocked host");
  eq(applyHereAsk(`apply ${gh(1)} https://www.linkedin.com/jobs/1`, null)?.blocked.length, 1);
  eq((await w.run(`apply to ${gh(1)} and https://www.indeed.com/viewjob?jk=2`))?.hits.length, 1, "the allowed one proceeds, the blocked one is named");
  const two = (await w.run(`apply here ${gh(1)} https://www.indeed.com/viewjob?jk=2`))!;
  eq(two.hits.length, 1);
  assert(/Skipped 1/.test(two.reply) && /indeed/.test(two.reply), two.reply);
});

Deno.test("another site is said plainly, not guessed; a closed or stale posting holds with its reason; an unknown fact proceeds 'not checked'", async () => {
  const w = await world([1, 2], {});
  const other = (await w.run("apply here https://careers.example.com/jobs/9"))!;
  eq(other.hits, []);
  assert(/Greenhouse, Lever and Ashby/.test(other.reply), other.reply);
  const c = await world([3], { closed_at: "2026-10-28T00:00:00Z" });
  const closed = (await c.run(`apply here ${gh(3)}`))!;
  eq(closed.hits, []);
  assert(/closed/i.test(closed.reply), closed.reply);
  const s = await world([4], { posted_at: "2025-01-01T00:00:00Z", first_seen_at: "2025-01-01T00:00:00Z" });
  const stale = (await s.run(`apply here ${gh(4)}`))!;
  eq(stale.hits, [], "stale holds");
  const open = (await w.run(`apply here ${gh(1)}`))!;
  eq(open.hits.length, 1, "no facts known: it proceeds");
});

Deno.test("three links: ONE list link, no per-posting buttons; the list is the exact set (the page binds Apply to all N to it)", async () => {
  const w = await world([1, 2, 3]);
  const r = (await w.run(`apply here ${gh(1)} ${gh(2)} ${gh(3)}`))!;
  eq(r.hits.length, 3);
  assert(!r.reply.includes("\n") && /3 postings/.test(r.reply), r.reply);
  const m = memStore(), t = sender();
  const out = await sendJobCards({ userId: U, hits: r.hits, deps: deps(m), send: t.send });
  eq([out.sent, out.total], [1, 3]);
  eq(t.sent.length, 1);
  assert(/https:\/\/trainee\.example\/file\?t=v1\./.test(t.sent[0].text) && /Apply to all 3/.test(t.sent[0].text), t.sent[0].text);
  eq(buttonsOf(t.sent).map((b) => b.text), ["Open the list"], "one link button, not an Apply per posting in chat");
  const lists = [...m.mem.entries()].filter(([k]) => k.includes("|list|"));
  eq(lists.length, 1);
  eq(lists[0][1], await Promise.all([1, 2, 3].map((n) => refOf(U, `greenhouse:acme:${n}`))), "the list holds exactly the three postings, in order");
  // The page's Apply on each row and its hash-bound 'Apply to all' are covered by file-page.test.ts (#275); with no link configured each posting gets its own one-button message.
  const t2 = sender();
  await sendJobCards({ userId: U, hits: r.hits, deps: deps(m, { links: false }), send: t2.send });
  eq(buttonsOf(t2.sent).map((b) => b.text), ["Apply", "Apply", "Apply"]);
});

Deno.test("prepared payload: the summary is shown and the ONE Apply button is the hash-bound approval; unprepared: it queues", async () => {
  const w = await world([1]);
  const r = (await w.run(`apply here ${gh(1)}`))!;
  const m = memStore({ prepared: prep() }), t = sender();
  await sendJobCards({ userId: U, hits: r.hits, deps: deps(m), send: t.send });
  assert(/Ada/.test(t.sent[0].text) && /ada-resume\.pdf/.test(t.sent[0].text) && /Cover note: I built the pricing model/.test(t.sent[0].text), t.sent[0].text);
  assert(!/Confirm/.test(t.sent.map((s) => s.text).join("\n")), "no confirm step");
  const tap = parseJobTap(buttonsOf(t.sent)[0].data)!;
  eq(tap.op, "confirm");
  eq((tap as any).tag, hashTag(H));
  const m2 = memStore(), t2 = sender();
  await sendJobCards({ userId: U, hits: r.hits, deps: deps(m2), send: t2.send });
  eq(parseJobTap(buttonsOf(t2.sent)[0].data)?.op, "apply");
  assert(/Not prepared yet/.test(t2.sent[0].text));
});

Deno.test("a tap on a changed payload is refused and approves nothing; the unchanged one is approved exactly", async () => {
  const w = await world([1]);
  const r = (await w.run(`apply here ${gh(1)}`))!;
  const m = memStore({ prepared: prep() }), t = sender();
  const d = deps(m);
  await sendJobCards({ userId: U, hits: r.hits, deps: d, send: t.send });
  const data = buttonsOf(t.sent)[0].data;
  m.setPrepared(prep(H2)); // the application changed after it was shown
  const t2 = sender();
  const stale = await tapJob({ userId: U, data, messageId: "1", deps: d, send: t2.send });
  eq(stale.status, "changed");
  assert(/nothing was approved/i.test(t2.sent.map((s) => s.text).join(" ")));
  m.setPrepared(prep());
  const t3 = sender();
  const ok = await tapJob({ userId: U, data, messageId: "1", deps: d, send: t3.send });
  eq(ok.status, "confirmed");
});

// ------------------------------------------------------------------ (3) honest states
Deno.test("honest states: unprepared tap says Queued (never 'applied'); every state's wording claims no submit before a real one", async () => {
  const w = await world([1]);
  const r = (await w.run(`apply here ${gh(1)}`))!;
  const m = memStore(), t = sender(), d = deps(m);
  await sendJobCards({ userId: U, hits: r.hits, deps: d, send: t.send });
  const t2 = sender();
  const q = await tapJob({ userId: U, data: buttonsOf(t.sent)[0].data, messageId: "1", deps: d, send: t2.send });
  eq(q.status, "queued_unprepared");
  eq(m.log.wants, ["greenhouse:acme:1"]);
  const said = t2.sent.map((s) => s.text).join(" ");
  assert(/^Queued/.test(said) && !/\bapplied\b/i.test(said) && /nothing has gone to the employer/i.test(said), said);
  const row = (state: string, extra: any = {}) => ({ id: "1", company: "Acme", state, created_at: "2026-10-29T10:00:00Z", updated_at: "2026-10-29T11:00:00Z", ...extra });
  for (const s of ["queued", "driving", "needs_user"]) assert(/not (sent|submitted) yet|stopped before it was sent/.test(statusLine(row(s) as any)) && !/\bapplied\b/i.test(statusLine(row(s) as any)), s);
  assert(/not confirmed it yet/.test(statusLine(row("submitted_unconfirmed") as any)));
  assert(/confirmed it/.test(statusLine(row("confirmed", { confirmation_id: "C1" }) as any)));
  assert(/^Acme: not sent/.test(statusLine(row("failed", { reason: "timeout" }) as any)));
});

// ------------------------------------------------------------------ (1) delivery: no attachment by default
Deno.test("no attachment by default: attach_document only when the person asks for a file; the default rule points to a hosted page", () => {
  for (const m of ["research Acme for me", "compare these two offers", "what do you know about the role at Stripe", "apply here " + gh(1)]) assert(!attachAsked(m), m);
  for (const m of ["send me a file", "can you attach it as a .md", "give me a PDF of that", "email me the document"]) assert(attachAsked(m), m);
  const off = shapeRulesFor(false);
  assert(!/attach_document/.test(off) && /research_brief/.test(off) && /never attach a file/.test(off) && off.includes(NO_ATTACH_RULE));
  eq(shapeRulesFor(true), SHAPE_RULES, "opt-in keeps the #268 rule");
  eq(attachTool().effect, "read");
});

Deno.test("research answers: the source-list file is not sent by default (the report link carries the detail); opt-in sends it", async () => {
  const reply: ResearchReply = { answer: "Acme pays $90k (from its posting).", report: { url: "https://trainee.example/r/1", verified: true }, sources: [{ url: "https://acme.example/careers", title: "Acme" }],
    attachment: { filename: "sources-acme.txt", bytes: new TextEncoder().encode("1. Acme"), mime: "text/plain" }, dropped: { links: [], details: 0, report: null } };
  eq(researchParts(reply).map((p) => p.kind), ["text", "link"]);
  eq(researchParts(reply, { attach: true }).map((p) => p.kind), ["text", "attachment", "link"]);
  const docs: string[] = [];
  const adapter = { channel: "telegram", render: (t: string) => [t], send: async () => ({ ok: true, id: "1" }), sendDocument: async (_a: string, f: { filename: string }) => { docs.push(f.filename); return { ok: true, id: "2" }; } } as any;
  await deliverResearch({ reply, address: "42", adapter });
  eq(docs, []);
  await deliverResearch({ reply, address: "42", adapter, attach: true });
  eq(docs, ["sources-acme.txt"]);
});

Deno.test("research_brief publisher hook: interface only, behind CAREER_RESEARCH_BRIEF; no publisher or no https link = no brief link claimed", async () => {
  const on = { get: (k: string) => (k === "CAREER_RESEARCH_BRIEF" ? "on" : undefined) }, off = { get: () => undefined };
  const pub = { publish: async () => ({ url: "https://trainee.example/file?t=v1.a.b" }) };
  eq(briefPublisherFor(off, pub), null);
  eq(briefPublisherFor(on, null), null);
  const reply: ResearchReply = { answer: "a", sources: [], dropped: { links: [], details: 0, report: null } };
  const brief = { title: "Acme", facts: [], sources: [] };
  eq((await withBriefLink(reply, U, brief, null)).report, undefined);
  eq((await withBriefLink(reply, U, brief, briefPublisherFor(on, pub)))?.report?.url, "https://trainee.example/file?t=v1.a.b");
  eq((await withBriefLink(reply, U, brief, { publish: async () => ({ url: "http://insecure.example/x" }) })).report, undefined);
  eq((await withBriefLink(reply, U, brief, { publish: async () => { throw new Error("down"); } })).report, undefined);
});

Deno.test("apply-here host edge cases: userinfo@, punycode, shortener and trailing-dot hosts are judged by the real hostname", async () => {
  // userinfo: the host is what follows the @, so a decoy before it neither blocks nor allows
  eq(applyHereAsk("apply https://boards.greenhouse.io@linkedin.com/jobs/1", null)?.blocked.length, 1);
  const decoy = applyHereAsk("apply https://linkedin.com@boards.greenhouse.io/acme/jobs/1", null);
  eq(decoy?.blocked, []); eq(decoy?.urls.length, 1);
  // trailing dot: linkedin.com. is still LinkedIn
  eq(applyHereAsk("apply https://www.linkedin.com./jobs/view/1", null)?.blocked.length, 1);
  eq(applyHereAsk("apply https://uk.indeed.com./viewjob?jk=1", null)?.blocked.length, 1);
  // punycode / lookalike hosts are not LinkedIn and not an ATS we open: refused as "apply there yourself", never fetched
  const w = await world([1]);
  for (const u of ["https://xn--linkedn-9ya.com/jobs/1", "https://bit.ly/3abcdef", "https://boards.greenhouse.io.evil.example/acme/jobs/1"]) {
    const r = await w.run(`apply ${u}`);
    eq(r?.status, "refused", u); eq(r?.hits, [], u);
  }
  eq(w.fetched, [], "no board was fetched for any of them");
});
