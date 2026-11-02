// NETWORKING ROUND 2 AT SCALE (owner rules, 2026-10-30), the runners: ~10,600 seeded scenarios (networking-r2-generator.ts)
// through the product's own functions, a fixed clock, fake Gmail / Outlook / web search / pages
// and the in-memory stores. No database, no network, no model. Round 1 (scenarios-networking, scenarios-replies,
// scenarios-outreach) is not repeated; this covers the categories it did not:
//   discovery  people discovery over hostile public pages (webProvider): only people who work there now, once each, only a
//              work address at the company's domain, never an instruction, never a LinkedIn or Indeed page read.
//   page       a page the person sends (peopleTurn): the same rules on what is saved; a LinkedIn link is never opened.
//   draft      one draft (draftFor + the fact-lock): honest drafts pass, in the person's language too; a misspelled name, an
//              invented employer or school (any script), a one-sided "we both", a secret, too long, no subject never do.
//   reply      what comes back, through both lanes (the rail's classifyIncoming, the replies lane's rulePass and
//              recordMessage): auto-replies in twenty languages, opt-outs in nine, calendar answers, a colleague, bounces,
//              "send your resume", the List-Unsubscribe mailto. Nothing is ever sent or attached in answer.
//   approve    the replies lane's batches: an answer approves exactly the batch shown in that chat (pushed or shown).
//   stop       "stop emailing <address or name>": exactly that address's waiting emails and follow-ups, nothing else.
//   worker     the rail's worker: a bounded Gmail wait, Sent checked before a retry, List-Unsubscribe on follow-ups, the
//              mailbox each email was approved for, up to 2,000 emails for one person with only Gmail's quota slowing it.
// The tests are tests/architect/scenarios-networking-r2.test.ts and -2.test.ts; the end to end sample on Postgres is
// tests/architect/flow-scenarios-networking-r2.test.ts.
import assertNode from "node:assert/strict";
export { COUNTS, generate } from "./networking-r2-generator.ts";
import {
  type ApproveScenario, COUNTS, DAY, type DiscoveryScenario, type DraftScenario, generate, NOW, type PageScenario, RECIPIENT, type ReplyScenario, type StopScenario, type WorkerScenario,
} from "./networking-r2-generator.ts";
import { webProvider } from "../../../supabase/functions/_shared/career_people_provider.ts";
import { peopleOnPage } from "../../../supabase/functions/_shared/career_people_page.ts";
import { readsAsInstruction } from "../../../supabase/functions/_shared/career_people_import.ts";
import { type Intro, type PeopleDeps, type PeopleStore, peopleTurn, type PersonRec, type Prefs } from "../../../supabase/functions/_shared/career_people.ts";
import { draftFor, draftLangOf, LANG_NAME, memoryOutreachStore } from "../../../supabase/functions/_shared/career_outreach.ts";
import { classifyIncoming, runSendWorker, sendTimeout, threadAnswer, type WorkerDeps } from "../../../supabase/functions/_shared/career_send_rail.ts";
import { ACTIONS_INTENT, actionHash, memoryRepliesStore, recordMessage, repliesTurn, rulePass, STOP_INTENT } from "../../../supabase/functions/_shared/career_outreach_replies.ts";

export const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
export const ALL = generate();

// ------------------------------------------------------------------------------------------------ the report
type Failure = { id: number; category: string; why: string; got: string };
class Report {
  total = 0; failures = new Map<string, Failure[]>();
  constructor(public what: string) {}
  grade(s: { id: number; category: string }, why: string | null, got: unknown) {
    this.total++;
    if (!why) return;
    const k = `${s.category.split("/").slice(0, 2).join("/")}: ${why.replace(/ \[.*$/s, "")}`;
    if (!this.failures.has(k)) this.failures.set(k, []);
    this.failures.get(k)!.push({ id: s.id, category: s.category, why, got: JSON.stringify(got).slice(0, 500) });
  }
  assertClean() {
    const n = [...this.failures.values()].reduce((a, b) => a + b.length, 0);
    const lines = [`[networking-r2] ${this.what}: ${this.total} scenarios, ${n} failures`];
    for (const [k, xs] of this.failures) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 3)) lines.push(`    #${x.id} ${x.category}${x.why.includes(" [") ? ` ${x.why.slice(x.why.indexOf(" [") + 1)}` : ""} -> ${x.got}`); }
    console.log(lines.join("\n"));
    eq(n, 0, `${this.what}: ${n} of ${this.total} failed (see the report above)`);
  }
}
export async function grade<T extends { id: number; category: string }>(name: string, xs: T[], run: (s: T) => Promise<{ why: string | null; got: unknown }>) {
  const rep = new Report(name);
  for (const s of xs) {
    let res: { why: string | null; got: unknown };
    try { res = await run(s); } catch (e) { res = { why: `threw: ${e instanceof Error ? e.message : e}`, got: e instanceof Error ? e.stack?.split("\n").slice(0, 3).join(" | ") : String(e) }; }
    rep.grade(s, res.why, res.got);
  }
  rep.assertClean();
}

