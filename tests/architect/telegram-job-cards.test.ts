// Telegram job cards (owner, 2026-10-28): postings as logo + caption + Apply/Details/Save, phone login by Telegram's contact
// button, and Apply -> exact payload -> hash-bound Confirm. Everything runs over a fake Telegram transport (a fake fetch under the
// real adapter) and memory stores: no network, no model, no database.
import assertNode from "node:assert/strict";
import { parseTelegramUpdate, telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { runInbound, SHARE_PHONE_BUTTON, type CoreDeps } from "../../supabase/functions/_shared/channel_inbound.ts";
import { captionOf, confirmButtons, hashTag, jobViewOf, logoUrl, parseJobTap, payloadLines, refOf, sendJobCards, tapJob, type JobDeps, type JobStore, type JobView, type PreparedRow } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { jobSenderFor } from "../../supabase/functions/trainee-telegram/handler.ts";
import type { TapStore } from "../../supabase/functions/_shared/channel_card_tap.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const U = "11111111-1111-4111-8111-111111111111", V = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-28T12:00:00Z");
const H = "ab".repeat(32), H2 = "cd".repeat(32), PID = "33333333-3333-4333-8333-333333333333", CARD = "44444444-4444-4444-8444-444444444444";

// ---- the fake Telegram: records every Bot API call; sendPhoto can be made to fail (logo not fetchable)
function fakeTelegram(o: { photoFails?: boolean } = {}) {
  const calls: { method: string; body: any }[] = [];
  const fetchFake = (async (u: string, init: RequestInit) => {
    const method = String(u).split("/").pop()!;
    const body = JSON.parse(String(init.body));
    calls.push({ method, body });
    if (method === "sendPhoto" && o.photoFails) return Response.json({ ok: false, description: "Bad Request: failed to get HTTP URL content" }, { status: 400 });
    return Response.json({ ok: true, result: { message_id: 100 + calls.length } });
  }) as unknown as typeof fetch;
  const adapter = telegramAdapter({ token: "T", fetch: fetchFake, sleep: async () => {} });
  return { calls, adapter, send: jobSenderFor(adapter, "42") };
}

// ---- memory stores
function memStore(init: { prepared?: PreparedRow; applied?: boolean; postings?: any[] } = {}) {
  const mem = new Map<string, any>();
  const log = { wants: [] as string[], saved: [] as string[] };
  let prepared = init.prepared ?? null;
  const store: JobStore = {
    async remember(u, ref, job, shownAs) { mem.set(`${u}|job|${ref}`, { job, shownAs }); },
    async recall(u, ref) { return mem.get(`${u}|job|${ref}`) ?? null; },
    async rememberList(u, id, refs) { mem.set(`${u}|list|${id}`, refs); },
    async recallList(u, id) { return mem.get(`${u}|list|${id}`) ?? null; },
    async postings() { return init.postings ?? []; },
    async save(u, ref, _j) { const k = `${u}|saved|${ref}`; if (mem.has(k)) return "already"; mem.set(k, 1); log.saved.push(ref); return "saved"; },
    async prepared(u) { return u === U ? prepared : null; },
    async applied() { return !!init.applied; },
    async want(_u, job) { log.wants.push(job.job_id); return { result: "queued" }; },
  };
  return { store, log, setPrepared: (p: PreparedRow | null) => { prepared = p; } };
}
function memTap(log: { answered: { card: string; approve: number[] }[] }, hashOf: () => string): TapStore {
  return {
    async card(_u, id) { return { id, items: [{ n: 1, prepared_id: PID, payload_hash: hashOf() }], state: "open", user_id: U } as any; },
    async prepared() { return [{ id: PID, payload_hash: hashOf(), company: "Acme" }]; },
    async answer(_u, card, approve) { log.answered.push({ card, approve }); return approve.length ? [{ n: 1, company: "Acme", result: "queued" }] : [{ n: 1, company: "Acme", result: "declined" }]; },
  };
}
const prepared = (hash = H): PreparedRow => ({ id: PID, job_id: "greenhouse:acme:1", company: "Acme", url: "https://boards.greenhouse.io/acme/jobs/1", payload_hash: hash, state: "ready",
  card_lines: ["Data Analyst at Acme"], payload: { resume_sha256: "f".repeat(64), resume_name: "ada-resume.pdf", fields: [
    { name: "first_name", label: "First name", value: "Ada" }, { name: "cover_letter_text", label: "Cover note", value: "I built the pricing model at my last job." },
    { name: "resume", label: "Resume", type: "input_file", value: "ada-resume.pdf" }, { name: "work_auth", label: "Authorized to work in the US?", value: "Yes" }, { name: "empty", label: "Empty", value: "" }] } });

