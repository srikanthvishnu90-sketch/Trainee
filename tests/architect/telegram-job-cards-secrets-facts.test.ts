// Review fixes 2 on the Telegram job cards: (a) the production handler passes the person's CONFIRMED facts (the account record's
// profile + stated facts, the source the chat's apply turn reads) so the posting screen's knock-outs really run; (b) secret
// detection covers a password-TYPE input, top-level and nested payload keys, card_lines and secret-looking values; (c) a posting
// with no row on file is unreadable: refuse (fail closed). Fake Telegram transport, memory stores, a fake database client.
import assertNode from "node:assert/strict";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { hashTag, payloadLines, refOf, secretFields, supabaseConfirmedFacts, tapJob, type JobDeps, type JobStore, type PreparedRow } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { jobSenderFor, webhookDeps } from "../../supabase/functions/trainee-telegram/handler.ts";
import type { TapStore } from "../../supabase/functions/_shared/channel_card_tap.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const U = "11111111-1111-4111-8111-111111111111", PID = "33333333-3333-4333-8333-333333333333", CARD = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-10-28T12:00:00Z"), H = "ab".repeat(32), JOB = "greenhouse:acme:1";
const jobView = (loc = "Denver, CO") => ({ job_id: JOB, company: "Acme", title: "Data Analyst", location: loc, url: "https://boards.greenhouse.io/acme/jobs/1", pay: null, level: null, remote: null, posted_at: null, first_seen_at: null, deadline: null, source: null, reasons: [], gaps: [], company_domain: null });
const posting = (extra: any = {}) => ({ job_id: JOB, company: "Acme", title: "Data Analyst", location: "Denver, CO", url: "https://boards.greenhouse.io/acme/jobs/1", first_seen_at: "2026-10-27T12:00:00Z", posted_at: "2026-10-26T12:00:00Z", description: "Analyze data. This is an in-office role.", ...extra });

function tg() {
  const calls: { method: string; body: any }[] = [];
  const f = (async (u: string, init: RequestInit) => { calls.push({ method: String(u).split("/").pop()!, body: JSON.parse(String(init.body)) }); return Response.json({ ok: true, result: { message_id: 100 + calls.length } }); }) as unknown as typeof fetch;
  return { calls, adapter: telegramAdapter({ token: "T", fetch: f, sleep: async () => {} }), send: jobSenderFor(telegramAdapter({ token: "T", fetch: f, sleep: async () => {} }), "42") };
}
const all = (t: { calls: any[] }) => t.calls.map((c) => c.body.text ?? c.body.caption ?? "").join("\n");
const buttons = (t: { calls: any[] }) => t.calls.flatMap((c) => c.body.reply_markup?.inline_keyboard?.flat() ?? []).map((b: any) => b.callback_data as string);

// A fake database client: tables answer from handlers; every chain method returns the same thenable.
function fakeAdmin(tables: Record<string, (q: { filters: Record<string, unknown>; op: string }) => unknown>) {
  const from = (table: string) => {
    const q = { filters: {} as Record<string, unknown>, op: "select" };
    const run = () => ({ data: tables[table]?.(q) ?? null, error: null });
    const chain: any = {
      select: () => chain, eq: (k: string, v: unknown) => { q.filters[k] = v; return chain; }, in: (k: string, v: unknown) => { q.filters[k] = v; return chain; },
      order: () => chain, limit: () => chain, upsert: () => { q.op = "upsert"; return chain; }, maybeSingle: () => Promise.resolve(run()),
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    };
    return chain;
  };
  return { from };
}
const account = (facts: [string, string][], stated: any[] = []) => ({
  memory: { profile: { facts: facts.map(([kind, text], i) => ({ id: `f${i}`, kind, text, status: "confirmed", needs_confirmation: false })) } },
  stated_facts: { facts: stated },
});