// ------------------------------------------------------------------------------------------------ discovery
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function pageHtml(s: DiscoveryScenario, k: number): string {
  const here = s.people.filter((p) => p.page === k);
  const graph = [...(s.pages[k].org ? [{ "@type": "Organization", name: s.pages[k].org }] : []), ...here.filter((p) => p.ld).map((p) => p.ld)];
  const links = here.filter((p) => p.mailto).map((p) => `<a href="mailto:${p.mailto!.email}">${esc(p.mailto!.words)}</a>`).join("\n");
  return `<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graph })}</script></head><body>${links}</body></html>`;
}
export async function runDiscovery(s: DiscoveryScenario) {
  const html = new Map(s.pages.map((p, k) => [p.url, pageHtml(s, k)]));
  const read: string[] = [];
  const search = async () => ({ status: "ok" as const, urls: [...s.pages.map((p) => ({ url: p.url, title: "" })), ...s.blockedUrls.map((url) => ({ url, title: "" }))], cost_usd: 0 });
  const prov = webProvider({ search, fetch: (() => { throw new Error("no network in this test"); }) as unknown as typeof fetch, mx: async () => ({ status: "ok", hosts: ["mx.example"] }) as any,
    read: async (_f, url) => { read.push(url); const h = html.get(url); return h ? { ok: true, url, ...peopleOnPage(h) } : { ok: false, why: "http" }; } });
  const r = await prov.findPeople({ company: s.company, titles: [] });
  if (r.status !== "ok") return { why: `discovery did not finish: ${r.status}`, got: r };
  const got = r.people.map((p) => ({ name: p.name, email: p.email, title: p.position, url: p.source_url }));
  const out = { got, want: s.want, read };
  if (read.some((u) => /linkedin|indeed/i.test(u))) return { why: "a LinkedIn or Indeed page was read", got: out };
  if (!s.blockedUrls.every((u) => r.text_only.includes(u))) return { why: "a LinkedIn or Indeed result is kept as text only", got: out };
  for (const p of got) if (readsAsInstruction(p.name) || readsAsInstruction(p.title) || /system|admin mode|im_start/i.test(`${p.name} ${p.title}`)) return { why: "an instruction from a page was kept", got: out };
  const names = got.map((p) => p.name).sort(), wantNames = s.want.map((p) => p.name).sort();
  if (new Set(names).size !== names.length) return { why: "a person is listed twice", got: out };
  const extra = names.filter((n) => !wantNames.includes(n)), missing = wantNames.filter((n) => !names.includes(n));
  if (extra.length) {
    const k = s.people.find((p) => p.name === extra[0])?.kind ?? "?";
    return { why: `listed someone who must not be (${k}) [${extra.join(", ")}]`, got: out };
  }
  if (missing.length) return { why: `missed someone who works there [${missing.join(", ")}]`, got: out };
  for (const w of s.want) {
    const p = got.find((x) => x.name === w.name)!;
    const kind = s.people.find((x) => x.name === w.name)?.kind;
    if (p.email !== w.email) return { why: `the address for a ${kind} person [${p.email} vs ${w.email}]`, got: out };
    if (p.title !== w.title) return { why: `the title for a ${kind} person [${p.title} vs ${w.title}]`, got: out };
    if (p.email && p.email.split("@")[1] !== s.domain) return { why: "an address off the company's domain", got: out };
  }
  return { why: null, got: out };
}