function deps(m: ReturnType<typeof memStore>, tapLog: { answered: any[] }, o: { env?: Record<string, string>; hash?: () => string; opened?: string[] } = {}): JobDeps {
  const hash = o.hash ?? (() => H);
  return { store: m.store, now: () => NOW, env: { get: (k) => o.env?.[k] },
    cards: { async open(_u, ids) { o.opened?.push(...ids); return { id: CARD, items: [{ n: 1, prepared_id: ids[0], payload_hash: hash() }], shown_at: new Date(NOW).toISOString() }; } },
    tap: memTap(tapLog, hash) };
}
const hit = (n: number, extra: any = {}) => ({ job_id: `greenhouse:acme:${n}`, company: "Acme", title: `Data Analyst ${n}`, location: "Austin, TX", url: `https://boards.greenhouse.io/acme/jobs/${n}`,
  first_seen_at: "2026-10-27T12:00:00Z", pay: "$90k-$110k", fit: { reasons: ["You list SQL", "Your last role was analytics"], gaps: ["No Tableau on file"] }, ...extra });
const row = (n: number, extra: any = {}) => ({ job_id: `greenhouse:acme:${n}`, provider: "greenhouse", remote: "hybrid", seniority_band: "mid", posted_at: "2026-10-25T09:00:00Z",
  description: "<p>About us</p><p>Requirements</p><ul><li>3 years of SQL</li><li>Dashboards</li></ul>", company_domain: "acme.com", ...extra });

Deno.test("cards: a posting with a logo is one sendPhoto with the logo URL, a caption of stated facts, and the Apply / Details / Save keyboard", async () => {
  const t = fakeTelegram(), m = memStore({ postings: [row(1)] }), log = { answered: [] as any[] };
  const r = await sendJobCards({ userId: U, hits: [hit(1)], deps: deps(m, log), send: t.send });
  eq([r.sent, r.total], [1, 1]);
  eq(t.calls.length, 1);
  const c = t.calls[0];
  eq(c.method, "sendPhoto");
  eq(c.body.chat_id, 42);
  eq(c.body.photo, "https://www.google.com/s2/favicons?sz=128&domain=acme.com");
  for (const want of ["Acme\nData Analyst 1\nAustin, TX · Hybrid", "Pay: $90k-$110k", "Level: mid", "Posted: 3 d ago (Oct 25)", "Source: Greenhouse", "• You list SQL", "• No Tableau on file"]) assert(c.body.caption.includes(want), `caption has "${want}":\n${c.body.caption}`);
  assert(c.body.caption.length <= 1024);
  const ref = await refOf(U, "greenhouse:acme:1");
  eq(c.body.reply_markup.inline_keyboard, [[{ text: "Apply", callback_data: `jca:${ref}` }, { text: "Details", callback_data: `jcd:${ref}` }, { text: "Save", callback_data: `jcs:${ref}` }]]);
  for (const b of c.body.reply_markup.inline_keyboard[0]) assert(new TextEncoder().encode(b.callback_data).length <= 64);
});

Deno.test("cards: nothing is invented: a fact the posting does not state is left out, never listed as 'not listed'", () => {
  const j = jobViewOf({ job_id: "lever:x:9", company: "Zed", title: "Analyst", location: "", url: "https://jobs.lever.co/x/9" }, null);
  const cap = captionOf(j, NOW);
  assert(!/not listed|Pay:|Apply by:|Posted:/.test(cap), cap);
  assert(cap.startsWith("Zed\nAnalyst"), "company first, then the role");
  assert(!/Level:|Why it fits|Gaps:|Remote|Hybrid/.test(cap), cap);
});

