// WO-091c: the person's control state reaches what Trainee does on its own, and the owner's send switch holds.
//   C1 apply-by-email sends only with CAREER_EMAIL_SEND=on; off, the yes is told so, the card is kept, nothing is reserved.
//   C2 an outreach approval lasts 7 days; a paused or opted-out account sends nothing.
//   C3 one person's (or one rail's) failure never stops the scheduled run for anyone else; the run row's counts are true.
//   C4 pause/STOP/erase reach the scheduled layer: no alerts planned, no card or question pushed, no mail read, and a
//      queued text Trainee started is not delivered while the person is paused.
//   C5 the alerts run writes only its own counters: a "stop my alerts" that lands mid-run stays stopped.
//   C6 "cancel", "end" and "quit" are words for the brain on iMessage, WhatsApp and Telegram; STOP still opts out.
// Each was a passing audit repro on trunk (proactive F1, F2, F4, F5, F6; channels F1), inverted here.
// Run: deno test -A --no-check tests/edge/control-state.test.ts
import { EMAIL_INTENT, type EmailCard, type EmailPayload, type EmailStore, emailTurn } from "../../supabase/functions/_shared/career_apply_email.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { footerOf, memoryOutreachStore, messageOf, payloadHash, runOutreachSends } from "../../supabase/functions/_shared/career_outreach.ts";
import { memoryAlertStore, startWatching, validPrefs } from "../../supabase/functions/_shared/career_alert_store.ts";
import { runAlerts } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { memoryMailStore } from "../../supabase/functions/_shared/career_mail_store.ts";
import { handleProactive } from "../../supabase/functions/career-proactive/handler.ts";
import { channelCommand, CHANNEL_REPLIES, type ChannelStore, deliverDue, type OutboxRow } from "../../supabase/functions/_shared/channel.ts";
import { memoryChannelWorld } from "../../supabase/functions/_shared/channel_memory.ts";
import { runInbound } from "../../supabase/functions/_shared/channel_inbound.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const iso = (t: number) => new Date(t).toISOString();
const DAY = 86400000;
const ROOT = new URL("../../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, ROOT));

// ------------------------------------------------------------------------------------------------ C1 apply by email
async function emailWorld(sendOn: boolean | undefined) {
  const NOW = Date.UTC(2026, 9, 20, 15);
  const payload: EmailPayload = {
    kind: "email", version: 1, user_id: "U1", job_id: "lever:acme:1", company: "Acme Retail", title: "Data Analyst", url: "https://acme.example/jobs/1",
    to: "jobs@acme.example", subject: "Application: Data Analyst", body: "Hello Acme Retail hiring team,\n\nA short note.\n\nTest Person",
    attachment: { filename: "resume.pdf", sha256: "a".repeat(64), size: 10, tailored: false }, resume_sha256: "a".repeat(64), resume_tailored: false,
  };
  let card: EmailCard = { id: "C1", payload, payload_hash: await hashApplyPayload(payload), state: "shown", shown_at: iso(NOW - 60000), thread: "T1" };
  const calls = { reserve: 0, send: 0, canSend: 0, attachment: 0 };
  const store: EmailStore = {
    async postings() { return []; },
    async card() { return JSON.parse(JSON.stringify(card)); },
    async setCard(_u, c) { card = JSON.parse(JSON.stringify(c)); },
    async lastAssistant() { return { intent: EMAIL_INTENT, meta: { email_card: "C1" } }; },
    async reserve() { calls.reserve++; return { id: "J1", lease_token: "L" }; },
    async finish() {},
  };
  const yes = () => emailTurn({ message: "yes", userId: "U1", threadId: "T1", now: NOW, deps: {
    store, profile: () => ({}), resume: async () => null,
    attachment: async () => { calls.attachment++; return null; },
    canSend: async () => { calls.canSend++; return true; },
    send: async () => { calls.send++; return { status: "sent", idHash: "b".repeat(64) } as any; },
    ...(sendOn === undefined ? {} : { sendOn }),
  } });
  return { yes, calls, card: () => card };
}

Deno.test("WO-091c/C1 apply by email: with the owner's switch off, a yes sends nothing, reserves nothing, keeps the card and says so", async () => {
  const w = await emailWorld(false);
  const r = await w.yes();
  assert(r, "the yes is answered by the email turn");
  eq([w.calls.send, w.calls.reserve, w.calls.canSend, w.calls.attachment], [0, 0, 0, 0], "no send, no reservation, not even the Gmail token is read");
  eq([r.waiting, r.card_id, w.card().state], [true, "C1", "shown"], "the drafted email stays on the card");
  assert(/not switched on/i.test(r.reply) && /nothing (was|went|is) sent|not sent/i.test(r.reply), r.reply);
});

Deno.test("WO-091c/C1b the chat wires apply-by-email's send to CAREER_EMAIL_SEND=on, the same pattern as outreach", () => {
  const src = read("supabase/functions/agent-chat/handler-career.ts");
  // D-037: CAREER_EMAIL_SEND is a release flag, read through the release config (on unless rolled back with "off").
  assert(/sendOn:\s*chatSwitches\(Deno\.env\)\.emailSend,/.test(src), "emailTurn gets sendOn from the release flag CAREER_EMAIL_SEND");
  const docs = read("docs/launch/TRAINEE-GO-LIVE.md") + read("docs/product/TONIGHT-TEST-PLAN.md");
  assert(docs.includes("CAREER_EMAIL_SEND"), "the switch is documented where the owner turns things on");
});

// ------------------------------------------------------------------------------------------------ C2 outreach approvals
async function approvedDraft(store: ReturnType<typeof memoryOutreachStore>, u: string, i: number, at: number) {
  const d: any = { n: 1, recipient: { name: `R${i}`, firm: "Acme", title: "VP", school: "", email: `r${i}@acme.example`, source: "list" },
    subject: "Hello", body: "Hi there.", footer: footerOf("Sam"), hash: "", status: "shown", approved_hash: null, approved_at: null, sent_at: null,
    gmail_id: null, gmail_thread: null, result: null, created_at: iso(at) };
  d.hash = await payloadHash(messageOf(d));
  const [saved] = await store.saveBatch(u, `th-${u}`, [d], at);
  await store.update(u, { ...saved, status: "approved", approved_hash: saved.hash, approved_at: iso(at) }, { status: "shown" });
  return saved;
}
const gmail = () => { const sent: string[] = []; return { sent, send: async (_u: string, m: any) => { sent.push(m.to); return { status: "sent" as const, id: "g", thread_id: "t" }; } }; };

Deno.test("WO-091c/C2 an outreach approval older than 7 days is never sent: refused as expired and dropped", async () => {
  const T0 = Date.UTC(2026, 5, 1, 15), T = T0 + 120 * DAY;
  const s = memoryOutreachStore();
  await approvedDraft(s, "u1", 1, T0);
  // Months without a Gmail send grant: NOT_WIRED, back to approved each run.
  await runOutreachSends({ store: s, sender: { send: async () => ({ status: "NOT_WIRED", reason: "no grant" }) }, now: T0 + 3600000 });
  const g = gmail();
  const st = await runOutreachSends({ store: s, sender: g, now: T });
  eq([st.sent, st.refused.expired, g.sent.length], [0, 1, 0], JSON.stringify(st));
  eq((await s.latestBatch("u1"))[0].status, "skipped", "an expired approval is dropped, never retried");
  // Six days is still inside the approval's life.
  const s2 = memoryOutreachStore(), g2 = gmail();
  await approvedDraft(s2, "u2", 2, T - 6 * DAY);
  eq((await runOutreachSends({ store: s2, sender: g2, now: T })).sent, 1);
});

Deno.test("WO-091c/C2b a paused or opted-out account's approved outreach waits: refused as paused, nothing sent", async () => {
  const T = Date.UTC(2026, 9, 20, 15);
  const s = memoryOutreachStore(), g = gmail();
  await approvedDraft(s, "u1", 1, T - DAY);
  (s as any).setQuiet("u1", true);
  const st = await runOutreachSends({ store: s, sender: g, now: T });
  eq([st.sent, st.refused.paused, g.sent.length], [0, 1, 0], JSON.stringify(st));
  eq((await s.latestBatch("u1"))[0].status, "approved", "a pause holds it; resuming within the 7 days lets it go");
  (s as any).setQuiet("u1", false);
  eq((await runOutreachSends({ store: s, sender: g, now: T + 120000 })).sent, 1);
});

Deno.test("WO-091c/C2c the database claim carries the same two refusals, in a new migration listed for go-live", () => {
  const files = [...Deno.readDirSync(new URL("supabase/migrations/", ROOT))].map((f) => f.name).filter((n) => n.endsWith(".sql")).sort();
  const last = files.filter((n) => read(`supabase/migrations/${n}`).includes("function public.career_outreach_claim(")).at(-1)!;
  assert(last !== "20261021010000_career_outreach.sql", "a new migration redefines the claim (an applied migration is never edited)");
  const sql = read(`supabase/migrations/${last}`);
  assert(/return 'expired'/.test(sql) && /interval '7 days'/.test(sql), "expired after 7 days");
  assert(/return 'paused'/.test(sql) && /career_user_quiet\(p_user\)/.test(sql), "paused or opted out");
  const golive = read("scripts/launch/trainee-go-live.sh");
  assert(golive.includes(last), "go-live applies it");
});

// ------------------------------------------------------------------------------------------------ C3 one failure, one rail
const SECRET = "x".repeat(40);
const req = () => new Request("https://x/career-proactive", { method: "POST", headers: { "x-trainee-proactive-secret": SECRET } });
const prefs = (p: Record<string, unknown> = {}) => { const v = validPrefs({ keywords: ["data analyst"], ...p }); if (!v.ok) throw new Error(v.error); return v.prefs; };
// SERIAL-1530: open remote fixture; a country-limited remote posting is held for a person with no location on record.
const posting = (id: string, at: number) => ({ job_id: `lever:acme:${id}`, title: "Data Analyst", company: "Acme", location: "Remote", url: `https://jobs.lever.co/acme/${id}`, first_seen_at: iso(at), closed_at: null });

Deno.test("WO-091c/C3 one person's Gmail error does not stop outreach, asks or questions for anyone; the run row is true", async () => {
  const T = Date.UTC(2026, 9, 20, 15);
  const store = memoryAlertStore();
  await store.save(startWatching(null, { userId: "alice", prefs: prefs(), tz: "America/New_York", now: T - 600000 }));
  const mail = memoryMailStore({ people: [{ user_id: "bob", read_through: null }, { user_id: "carol", read_through: null }] } as any);
  const calls: string[] = [], recorded: any[] = [], read: string[] = [];
  const res = await handleProactive(req(), {
    env: { get: (k: string) => (k === "CAREER_PROACTIVE_SECRET" ? SECRET : undefined) }, now: () => T,
    store: () => store, recentPostings: async () => [posting("1", T - 60000)], postingsById: async () => [],
    mail: { store: () => mail, read: async (u: string) => { read.push(u); return u === "bob" ? { status: "ERROR", detail: "list messages: HTTP 403", mails: [], readThrough: null, listed: 0 } : { status: "ok", mails: [], readThrough: T, listed: 0 }; } },
    asks: () => ({ pending: async () => { calls.push("asks"); return []; }, push: async () => false }),
    questions: { open: async () => { calls.push("questions"); return []; }, push: async () => false },
    outreach: async () => { calls.push("outreach"); return {}; },
    recordRun: async (r: any) => { recorded.push(r); },
  } as any);
  eq(store.dump().outbox.length, 1, "alice's alert was queued");
  eq(calls.sort(), ["asks", "outreach", "questions"], "every later rail still ran");
  eq(read.sort(), ["bob", "carol"], "carol's mail was read too");
  eq([recorded.length, recorded[0].users, recorded[0].alerts], [1, 1, 1], "the run row carries what happened");
  assert(/HTTP 403/.test(recorded[0].error ?? ""), `the failure is recorded: ${recorded[0].error}`);
  assert(recorded[0].errors && /HTTP 403/.test(recorded[0].errors.mail), JSON.stringify(recorded[0].errors));
  const body = await res.json();
  eq(body.alerts, 1);
});

Deno.test("WO-091c/C3b inside the alerts rail, one person's failed save does not stop the next person's alerts", async () => {
  const T = Date.UTC(2026, 9, 20, 15);
  const inner = memoryAlertStore();
  for (const u of ["a1", "a2"]) await inner.save(startWatching(null, { userId: u, prefs: prefs(), tz: "America/New_York", now: T - 600000 }));
  const store: any = { ...inner, async enqueue(u: string, m: any) { if (u === "a1") throw new Error("queue an alert: timeout"); return inner.enqueue(u, m); } };
  let err: any = null;
  try { await runAlerts({ store, outbox: store, now: T, recentPostings: async () => [posting("1", T - 60000)], postingsById: async () => [] }); } catch (e) { err = e; }
  eq(inner.dump().outbox.map((o) => o.userId), ["a2"], "a2 still got the alert");
  assert(err && /1 people/.test(err.message) && err.partial?.alerts === 1, `the failure is reported with what was done: ${err?.message} ${JSON.stringify(err?.partial)}`);
});

// ------------------------------------------------------------------------------------------------ C4 pause reaches the schedule
Deno.test("WO-091c/C4 a paused, opted-out or erased person gets no alerts planned, no card, no question, no ask, and no mail read", async () => {
  const T = Date.UTC(2026, 9, 20, 15);
  const store = memoryAlertStore();
  for (const u of ["paused", "live"]) await store.save(startWatching(null, { userId: u, prefs: prefs(), tz: "America/New_York", now: T - 600000 }));
  const mail = memoryMailStore({ people: [{ user_id: "paused", read_through: null }, { user_id: "live", read_through: null }] } as any);
  const pushed: string[] = [], read: string[] = [], asked: string[] = [];
  const old = iso(T - 3600000);
  await handleProactive(req(), {
    env: { get: (k: string) => (k === "CAREER_PROACTIVE_SECRET" ? SECRET : undefined) }, now: () => T,
    store: () => store, recentPostings: async () => [posting("1", T - 60000)], postingsById: async () => [],
    quiet: async (ids: string[]) => new Set(ids.filter((u) => u === "paused")),
    readyApplications: async () => ["paused", "live"].map((u) => ({ id: `p-${u}`, user_id: u, company: "Acme", card_lines: ["Data Analyst at Acme"], created_at: old, tz: "America/New_York" })),
    pushCard: async (u: string) => { pushed.push(`card:${u}`); return "k"; },
    mail: { store: () => mail, read: async (u: string) => { read.push(u); return { status: "ok", mails: [], readThrough: T, listed: 0 }; } },
    asks: () => ({ pending: async () => ["paused", "live"].map((u) => ({ user_id: u, hash: `h-${u}`, text: "Which application?", tz: "America/New_York" })), push: async (u: string) => { asked.push(u); return true; } }),
    questions: { open: async () => ["paused", "live"].map((u) => ({ id: `q-${u}`, user_id: u, key: "k", kind: "choice", label: "Are you 18 or older?", type: "radio", options: ["Yes", "No"], company: "Acme", job_ids: [], created_at: old, tz: "America/New_York" })),
      push: async (u: string) => { pushed.push(`questions:${u}`); return true; } },
    recordRun: async () => {},
  } as any);
  eq(store.dump().outbox.map((o) => o.userId), ["live"], "alerts are planned only for the person who is not paused");
  assert(!pushed.some((p) => p.endsWith(":paused")), `nothing pushed to the paused person: ${pushed}`);
  assert(pushed.includes("card:live") || pushed.includes("questions:live"), `the live person still gets theirs: ${pushed}`);
  eq(read, ["live"], "the paused person's mail is not read");
  eq(asked, ["live"]);
});

Deno.test("WO-091c/C4b a text Trainee queued is not delivered once the person is paused; an answer to their own message still is", async () => {
  const NOW = Date.UTC(2026, 9, 20, 15);
  const rows: (OutboxRow & { status?: string; error?: string })[] = [
    { id: "1", userId: "u1", contact: "+15550001111", key: "alert:lever:acme:1", text: "New match", deliver_at: NOW - 1000, attempts: 0 },
    { id: "2", userId: "u1", contact: "+15550001111", key: "reply:m1", text: "Career work is paused.", deliver_at: NOW - 500, attempts: 0 },
  ];
  const sent: string[] = [];
  const store: ChannelStore & { quiet(u: string): Promise<boolean> } = {
    async due() { return rows.filter((r) => !r.status).map((r) => ({ ...r })); },
    async optedOut() { return false; },
    async quiet(u) { return u === "u1"; },
    async setOptOut() {},
    async contactsSentOn() { return 0; },
    async sentTo() { return false; },
    async mark(id, m) { const r = rows.find((x) => x.id === id)!; r.status = m.status; r.error = m.error; },
  };
  const r = await deliverDue({ store, send: async (_c, b) => { sent.push(b.join(" ")); return { ok: true, id: "p" }; }, now: NOW });
  eq(sent, ["Career work is paused."], "only the answer goes");
  eq(rows.map((x) => x.status), ["skipped_opt_out", "delivered"]);
  assert(/paused/.test(rows[0].error ?? ""), `the skip says why: ${rows[0].error}`);
  eq(r.skipped_opt_out, 1);
});

// ------------------------------------------------------------------------------------------------ C5 lost update
Deno.test("WO-091c/C5 'stop my alerts' during a run stays stopped: the run writes its counters, never the settings", async () => {
  const T = Date.UTC(2026, 9, 20, 15);
  const inner = memoryAlertStore();
  await inner.save(startWatching(null, { userId: "u1", prefs: prefs(), tz: "America/New_York", now: T - 600000 }));
  const store: any = {
    ...inner,
    async active() {
      const rows = await inner.active();
      const r = (await inner.get("u1"))!; await inner.save({ ...r, prefs: { ...r.prefs, on: false } }); // stop_job_alerts, mid-run
      return rows;
    },
  };
  await runAlerts({ store, outbox: store, now: T, recentPostings: async () => [posting("1", T - 60000)], postingsById: async () => [] });
  const after = (await inner.get("u1"))!;
  eq(after.prefs.on, false, "alerts stay off");
  eq(after.last_checked_at, iso(T), "the run's own counters are still saved");
});

// ------------------------------------------------------------------------------------------------ C6 cancel / end / quit
const T0 = Date.parse("2026-10-20T12:00:00Z");
const tgMsg = (id: number, text: string, extra: Record<string, unknown> = {}) => ({ provider: "telegram", channel: "telegram", messageId: String(id), kind: "text", contact: "tg:5551", address: "5551", text, ...extra });
function core(world: ReturnType<typeof memoryChannelWorld>) {
  const chats: string[] = [], replies: string[] = [];
  const adapter = telegramAdapter({ token: "t", fetch: (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))) as typeof fetch, sleep: async () => {} });
  const d = {
    env: { get: (k: string) => ({ TRAINEE_SIGNUP: "open" } as Record<string, string>)[k] }, now: () => T0, store: world.inbound, render: adapter.render,
    chat: async (a: any) => { chats.push(a.message); return { status: 200, reply: "ok", threadId: "th1" }; },
    reply: async (_c: string, b: string[]) => { replies.push(b.join("\n")); return { ok: true }; },
    deliver: async () => {},
  };
  return { d, chats, replies };
}