// ------------------------------------------------------------------------------------------------ page
function peopleStore(): PeopleStore & { rows: (PersonRec & { user_id: string })[] } {
  let id = 0;
  const rows: (PersonRec & { user_id: string; dedupe_key: string })[] = [];
  const prefs = new Map<string, Prefs>();
  const none: Intro[] = [];
  return {
    rows,
    async pruneThreadContacts() { return { rows: 0, threads: 0 }; },
    async importRows(u, source, _file, _sha, rs, _read, _skipped, replace) {
      let replaced = 0, inserted = 0;
      if (replace) for (let i = rows.length - 1; i >= 0; i--) if (rows[i].user_id === u && rows[i].source === source) { rows.splice(i, 1); replaced++; }
      for (const r of rs as any[]) {
        if (rows.some((x) => x.user_id === u && x.source === source && x.dedupe_key === r.dedupe_key)) continue;
        rows.push({ id: ++id, user_id: u, source, name: r.name ?? null, email: r.email ?? null, company: r.company ?? "", company_key: r.company_key ?? "", position: r.position ?? "", school: r.school ?? "",
          connected_on: null, last_seen_at: null, source_ref: r.source_ref, source_url: r.source_url ?? null, retrieved_at: new Date(NOW).toISOString(), dedupe_key: r.dedupe_key });
        inserted++;
      }
      const mine = rows.filter((x) => x.user_id === u && x.source === source);
      return { inserted, duplicates: rs.length - inserted, kept: mine.length, with_email: mine.filter((x) => x.email).length, replaced };
    },
    async counts(u) { const c: Record<string, number> = {}; for (const r of rows) if (r.user_id === u) c[r.source] = (c[r.source] ?? 0) + 1; return c; },
    async atCompany(u, key) { return rows.filter((r) => r.user_id === u && key && r.company_key === key); },
    async named(u, n) { const w = n.toLowerCase(); return rows.filter((r) => r.user_id === u && r.name?.toLowerCase() === w); },
    async setSchool() { return 0; },
    async forget() { return 0; },
    async prefs(u) { return prefs.get(u) ?? { export_asked_at: null, paste_header: null, paste_file: null, paste_at: null }; },
    async setPrefs(u, p) { prefs.set(u, { ...(prefs.get(u) ?? { export_asked_at: null, paste_header: null, paste_file: null, paste_at: null }), ...p }); },
    async saveJobs() { return 0; }, async jobs() { return []; }, async forgetJobs() { return 0; },
    async intros() { return none; }, async intro() { return null; }, async addIntro() { throw new Error("no intros here"); }, async updateIntro() { return null; },
    async forgetIntros() { return 0; }, async dueIntros() { return []; },
  } as PeopleStore & { rows: (PersonRec & { user_id: string })[] };
}
function sentPageHtml(s: PageScenario): string {
  const ld = s.people.filter((p) => p.kind !== "role_mailto" && p.name).map((p) => ({ "@type": "Person", name: p.name, jobTitle: p.title, email: p.email }));
  const links = s.people.filter((p) => p.kind === "role_mailto" || !p.name).map((p) => `<a href="mailto:${p.email}">${p.kind === "role_mailto" ? "Careers Team" : "email me"}</a>`).join("\n");
  return `<html><head><script type="application/ld+json">${JSON.stringify([...(s.company ? [{ "@type": "Organization", name: s.company }] : []), ...ld])}</script></head><body>${links}</body></html>`;
}
export async function runPage(s: PageScenario) {
  const store = peopleStore();
  const gets: string[] = [];
  const html = sentPageHtml(s);
  const deps: PeopleDeps = { store, gmail: null, resolve: async () => ["93.184.215.14"], fetch: (async () => { throw new Error("no fetch for a page"); }) as unknown as typeof fetch,
    pageGet: async (u: URL) => { gets.push(u.toString()); return u.pathname === "/robots.txt" ? new Response("", { status: 404 }) : new Response(html, { headers: { "content-type": "text/html" } }); } };
  const r = await peopleTurn({ message: s.message, userId: "u-1", threadId: "t-1", now: NOW, state: {}, store: memoryOutreachStore(), model: null, people: deps });
  const rows = store.rows.map((x) => ({ name: x.name, email: x.email, company: x.company, title: x.position }));
  const got = { status: r?.status, reply: r?.reply?.slice(0, 300), rows, gets };
  if (s.linkedin) {
    if (gets.length) return { why: "a LinkedIn page was opened", got };
    if (rows.length || r?.status !== "refused") return { why: "a LinkedIn link is refused and nothing is saved", got };
    return { why: null, got };
  }
  const current = s.people.filter((p) => p.kind !== "former" && p.kind !== "role_mailto");
  if (!s.owner && !current.length) {
    if (r?.status !== "no_people" || rows.length || !/no longer there/.test(r.reply)) return { why: "a page with only people who left saves no one and says why", got };
    return { why: null, got };
  }
  if (r?.status !== "read") return { why: `the page was not read (${r?.status})`, got };
  if (s.owner) {
    const p = s.people[0];
    if (rows.length !== 1 || rows[0].name !== s.owner || rows[0].email !== p.email) return { why: "someone's own site keeps their own address under their name", got };
    return { why: null, got };
  }
  for (const p of s.people) {
    const row = rows.find((x) => x.name === p.name);
    if (p.kind === "role_mailto") { if (rows.some((x) => x.email === p.email)) return { why: "a role inbox was saved as a person", got }; continue; }
    if (p.kind === "former") { if (row) return { why: "someone the page says has left was saved under the company", got }; continue; }
    if (!row) return { why: `a current person was not saved (${p.kind})`, got };
    const keep = p.kind === "work" || p.kind === "company_label";
    if (keep && row.email !== p.email) return { why: `a work address on the company's domain was not kept (${p.kind})`, got };
    if (!keep && row.email) return { why: `an address off the company's domain was saved as their work address (${p.kind}) [${row.email}]`, got };
  }
  if (s.people.some((p) => p.kind === "lookalike" || p.kind === "personal") && !/not at .* domain/.test(r.reply)) return { why: "the reply does not say an address was left out", got };
  return { why: null, got };
}