Deno.test("cards: no employer domain (an ATS link) means a text card with the same caption and keyboard, never a guessed logo", async () => {
  const t = fakeTelegram(), m = memStore({ postings: [row(2, { company_domain: null })] }), log = { answered: [] as any[] };
  await sendJobCards({ userId: U, hits: [hit(2)], deps: deps(m, log), send: t.send });
  eq(t.calls.map((c) => c.method), ["sendMessage"]);
  assert(t.calls[0].body.text.startsWith("Acme\nData Analyst 2") && t.calls[0].body.reply_markup.inline_keyboard[0].length === 3);
  eq(logoUrl({ company: "Acme", company_domain: null, url: "https://boards.greenhouse.io/acme/jobs/2" }, { get: () => undefined }), null);
  eq(logoUrl({ company: "Acme", company_domain: null, url: "https://careers.acme.com/jobs/2" }, { get: () => undefined }), "https://www.google.com/s2/favicons?sz=128&domain=acme.com");
});

Deno.test("cards: Telegram refusing the logo falls back to the text card (one card, not zero or two)", async () => {
  const t = fakeTelegram({ photoFails: true }), m = memStore({ postings: [row(3)] }), log = { answered: [] as any[] };
  const r = await sendJobCards({ userId: U, hits: [hit(3)], deps: deps(m, log), send: t.send });
  eq(t.calls.map((c) => c.method), ["sendPhoto", "sendMessage"]);
  eq(r.sent, 1);
});

Deno.test("cards: a long list pages 5 at a time with a Next button that sends the next page and then stops", async () => {
  const t = fakeTelegram(), m = memStore({ postings: [1, 2, 3, 4, 5, 6, 7].map((n) => row(n)) }), log = { answered: [] as any[] };
  const d = deps(m, log);
  const r = await sendJobCards({ userId: U, hits: [1, 2, 3, 4, 5, 6, 7].map((n) => hit(n)), deps: d, send: t.send });
  eq([r.sent, r.total], [5, 7]);
  const lastCard = t.calls.at(-1)!;
  eq(lastCard.body.reply_markup.inline_keyboard[0].length, 3, "Apply / Details / Save stay");
  const next = lastCard.body.reply_markup.inline_keyboard[1][0];
  eq(next.text, "Next 2 of 2 more");
  assert(t.calls.slice(0, -1).every((c) => c.body.reply_markup.inline_keyboard.length === 1), "Next rides only on the last card, in its own keyboard, not as another bubble");
  t.calls.length = 0;
  const res = await tapJob({ userId: U, data: next.callback_data, messageId: "1", deps: d, send: t.send });
  eq(res.status, "next");
  eq(t.calls.filter((c) => c.method === "sendPhoto").length, 2);
  assert(!t.calls.some((c) => JSON.stringify(c.body.reply_markup ?? {}).includes("jcn:")), "no Next after the last page");
});

Deno.test("details: a text card grows in place; a photo card gets the requirements as a reply under it; nothing is applied", async () => {
  const m = memStore({ postings: [row(1, { company_domain: null }), row(4)] }), log = { answered: [] as any[] };
  const d = deps(m, log);
  const t1 = fakeTelegram();
  await sendJobCards({ userId: U, hits: [hit(1)], deps: d, send: t1.send });
  const ref1 = await refOf(U, "greenhouse:acme:1");
  t1.calls.length = 0;
  await tapJob({ userId: U, data: `jcd:${ref1}`, messageId: "77", deps: d, send: t1.send });
  eq(t1.calls.map((c) => c.method), ["editMessageText"]);
  assert(t1.calls[0].body.message_id === 77 && t1.calls[0].body.text.includes("Requirements:") && t1.calls[0].body.text.includes("3 years of SQL"));
  const t2 = fakeTelegram();
  await sendJobCards({ userId: U, hits: [hit(4)], deps: d, send: t2.send });
  const ref4 = await refOf(U, "greenhouse:acme:4");
  t2.calls.length = 0;
  await tapJob({ userId: U, data: `jcd:${ref4}`, messageId: "88", deps: d, send: t2.send });
  eq(t2.calls.map((c) => c.method), ["sendMessage"]);
  assert(t2.calls[0].body.text.includes("3 years of SQL") && t2.calls[0].body.reply_markup);
  eq(log.answered, []);
});