Deno.test("the production handler passes the person's confirmed facts, so a location knock-out runs from a card tap", async () => {
  const t = tg();
  const ref = await refOf(U, JOB);
  const admin = fakeAdmin({
    career_watch_kv: (q) => q.filters.key === "career:account" ? { value: account([["location", "I live in Austin, TX"], ["preference", "I'm not open to relocating"]]) }
      : q.filters.key === `tg:job:${ref}` ? { value: { job: jobView(), shownAs: "text" } } : null,
    career_postings: () => [posting()], career_apply_jobs: () => [], career_apply_prepared: () => [],
  });
  const d = webhookDeps(t.adapter, { env: { get: () => undefined }, now: () => NOW, store: () => ({}) as any, chat: (async () => ({})) as any, deliver: (async () => ({})) as any, admin });
  const r = await (d as any).jobTap({ userId: U, data: `jca:${ref}`, messageId: "1", contact: "42" });
  eq(r.status, "screened", JSON.stringify(r) + all(t));
  assert(/Not queued/.test(all(t)), all(t));
  assert(!/queued, not applied/i.test(all(t)), "nothing was queued");
});

Deno.test("supabaseConfirmedFacts reads only confirmed facts and the person's stated facts; an unreadable record throws", async () => {
  const acct = account([["location", "I live in Austin, TX"]], [{ kind: "sponsorship", value: "no", evidence: "I don't need sponsorship" }]);
  acct.memory.profile.facts.push({ id: "d", kind: "location", text: "I live in Boston", status: "draft", needs_confirmation: true } as any);
  const facts = await supabaseConfirmedFacts(fakeAdmin({ career_watch_kv: () => ({ value: acct }) }))(U);
  assert(facts.some((f) => /Austin/.test(f.text)) && !facts.some((f) => /Boston/.test(f.text)), JSON.stringify(facts));
  assert(facts.some((f) => f.stated && f.kind === "sponsorship"));
  eq(await supabaseConfirmedFacts(fakeAdmin({ career_watch_kv: () => null }))(U), []);
  const bad = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "boom" } }) }) }) }) }) };
  let threw = false; try { await supabaseConfirmedFacts(bad)(U); } catch { threw = true; }
  assert(threw);
});

const prep = (fields: any[], extra: Record<string, unknown> = {}, card_lines: string[] = []): PreparedRow => ({ id: PID, job_id: JOB, company: "Acme", url: "https://boards.greenhouse.io/acme/jobs/1", payload_hash: H, state: "ready", card_lines,
  payload: { resume_sha256: "f".repeat(64), resume_name: "ada.pdf", fields, ...extra } });
function setup(o: { prepared?: PreparedRow; postings?: () => any[] }) {
  const log = { wants: 0, opened: 0 };
  const store: JobStore = {
    async remember() {}, async recall() { return { job: jobView("Austin, TX"), shownAs: "text" as const }; }, async rememberList() {}, async recallList() { return null; },
    async postings() { return (o.postings ?? (() => [posting({ location: "Austin, TX" })]))(); }, async save() { return "saved"; },
    async prepared() { return o.prepared ?? null; }, async applied() { return false; }, async want() { log.wants++; return { result: "queued" }; },
  };
  const tap: TapStore = { async card(_u, id) { return { id, items: [{ n: 1, prepared_id: PID, payload_hash: H }], state: "open", user_id: U } as any; }, async prepared() { return [{ id: PID, payload_hash: H, company: "Acme" }]; }, async answer() { return [{ n: 1, company: "Acme", result: "queued" }]; } };
  const deps: JobDeps = { store, now: () => NOW, env: { get: () => undefined }, tap, cards: { async open() { log.opened++; return { id: CARD, items: [{ n: 1, prepared_id: PID, payload_hash: H }], shown_at: new Date(NOW).toISOString() } as any; } } };
  return { deps, log };
}