// ------------------------------------------------------------------------------------------------ draft
export async function runDraft(s: DraftScenario) {
  const prompts: any[] = [];
  const model = async (p: any) => { prompts.push(p); return { content: [{ type: "text", text: s.output }], stop_reason: "end_turn" }; };
  const lang = draftLangOf(s.message);
  if (s.lang === "en" ? lang !== null : lang !== s.lang) return { why: `the person's language was read as ${lang} [${s.message}]`, got: { lang } };
  // PERSONALIZED OUTREACH (2026-10-31): this battery grades the fact-lock writer with fixed outputs (claims, languages); first
  // emails go through the engine (outreach-personalize.test.ts). Was draftFor without personal: false, a generic first email.
  const d = await draftFor({ model, facts: s.facts, r: { ...s.recipient, source: "test" }, lang, personal: false });
  const got = { ok: d.ok, why: d.ok ? null : d.detail.slice(0, 3), out: s.output.slice(0, 300) };
  if (s.lang !== "en" && !String(prompts[0]?.messages?.[0]?.content ?? "").includes(`in ${LANG_NAME[s.lang]}`)) return { why: "the writer is not told the person's language", got };
  if (d.ok !== s.ok) return { why: s.ok ? "an honest draft was refused" : "a draft that must be refused was accepted", got };
  if (d.ok) {
    const want = s.output.replace(/^Subject: (.+)\n\n/, "");
    if (d.body !== want || `Subject: ${d.subject}` !== s.output.split("\n")[0]) return { why: "the draft is not exactly the text written", got };
    if (!d.body.includes(s.recipient.name.split(" ")[0])) return { why: "the recipient's name is not as on the record", got };
  }
  return { why: null, got };
}

// ------------------------------------------------------------------------------------------------ reply
const T0 = NOW - 5 * DAY;
export async function runReply(s: ReplyScenario) {
  const rail = classifyIncoming({ from: s.from, subject: s.subject, snippet: s.text }, RECIPIENT);
  const msg = { id: `in-${s.id}`, thread: "th-1", from: s.from, to: "me@example.test", subject: s.subject, text: s.text, at: new Date(NOW - 3600_000).toISOString(), headers: s.headers ?? {}, fromMe: false };
  const lane = rulePass(msg, RECIPIENT, NOW, "UTC")?.cls ?? null;
  const got: Record<string, unknown> = { rail, lane };
  if (rail !== s.rail) return { why: `the rail read it as ${rail}, wanted ${s.rail}`, got };
  if (!s.unsubscribe && lane !== s.lane) return { why: `the replies lane read it as ${lane}, wanted ${s.lane}`, got };
  if (s.unsubscribe) {
    // The List-Unsubscribe mailto arrives as a new email from them, outside the thread: the rail's reply check finds it.
    const fetch = (async (input: string | URL | Request) => {
      const u = new URL(String(input instanceof Request ? input.url : input));
      if (u.pathname.endsWith("/threads/t-1")) return Response.json({ messages: [{ id: "g-1", labelIds: ["SENT"], snippet: "Hi", payload: { headers: [{ name: "From", value: "me@example.test" }] } }] });
      if (u.pathname.endsWith("/messages") && /subject:unsubscribe/.test(u.searchParams.get("q") ?? "")) return Response.json({ messages: [{ id: "u-1" }] });
      return new Response("{}", { status: 404 });
    }) as typeof globalThis.fetch;
    const a = await threadAnswer({ fetch }, "tok", { id: "q-1", recipient_email: RECIPIENT, gmail_id: "g-1", gmail_thread: "t-1", sent_at: new Date(T0).toISOString() });
    if (!("kind" in a) || a.kind !== "stop") return { why: "the List-Unsubscribe mailto is an opt-out", got: { ...got, a } };
    return { why: null, got };
  }
  // The replies lane records it on the conversation; a follow-up waits for the person's yes.
  const store = memoryRepliesStore();
  await store.setPrefs("u-1", { steps: [3, 4], off: false });
  const tid = await store.track({ user_id: "u-1", draft_id: "d-1", provider: "gmail", provider_thread: "th-1", email: RECIPIENT, name: "Maya Chen", firm: "Acme", subject: "Coffee chat?", sent_at: new Date(T0).toISOString() });
  const payload = { to: RECIPIENT, subject: "Re: Coffee chat?", text: "Following up on my note.", thread: "th-1", provider: "gmail", step: 1 };
  await store.saveActions("u-1", [{ thread_id: tid, kind: "followup", step: 1, payload, hash: await actionHash("followup", payload) }], NOW - 7200_000);
  const resume = s.category.startsWith("reply/resume");
  const model = resume ? async () => ({ content: [{ type: "tool_use", name: "record_email", input: { class: "interested", summary: "They asked for your resume.", asks: ["send your resume"] } }], stop_reason: "tool_use" }) : null;
  const res = await recordMessage({ store, userId: "u-1", thread: (await store.thread("u-1", tid))!, msg, model, now: NOW, tz: "UTC" });
  const dump = store.dump() as any;
  const t = dump.threads[0], fu = dump.actions[0];
  Object.assign(got, { res, status: t.status, followup: fu.status, dnc: dump.dnc, actions: dump.actions.length, next: t.next_step });
  if (dump.actions.length !== 1 || dump.actions.some((a: any) => a.status === "approved" || a.status === "running" || a.status === "done")) return { why: "something was drafted, approved or sent in answer", got };
  const want = s.lane === "not_interested" ? { status: "not_interested", fu: "cancelled", dnc: true } : s.lane === "bounce" ? { status: "bounced", fu: "cancelled", dnc: true }
    : s.lane === "out_of_office" ? { status: "out_of_office", fu: "shown", dnc: false } : s.lane === "notice" ? { status: "awaiting", fu: "shown", dnc: false }
    : { status: resume ? "interested" : "other", fu: "cancelled", dnc: false };
  if (t.status !== want.status) return { why: `the conversation reads ${t.status}, wanted ${want.status}`, got };
  if (fu.status !== want.fu) return { why: `the waiting follow-up is ${fu.status}, wanted ${want.fu}`, got };
  if (dump.dnc.includes(RECIPIENT) !== want.dnc) return { why: want.dnc ? "the contact's opt-out is not recorded" : "the contact was put on the do-not-contact list by someone else's words", got };
  if (resume && !/send your resume/.test(String(t.next_step))) return { why: "the next step does not say they asked for the resume", got };
  return { why: null, got };
}