Deno.test("save: once, then 'already saved'", async () => {
  const t = fakeTelegram(), m = memStore({ postings: [row(1)] }), log = { answered: [] as any[] }, d = deps(m, log);
  await sendJobCards({ userId: U, hits: [hit(1)], deps: d, send: t.send });
  const ref = await refOf(U, "greenhouse:acme:1");
  eq((await tapJob({ userId: U, data: `jcs:${ref}`, messageId: "1", deps: d, send: t.send })).status, "saved");
  eq((await tapJob({ userId: U, data: `jcs:${ref}`, messageId: "1", deps: d, send: t.send })).status, "already");
});

Deno.test("apply with no prepared application: queued to be prepared, and the message says queued, in plain words; nothing opened or approved", async () => {
  const t = fakeTelegram(), m = memStore({ postings: [row(1)] }), log = { answered: [] as any[] }, opened: string[] = [];
  const d = deps(m, log, { opened });
  await sendJobCards({ userId: U, hits: [hit(1)], deps: d, send: t.send });
  const ref = await refOf(U, "greenhouse:acme:1");
  t.calls.length = 0;
  const r = await tapJob({ userId: U, data: `jca:${ref}`, messageId: "1", deps: d, send: t.send });
  eq(r.status, "queued_unprepared");
  eq(m.log.wants, ["greenhouse:acme:1"]);
  const said = t.calls.map((c) => c.body.text).join("\n");
  assert(/^Queued:/.test(said) && /haven't started it yet/.test(said) && !/worker|applied/i.test(said) && !/submitted|sent to/i.test(said.replace("nothing has gone to the employer", "")), said);
  eq([log.answered, opened], [[], []]);
});

Deno.test("apply with a prepared application shows the EXACT payload with Confirm / Edit / Cancel and approves nothing yet", async () => {
  const t = fakeTelegram(), m = memStore({ postings: [row(1)], prepared: prepared() }), log = { answered: [] as any[] }, opened: string[] = [];
  const d = deps(m, log, { opened });
  await sendJobCards({ userId: U, hits: [hit(1)], deps: d, send: t.send });
  const ref = await refOf(U, "greenhouse:acme:1");
  t.calls.length = 0;
  const r = await tapJob({ userId: U, data: `jca:${ref}`, messageId: "1", deps: d, send: t.send });
  eq(r.status, "shown");
  const msg = t.calls.at(-1)!.body;
  for (const want of ["Data Analyst 1 at Acme", "Link: https://boards.greenhouse.io/acme/jobs/1", "ada-resume.pdf", "ffffffffffff", "Cover note: I built the pricing model at my last job.", "• First name: Ada", "• Authorized to work in the US?: Yes"]) assert(msg.text.includes(want), `payload shows "${want}":\n${msg.text}`);
  assert(!msg.text.includes("Empty:"), "unanswered fields are not shown as answers");
  eq(msg.reply_markup.inline_keyboard, [[{ text: "Confirm", callback_data: `jcy:${ref}:${H.slice(0, 16)}` }, { text: "Edit", callback_data: `jce:${ref}` }, { text: "Cancel", callback_data: `jcx:${ref}` }]]);
  eq([log.answered, opened], [[], []], "no approval, no card opened, before Confirm");
});

Deno.test("confirm: the button's hash tag must match the payload on file now; a changed payload is refused and nothing is approved", async () => {
  const t = fakeTelegram(), m = memStore({ postings: [row(1)], prepared: prepared(H) }), log = { answered: [] as any[] }, opened: string[] = [];
  const d = deps(m, log, { opened, hash: () => (m as any).cur ?? H });
  await sendJobCards({ userId: U, hits: [hit(1)], deps: d, send: t.send });
  const ref = await refOf(U, "greenhouse:acme:1");
  const oldTag = hashTag(H);
  m.setPrepared(prepared(H2)); // the payload changed after it was shown
  t.calls.length = 0;
  const r = await tapJob({ userId: U, data: `jcy:${ref}:${oldTag}`, messageId: "1", deps: d, send: t.send });
  eq(r.status, "changed");
  eq([log.answered, opened], [[], []]);
  assert(/changed after I showed it, so nothing was approved/.test(t.calls[0].body.text));
});

Deno.test("confirm: with the matching tag it opens the one-item card and approves exactly it through the card path; the reply says queued, not submitted yet", async () => {
  const t = fakeTelegram(), m = memStore({ postings: [row(1)], prepared: prepared(H) }), log = { answered: [] as any[] }, opened: string[] = [];
  const d = deps(m, log, { opened });
  await sendJobCards({ userId: U, hits: [hit(1)], deps: d, send: t.send });
  const ref = await refOf(U, "greenhouse:acme:1");
  t.calls.length = 0;
  const r = await tapJob({ userId: U, data: `jcy:${ref}:${hashTag(H)}`, messageId: "1", deps: d, send: t.send });
  eq(r.status, "confirmed");
  eq(opened, [PID]);
  eq(log.answered, [{ card: CARD, approve: [1] }]);
  const said = t.calls.at(-1)!.body.text;
  assert(/^Approved:/.test(said) && /Queued, not submitted yet/.test(said) && !/applied/i.test(said), said);
});

Deno.test("no apply without Confirm: Apply, Details, Save, Edit and Cancel never answer a card", async () => {
  const t = fakeTelegram(), m = memStore({ postings: [row(1)], prepared: prepared() }), log = { answered: [] as any[] }, opened: string[] = [];
  const d = deps(m, log, { opened });
  await sendJobCards({ userId: U, hits: [hit(1)], deps: d, send: t.send });
  const ref = await refOf(U, "greenhouse:acme:1");
  for (const op of ["a", "d", "s", "e", "x"]) await tapJob({ userId: U, data: `jc${op}:${ref}`, messageId: "1", deps: d, send: t.send });
  eq([log.answered, opened], [[], []]);
});

Deno.test("exact duplicate is the only block; LinkedIn, Indeed and Handshake are never automated", async () => {
  const t = fakeTelegram(), log = { answered: [] as any[] };
  const dup = memStore({ postings: [row(1)], prepared: prepared(), applied: true }), d = deps(dup, log);
  await sendJobCards({ userId: U, hits: [hit(1)], deps: d, send: t.send });
  const ref = await refOf(U, "greenhouse:acme:1");
  eq((await tapJob({ userId: U, data: `jca:${ref}`, messageId: "1", deps: d, send: t.send })).status, "duplicate");
  eq((await tapJob({ userId: U, data: `jcy:${ref}:${hashTag(H)}`, messageId: "1", deps: d, send: t.send })).status, "duplicate");
  eq(log.answered, []);
  // a second posting at the same company is NOT blocked (no company-per-30-days rule)
  const ok = memStore({ postings: [row(2)] });
  const d2 = deps(ok, log);
  await sendJobCards({ userId: U, hits: [hit(2)], deps: d2, send: t.send });
  eq((await tapJob({ userId: U, data: `jca:${await refOf(U, "greenhouse:acme:2")}`, messageId: "1", deps: d2, send: t.send })).status, "queued_unprepared");
  for (const url of ["https://www.linkedin.com/jobs/view/1", "https://www.indeed.com/viewjob?jk=1", "https://app.joinhandshake.com/jobs/1"]) {
    const m = memStore({ postings: [] }), dd = deps(m, log);
    await sendJobCards({ userId: U, hits: [hit(9, { url })], deps: dd, send: t.send });
    const r = await tapJob({ userId: U, data: `jca:${await refOf(U, "greenhouse:acme:9")}`, messageId: "1", deps: dd, send: t.send });
    eq([r.status, m.log.wants], ["never_automated", []]);
  }
});

Deno.test("isolation: another person's button reference finds nothing and does nothing", async () => {
  const t = fakeTelegram(), m = memStore({ postings: [row(1)], prepared: prepared() }), log = { answered: [] as any[] }, d = deps(m, log);
  await sendJobCards({ userId: U, hits: [hit(1)], deps: d, send: t.send });
  const ref = await refOf(U, "greenhouse:acme:1");
  t.calls.length = 0;
  const r = await tapJob({ userId: V, data: `jcy:${ref}:${hashTag(H)}`, messageId: "1", deps: d, send: t.send });
  eq(r.status, "gone");
  eq(log.answered, []);
  eq(parseJobTap("jcy:zzzz"), null);
  eq(parseJobTap(`jcy:${ref}:${hashTag(H)}`), { op: "confirm", ref, tag: hashTag(H) });
  assert(confirmButtons(ref, hashTag(H))[0].length === 3 && payloadLines(prepared(), null).length > 5);
});

// ---- phone login through the real inbound core
Deno.test("parse: a shared contact is the person's own only when contact.user_id is the sender; someone else's card is not a login", () => {
  const own = parseTelegramUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 42, type: "private" }, from: { id: 42 }, contact: { phone_number: "1 (512) 555-0100", user_id: 42, first_name: "Ada" } } });
  eq([own.message?.sharedPhone, own.message?.phone], ["own", "+15125550100"]);
  const other = parseTelegramUpdate({ update_id: 2, message: { message_id: 1, chat: { id: 42, type: "private" }, from: { id: 42 }, contact: { phone_number: "15125550199", user_id: 7 } } });
  eq([other.message?.sharedPhone, other.message?.phone], ["other", undefined]);
});