Deno.test("WO-091c/C6 'cancel', 'End.' and 'quit' on Telegram reach the brain and opt nobody out; STOP and /stop still do", async () => {
  const world = memoryChannelWorld();
  const { d, chats, replies } = core(world);
  await runInbound(tgMsg(1, "hi") as any, d as any);
  for (const [i, w] of ["cancel", "End.", "quit"].entries()) await runInbound(tgMsg(10 + i, w) as any, d as any);
  eq(chats, ["hi", "cancel", "End.", "quit"], "each word is a message for the brain");
  eq(replies.filter((r) => r === CHANNEL_REPLIES.stop).length, 0);
  eq(world.contacts.get("tg:5551")!.optedOut, false);
  await runInbound(tgMsg(20, "STOP") as any, d as any);
  eq(world.contacts.get("tg:5551")!.optedOut, true, "STOP in any case still opts out");
  await runInbound(tgMsg(21, "/start", { command: "start", text: "" }) as any, d as any);
  await runInbound(tgMsg(22, "/stop", { command: "stop", text: "" }) as any, d as any);
  eq(world.contacts.get("tg:5551")!.optedOut, true, "Telegram's /stop still opts out");
});

Deno.test("WO-091c/C6b the carrier keyword set (CANCEL, END, QUIT) stays only where a channel may be SMS", () => {
  for (const ch of ["imessage", "whatsapp", "telegram"] as const) {
    for (const s of ["cancel", "END", "quit!"]) eq(channelCommand(s, ch), null, `${s} on ${ch}`);
    for (const s of ["STOP", "stop", "Stop.", "STOPALL", "unsubscribe"]) eq(channelCommand(s, ch), "stop", `${s} on ${ch}`);
  }
  for (const s of ["Cancel", "END", "quit!", "STOP"]) eq(channelCommand(s, "sms"), "stop", `${s} on SMS`);
  eq(channelCommand("Cancel"), "stop", "with no channel named (the WO-013a simulator), the full carrier list holds");
});