// ------------------------------------------------------------------------------------------------ approve
export async function runApprove(s: ApproveScenario) {
  const store = memoryRepliesStore();
  const U = "u-1", CHAT = "chat-1";
  let k = 0;
  const batch = async (user: string, size: number, at: number) => {
    const items = [];
    for (let i = 1; i <= size; i++) {
      k++;
      const email = `p${k}@acme.example`;
      const tid = await store.track({ user_id: user, draft_id: `d-${k}`, provider: "gmail", provider_thread: `th-${k}`, email, name: `Person ${k}`, firm: "Acme", subject: `Hello ${k}`, sent_at: new Date(T0).toISOString() });
      const payload = { to: email, subject: `Re: Hello ${k}`, text: `Following up (${k}).`, thread: `th-${k}`, provider: "gmail", step: 1 };
      items.push({ thread_id: tid, kind: "followup" as const, step: 1, payload, hash: await actionHash("followup", payload) });
    }
    return await store.saveActions(user, items, at);
  };
  const A = await batch(U, s.size, NOW - 3600_000);
  if (s.otherPerson) await batch("u-2", 2, NOW - 3500_000);
  let st: any = store;
  if (s.how === "pushed") store.pushed(U, CHAT, A[0].batch_id);
  else if (s.how === "shown") {
    const r = await repliesTurn({ message: "show outreach approvals", userId: U, chatThreadId: CHAT, now: NOW - 3000_000, store });
    if (r?.status !== "shown") return { why: "show did not show", got: r };
    store.setIntent(CHAT, r.intent); // the handler keeps the reply's intent as the chat's last word
  }
  else if (s.how === "unrecorded") st = { ...store, lastAssistantIntent: async () => ACTIONS_INTENT, shownBatch: async () => null };
  else store.setIntent(CHAT, "career_apply_card");
  for (const [j, size] of s.newer.entries()) await batch(U, size, NOW - 2000_000 + j * 1000);
  const r = await repliesTurn({ message: s.answer, userId: U, chatThreadId: CHAT, now: NOW, store: st });
  const acts = (store.dump() as any).actions as any[];
  const mineA = acts.filter((a) => a.batch_id === A[0].batch_id);
  const others = acts.filter((a) => a.batch_id !== A[0].batch_id);
  const got = { status: r?.status, reply: r?.reply?.slice(0, 200), A: mineA.map((a) => `${a.n}:${a.status}`), others: others.map((a) => a.status) };
  if (others.some((a) => a.status !== "shown")) return { why: "a batch not shown in this chat was answered", got };
  if (s.how === "unrecorded" && (r?.status !== "reshown" || mineA.some((a) => a.status !== "shown"))) return { why: "with no batch on record as shown here, nothing is approved and what waits is shown", got };
  if (s.how === "other_word" && (r !== null || mineA.some((a) => a.status !== "shown"))) return { why: "an answer to something else approved a batch", got };
  if (s.how === "pushed" || s.how === "shown") {
    if (s.wants === "none") { if (mineA.some((a) => a.status !== "cancelled")) return { why: "send none drops the shown batch", got }; }
    else if (s.wants === null) { if (mineA.some((a) => a.status !== "shown")) return { why: "an unclear answer approved something", got }; }
    else {
      const approved = mineA.filter((a) => a.status === "approved").map((a) => a.n).sort();
      if (JSON.stringify(approved) !== JSON.stringify([...s.wants].sort())) return { why: `approved ${JSON.stringify(approved)} of the shown batch, wanted ${JSON.stringify(s.wants)}`, got };
      for (const a of mineA.filter((x) => x.status === "approved")) if (a.approved_hash !== await actionHash("followup", a.payload)) return { why: "approved, but not bound to the exact payload shown", got };
      if (s.newer.length && s.wants.length && !/more drafted since/.test(r?.reply ?? "")) return { why: "the reply does not say newer ones wait unapproved", got };
    }
  }
  return { why: null, got };
}