Deno.test("phone login: the share button is a request_contact keyboard; an own number asks the linked channel (no merge); someone else's card links nothing", async () => {
  const t = fakeTelegram();
  const asked: any[] = [];
  const store: any = {
    async claimMessage() { return true; }, async person() { return null; }, async sawInbound() {}, async refusedBefore() { return false; },
    async linkCandidate(phone: string) { return phone === "+15125550100" ? { userId: U, contact: "+15125550100" } : null; },
    async askToLink(a: any) { asked.push(a); return "link:key"; },
  };
  const d: CoreDeps = { env: { get: () => undefined }, now: () => NOW, store, render: (x) => [x], chat: async () => { throw new Error("no turn"); }, deliver: async () => {},
    reply: async (contact, bubbles, opts) => t.adapter.send(contact.slice(3), bubbles, opts) };
  const msg = (u: any) => parseTelegramUpdate(u).message!;
  const own = await runInbound(msg({ update_id: 5, message: { message_id: 1, chat: { id: 42, type: "private" }, from: { id: 42 }, contact: { phone_number: "+15125550100", user_id: 42 } } }), d);
  eq(own.body.link, "asked");
  eq(asked.length, 1);
  eq(asked[0].phone, "+15125550100");
  const other = await runInbound(msg({ update_id: 6, message: { message_id: 2, chat: { id: 42, type: "private" }, from: { id: 42 }, contact: { phone_number: "+15125550100", user_id: 9 } } }), d);
  eq(other.body.phone, "not_own");
  eq(asked.length, 1, "someone else's card asks nothing");
  const kb = t.calls.at(-1)!.body.reply_markup;
  eq(kb.keyboard, [[{ text: SHARE_PHONE_BUTTON, request_contact: true }]]);
  assert(!/password|code/i.test(t.calls.map((c) => c.body.text).join(" ").replace(/no password or code|neither in chat|nor a code|either in chat/gi, "")), "never asks for a password or a code");
});