const SECRETS = [
  { name: "p1", label: "Portal access", type: "password", value: "TYPE-PW-1" },
];
Deno.test("secret detection: a password-TYPE input with an innocent name, nested and top-level keys, card lines and secret-looking values", async () => {
  const cases: { name: string; p: PreparedRow; leak: RegExp }[] = [
    { name: "password-type input", p: prep(SECRETS), leak: /TYPE-PW-1/ },
    { name: "top-level token key", p: prep([{ name: "a", label: "A", value: "x" }], { access_token: "TOKEN-VALUE-9" }), leak: /TOKEN-VALUE-9/ },
    { name: "top-level ssn key", p: prep([], { ssn: "123-45-6789" }), leak: /123-45-6789/ },
    { name: "nested secret key", p: prep([], { meta: { session: { client_secret: "NEST-SECRET-7" } } }), leak: /NEST-SECRET-7/ },
    { name: "secret key inside a list", p: prep([], { extras: [{ name: "x", password: "LIST-PW-3" }] }), leak: /LIST-PW-3/ },
    { name: "card line", p: prep([], {}, ["Resume: ada.pdf", "Password: CARDLINE-PW-5"]), leak: /CARDLINE-PW-5/ },
    { name: "card number as a value", p: prep([], { notes: "4111 1111 1111 1111" }), leak: /4111/ },
    { name: "ssn as a field value", p: prep([{ name: "id_no", label: "ID number", value: "123-45-6789" }]), leak: /123-45-6789/ },
    { name: "autocomplete one-time-code", p: prep([{ name: "x1", label: "Code", autocomplete: "one-time-code", value: "OTP-8" }]), leak: /OTP-8/ },
  ];
  for (const c of cases) {
    assert(secretFields(c.p).length > 0, `${c.name}: detected`);
    const lines = payloadLines(c.p, null).join("\n");
    assert(/Needs you/.test(lines), `${c.name}: needs you\n${lines}`);
    assert(!c.leak.test(lines), `${c.name}: the value is never printed\n${lines}`);
    const t = tg(), { deps, log } = setup({ prepared: c.p });
    const ref = await refOf(U, JOB);
    const r = await tapJob({ userId: U, data: `jca:${ref}`, messageId: "1", deps, send: t.send });
    eq(r.status, "needs_you", c.name);
    assert(!buttons(t).some((b) => b.startsWith("jcy:")), `${c.name}: no Confirm button`);
    assert(!c.leak.test(all(t)), `${c.name}: nothing leaked to Telegram`);
    const y = await tapJob({ userId: U, data: `jcy:${ref}:${hashTag(H)}`, messageId: "1", deps, send: t.send });
    eq(y.status, "needs_you", `${c.name}: Confirm refused`);
    eq(log.opened, 0, `${c.name}: no approval opened`);
  }
});

Deno.test("ordinary payloads are not mistaken for secrets (an empty password field, a job id, a phone number, plain card lines)", () => {
  const p = prep([{ name: "first_name", label: "First name", value: "Ada" }, { name: "pw", label: "Password", type: "password", value: "" }, { name: "phone", label: "Phone", value: "512-555-0142" }],
    { requisition: "7381920384756", utm: { src: "tg" } }, ["Resume: ada.pdf", "Cover note: Hello"]);
  eq(secretFields(p), []);
  const lines = payloadLines(p, null).join("\n");
  assert(lines.includes("• Phone: 512-555-0142") && lines.includes("• requisition: 7381920384756") && lines.includes("• Resume: ada.pdf"), lines);
});

Deno.test("a posting with no row on file is unreadable: Apply and Confirm refuse and queue nothing (fail closed)", async () => {
  const ok = prep([{ name: "first_name", label: "First name", value: "Ada" }]);
  const t = tg(), { deps, log } = setup({ prepared: ok, postings: () => [] });
  const ref = await refOf(U, JOB);
  const a = await tapJob({ userId: U, data: `jca:${ref}`, messageId: "1", deps, send: t.send });
  eq(a.status, "screened");
  assert(!buttons(t).some((b) => b.startsWith("jcy:")), "no Confirm shown");
  const y = await tapJob({ userId: U, data: `jcy:${ref}:${hashTag(H)}`, messageId: "1", deps, send: t.send });
  eq(y.status, "screened");
  eq(log.wants, 0); eq(log.opened, 0);
  // with the row on file the same application is offered
  const t2 = tg(), ok2 = setup({ prepared: ok });
  eq((await tapJob({ userId: U, data: `jca:${ref}`, messageId: "1", deps: ok2.deps, send: t2.send })).status, "shown");
});