// ------------------------------------------------------------------------------------------------ stop
export async function runStop(s: StopScenario) {
  const store = memoryRepliesStore();
  const U = "u-1";
  const t = s.target ?? { email: "nobody@acme.example", name: "Nobody Here" };
  const mk = async (email: string, name: string, k: number, waiting: number) => {
    const tid = await store.track({ user_id: U, draft_id: `d-${email}-${k}`, provider: "gmail", provider_thread: `th-${email}-${k}`, email, name, firm: "Acme", subject: "Hello", sent_at: new Date(T0).toISOString() });
    if (waiting) {
      const payload = { to: email, subject: "Re: Hello", text: `Following up (${k}).`, thread: `th-${email}-${k}`, provider: "gmail", step: 1 };
      const [a] = await store.saveActions(U, [{ thread_id: tid, kind: "followup", step: 1, payload, hash: await actionHash("followup", payload) }], NOW - 3600_000);
      if (waiting > 1) await store.approve(U, a.batch_id, [{ n: a.n, hash: a.hash }], NOW - 1800_000);
    }
    return tid;
  };
  await mk(t.email, t.name, 0, s.waiting);
  if (s.ambiguous) await mk(`other.${t.email}`, t.name, 1, 1);
  for (let i = 0; i < s.others; i++) await mk(`someone${i}@globex.example`, `Other${i} Person`, 2 + i, 1);
  const before = JSON.stringify((store.dump() as any).actions);
  const r = await repliesTurn({ message: s.message, userId: U, chatThreadId: "chat-1", now: NOW, store });
  const dump = store.dump() as any;
  const got = { status: r?.status, intent: r?.intent, reply: r?.reply?.slice(0, 260), actions: dump.actions.map((a: any) => `${a.payload.to}:${a.status}`) };
  if (!s.target) {
    if (r?.intent === STOP_INTENT || JSON.stringify(dump.actions) !== before) return { why: `"${s.message}" was read as stopping someone`, got };
    return { why: null, got };
  }
  if (r?.intent !== STOP_INTENT) return { why: `"${s.message}" was not read as stopping them`, got };
  if (s.ambiguous) {
    if (r.status !== "which" || JSON.stringify(dump.actions) !== before) return { why: "two people of that name: nothing is stopped until the person says which", got };
    return { why: null, got };
  }
  const theirs = dump.actions.filter((a: any) => a.payload.to === t.email), rest = dump.actions.filter((a: any) => a.payload.to !== t.email);
  if (theirs.some((a: any) => a.status !== "cancelled")) return { why: "a follow-up to them is still waiting", got };
  if (rest.some((a: any) => a.status === "cancelled")) return { why: "someone else's follow-up was stopped", got };
  if (dump.threads.filter((x: any) => x.recipient_email === t.email).some((x: any) => x.followup_state !== "off")) return { why: "follow-ups to them were not turned off", got };
  if (dump.threads.filter((x: any) => x.recipient_email !== t.email).some((x: any) => x.followup_state !== "none")) return { why: "someone else's follow-ups were turned off", got };
  const said = s.waiting ? /won't be sent/.test(r.reply) && new RegExp(`\\b1 follow-up`).test(r.reply) : /Nothing was waiting/.test(r.reply);
  if (!said) return { why: "the reply does not say what was stopped", got };
  if (!/doesn't tell them anything/.test(r.reply)) return { why: "the reply does not say what it does not do", got };
  return { why: null, got };
}

// ------------------------------------------------------------------------------------------------ worker
const b64urlDecode = (s: string) => { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)); return new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0))); };
export async function runWorker(s: WorkerScenario) {
  if (s.kind === "lease_bound") {
    const t = sendTimeout({ leaseSeconds: s.leaseSeconds, sendTimeoutMs: s.timeoutMs });
    const ok = t >= 1 && t <= (s.leaseSeconds * 1000) / 2 && sendTimeout({ leaseSeconds: 120 }) <= 60_000 && sendTimeout({ leaseSeconds: 120, sendTimeoutMs: 10 }) === 10;
    return { why: ok ? null : "the send wait is not bounded below the lease", got: { t, lease: s.leaseSeconds } };
  }
  const kind = s.kind === "outreach_unsub" ? "outreach" : s.kind === "application_no_unsub" ? "application" : "general";
  const followUp = s.kind === "followup_unsub";
  const provider = s.kind === "provider_outlook" ? "outlook" : "gmail";
  const { payloadHash, messageOf } = await import("../../../supabase/functions/_shared/career_outreach.ts");
  const items: any[] = [];
  for (let k = 0; k < s.n; k++) {
    const to = `p${k}@acme.example`, subject = `A question ${k}`, footer = "Sam Lee\n\nIf you'd rather not hear from me, reply stop and I won't write again.";
    const draft = { recipient: { name: `P ${k}`, firm: "Acme", title: "", school: "", email: to, source: "t" }, subject, body: `Hi P ${k},\n\nWould you have 15 minutes?`, footer };
    const m = messageOf(draft);
    items.push({ id: `q-${k}`, user_id: "u-1", kind, source_id: `d-${k}`, approval_hash: await payloadHash(m), provider, to, subject, body: m.text, attempts: 1, first_claimed_at: new Date(NOW - 600_000).toISOString(),
      follow_up_of: followUp ? "q-root" : null, from_email: "me@example.test", draft: kind === "outreach" ? draft : null,
      sequence: followUp ? [{ id: "q-root", recipient_email: to, gmail_id: "g-root", gmail_thread: "t-root", sent_at: new Date(T0).toISOString() }] : null });
  }
  const sent: { to: string; subject: string; head: string[] }[] = [];
  let posts = 0;
  const outlook: string[] = [];
  const hang = s.kind === "timeout" || s.kind === "accepted_then_hung" || s.kind === "retry_after_timeout_not_sent";
  const fetchFor = (attempt: number) => (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url);
    if (u.host !== "gmail.googleapis.com") throw new Error(`unexpected host ${u.host}`);
    const path = u.pathname.replace("/gmail/v1/users/me", "");
    if (req.method === "POST" && path === "/messages/send") {
      posts++;
      const raw = b64urlDecode(String((await req.json()).raw ?? ""));
      const head = raw.split("\r\n\r\n")[0].split("\r\n");
      const h = (n: string) => head.filter((l) => l.toLowerCase().startsWith(`${n.toLowerCase()}:`)).map((l) => l.slice(n.length + 1).trim());
      if (hang && attempt === 1) {
        if (s.kind === "accepted_then_hung") sent.push({ to: h("To")[0], subject: h("Subject")[0], head });
        // Gmail never answers: only the worker's own bound ends the wait.
        return await new Promise<Response>((_, no) => init?.signal?.addEventListener("abort", () => no(new DOMException("aborted", "AbortError")), { once: true }));
      }
      if (s.quotaAfter !== null && posts === s.quotaAfter + 1) return Response.json({ error: { code: 429, message: "Too many requests" } }, { status: 429, headers: { "retry-after": "60" } });
      sent.push({ to: h("To")[0], subject: h("Subject")[0], head });
      return Response.json({ id: `g-${posts}`, threadId: `t-${posts}` });
    }
    if (path === "/messages" && /in:sent/.test(u.searchParams.get("q") ?? "")) {
      const to = /to:(\S+)/.exec(u.searchParams.get("q") ?? "")?.[1];
      return Response.json({ messages: sent.filter((m) => m.to === to).map((_, i) => ({ id: `s-${i}` })) });
    }
    const one = /^\/messages\/s-(\d+)$/.exec(path);
    if (one) { const m = sent[Number(one[1])]; return Response.json({ id: `s-${one[1]}`, threadId: "ts", payload: { headers: [{ name: "To", value: m.to }, { name: "Subject", value: m.subject }] } }); }
    if (path === "/threads/t-root") return Response.json({ id: "t-root", messages: [{ id: "g-root", labelIds: ["SENT"], snippet: "Hi", payload: { headers: [{ name: "From", value: "me@example.test" }, { name: "Subject", value: "A question" }] } }] });
    if (path === "/messages" && /subject:unsubscribe/.test(u.searchParams.get("q") ?? "")) return Response.json({ messages: [] });
    return new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  const run = async (attempt: number) => {
    const calls: { name: string; p: any }[] = [];
    let claims = 0;
    const these = items.map((x) => ({ ...x, attempts: attempt }));
    const rpc = async (name: string, a: { p: any }) => {
      calls.push({ name, p: a.p });
      if (name === "career_send_claim") return { data: { accounts: claims++ ? [] : [{ user_id: "u-1", provider, items: these }] }, error: null };
      if (name === "career_send_go") return { data: "go", error: null };
      if (name === "career_send_complete") return { data: (a.p.results ?? []).map((x: any) => x.outcome), error: null };
      if (name === "career_send_record") return { data: a.p.kind, error: null };
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    };
    const deps: WorkerDeps = { rpc: rpc as any, fetch: fetchFor(attempt), now: () => NOW, token: async (_u, scope) => `tok-${scope.endsWith("gmail.send") ? "send" : "read"}`,
      providers: { outlook: { send: async (_u, m) => { outlook.push(m.to); return { status: "sent", id: `o-${outlook.length}` }; } } } };
    const started = performance.now();
    const stats = await runSendWorker(deps, { worker: "w-1", deadlineMs: 60_000, ...(hang ? { sendTimeoutMs: s.timeoutMs } : {}) });
    return { results: calls.filter((c) => c.name === "career_send_complete").flatMap((c) => c.p.results ?? []), stats, ms: performance.now() - started };
  };
  const first = await run(1);
  const got: Record<string, unknown> = { posts, sent: sent.length, outlook: outlook.length, outcomes: [...new Set(first.results.map((x: any) => x.outcome))], detail: first.results[0]?.detail, ms: Math.round(first.ms) };
  if (first.results.length !== s.n) return { why: `one outcome per email (${first.results.length} of ${s.n})`, got };
  if (hang) {
    const r0 = first.results[0];
    if (r0.outcome !== "retry" || r0.untried || !/did not answer/.test(String(r0.detail))) return { why: "a send Gmail never answered is given up as an attempt (Sent is checked next)", got };
    if (first.ms > s.timeoutMs + 2_000) return { why: `the wait was not bounded (${Math.round(first.ms)} ms)`, got };
    if (s.kind === "timeout") return { why: null, got };
    const second = await run(2);
    const r1 = second.results[0];
    Object.assign(got, { second: r1?.outcome, posts, sent: sent.length });
    if (s.kind === "accepted_then_hung" && (r1?.outcome !== "already_sent" || posts !== 1)) return { why: "a send Gmail took before going quiet is found in Sent, never sent again", got };
    if (s.kind === "retry_after_timeout_not_sent" && (r1?.outcome !== "sent" || sent.length !== 1 || posts !== 2)) return { why: "a send that never reached Gmail goes once on the next try", got };
    return { why: null, got };
  }
  if (provider === "outlook") {
    if (posts || outlook.length !== s.n) return { why: "an email approved for Outlook goes from Outlook, never Gmail", got };
    return { why: null, got };
  }
  if (outlook.length) return { why: "an email approved for Gmail went from Outlook", got };
  if (s.kind === "volume") {
    if (posts !== s.n || sent.length !== s.n || first.results.some((x: any) => x.outcome !== "sent")) return { why: "every approved email goes (no limit of Trainee's own)", got };
    if (new Set(sent.map((m) => m.to)).size !== s.n) return { why: "each address exactly once", got };
    return { why: null, got };
  }
  if (s.kind === "volume_quota") {
    const q = s.quotaAfter!;
    const by = (o: string) => first.results.filter((x: any) => x.outcome === o).length;
    if (sent.length !== q || by("sent") !== q || by("quota") !== 1 || by("retry") !== s.n - q - 1 || by("failed")) return { why: "Gmail's quota pauses the account; the rest wait untried, none fails", got: { ...got, sent: by("sent"), quota: by("quota"), retry: by("retry") } };
    if (first.results.filter((x: any) => x.outcome === "retry").some((x: any) => !x.untried)) return { why: "an email handed back under a quota is not an attempt", got };
    return { why: null, got };
  }
  const head = sent[0]?.head ?? [];
  const unsub = head.some((l) => /^List-Unsubscribe: <mailto:me@example\.test\?subject=unsubscribe>/.test(l));
  if (s.kind === "followup_unsub" || s.kind === "outreach_unsub") { if (!unsub) return { why: "a cold email (and its follow-up) carries List-Unsubscribe", got: { ...got, head } }; }
  else if (unsub && s.kind !== "provider_gmail") return { why: "List-Unsubscribe only on cold outreach", got: { ...got, head } };
  if (posts !== 1) return { why: "sent exactly once", got };
  return { why: null, got };
}