Deno.test("inbound: a turn's postings become cards after the reply; a tap goes to the job handler, never the card-approval path", async () => {
  const t = fakeTelegram();
  const shown: any[] = [], taps: string[] = [], cb: string[] = [];
  const person = { userId: U, threadId: "th", contact: "tg:42" };
  const store: any = { async claimMessage() { return true; }, async person() { return person; }, async sawInbound() {}, async setOptOut() {}, async setThread() {}, async enqueueReply() { return true; } };
  const d: CoreDeps = { env: { get: () => undefined }, now: () => NOW, store, render: (x) => [x], deliver: async () => {}, reply: async () => ({ ok: true }),
    chat: async () => ({ status: 200, reply: "Here are 2 roles.", threadId: "th", postings: [hit(1), hit(2)] }),
    showPostings: async (a) => { shown.push(a.hits.length); return { sent: 2, total: 2 }; },
    jobTap: async (a) => { taps.push(a.data); return { toast: "ok", status: "shown" }; },
    cardTap: async () => { throw new Error("must not be called for a job button"); }, answerCallback: async (_id, text) => { cb.push(text); return true; } };
  const r1 = await runInbound(parseTelegramUpdate({ update_id: 8, message: { message_id: 1, chat: { id: 42, type: "private" }, from: { id: 42 }, text: "find data analyst jobs" } }).message!, d);
  eq([shown, r1.body.cards], [[2], 2]);
  const ref = await refOf(U, "greenhouse:acme:1");
  const r2 = await runInbound(parseTelegramUpdate({ update_id: 9, callback_query: { id: "c1", from: { id: 42 }, data: `jca:${ref}`, message: { message_id: 5, chat: { id: 42, type: "private" } } } }).message!, d);
  eq([taps, r2.body.jobTap, cb], [[`jca:${ref}`], "shown", ["ok"]]);
  void t;
});
