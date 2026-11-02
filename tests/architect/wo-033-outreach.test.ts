// WO-033: contact lists, outreach drafted per person from real facts, approved in batches of 10 by one reply, sent from
// the person's own Gmail with no volume number of Trainee's own (NO LIMITS, owner 2026-10-27; only Gmail's refusal slows it), every step on the timeline, and the referral map from the
// person's own exports. Synthetic data, a scripted model, fake Gmail and DNS. Run: deno test -A --no-check tests/architect/
import { engineAware, seedFacts } from "./personal-fixture.ts";
import {
  checkAddress, contactsOf, hunterPass, hunterVerifier, importContactsCsv, importContactsFile, listCost, listReport, mapHunter, memoryCheckCache,
  MX_NOT_WIRED, type MxResolver, normalizeFirm, vendorSource, verifyRows,
} from "../../supabase/functions/_shared/career_contacts.ts";
import {
  admitSend, batchMessages, BATCH_FOOT, classifyReply, draftFor, emailHash, memoryOutreachStore, messageOf, OPT_OUT_LINE, OUTREACH_INTENT,
  type OutreachDraft, outreachLock, outreachTurn, parseOutreachReply, payloadHash, recordReply, runOutreachSends, type Sender, sharedFacts,
} from "../../supabase/functions/_shared/career_outreach.ts";
import { buildRaw, careerTokenFor, gmailSender, GMAIL_SEND_SCOPE } from "../../supabase/functions/_shared/career_outreach_gmail.ts";
import { REFERRAL_ASK, referralMap, targetFirms } from "../../supabase/functions/_shared/career_referrals.ts";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { memoryEventStore } from "../../supabase/functions/_shared/agent/timeline.ts";
import APOLLO from "../fixtures/wo-033/apollo-export.csv" with { type: "text" };
import LINKEDIN from "../fixtures/wo-033/linkedin-connections.csv" with { type: "text" };
import SRC_CONTACTS from "../../supabase/functions/_shared/career_contacts.ts" with { type: "text" };
import SRC_OUTREACH from "../../supabase/functions/_shared/career_outreach.ts" with { type: "text" };
import SRC_GMAIL from "../../supabase/functions/_shared/career_outreach_gmail.ts" with { type: "text" };
import SRC_REFERRALS from "../../supabase/functions/_shared/career_referrals.ts" with { type: "text" };
import SRC_TOOLS from "../../supabase/functions/_shared/agent/career_tools.ts" with { type: "text" };
import SRC_PROACTIVE from "../../supabase/functions/career-proactive/index.ts" with { type: "text" };

function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
async function rejects(f: () => Promise<unknown>, re: RegExp) { try { await f(); } catch (e) { assert(re.test((e as Error).message), `wrong error: ${(e as Error).message}`); return; } throw new Error("did not reject"); }
const byName = (tools: any[]) => Object.fromEntries(tools.map((t) => [t.name, t]));
const U = "TEST-U", TH = "TEST-THREAD";
const OCT14 = Date.parse("2026-10-14T15:00:00Z"); // 11:00 in New York
const MX_OK: MxResolver = async (d) => (d.endsWith(".invalid") ? { status: "none" } : { status: "ok", hosts: [`mx.${d}`] });

// The person's confirmed facts (and one still waiting for their yes, which no draft may use).
const FACTS = [
  { id: "F-001", kind: "education", text: "BS Economics, NYU, Class of 2027", needs_confirmation: false, status: "confirmed" },
  { id: "F-002", kind: "experience", text: "Summer Analyst, Lazard, 2025", needs_confirmation: false, status: "confirmed" },
  { id: "F-003", kind: "experience", text: "Analyst intern at Goldman Sachs", needs_confirmation: true, status: "draft" },
];
// A scripted model: it writes from what the payload lists, and in "invent" mode adds a shared school that is not there.
function scripted(mode: "honest" | "invent" | "invent_once" = "honest") {
  let calls = 0;
  const fn = async (p: any) => {
    calls++;
    const t = String(p.messages[0].content);
    const name = /- name: (.+)/.exec(t)![1].split(" ")[0], firm = /- firm: (.+)/.exec(t)![1];
    const shared = /- same school: (.+)/.exec(t)?.[1];
    const invent = mode === "invent" || (mode === "invent_once" && calls === 1);
    const common = invent ? "As a fellow Wharton alum, I'd value your view." : shared ? `As a fellow ${shared} student, I'd value your view.` : "";
    return { stop_reason: "end_turn", content: [{ type: "text", text: `Subject: Question about your path at ${firm}\n\nHi ${name},\n\nI'm studying economics at NYU, and I interned at Lazard last summer. ${common} Would you have 15 minutes next week to talk about your work at ${firm}?` }] };
  };
  return Object.assign(fn, { calls: () => calls });
}
const recipient = (o: Partial<{ name: string; firm: string; title: string; school: string; email: string }> = {}) =>
  ({ name: "Avery Synthetic", firm: "Goldman Sachs", title: "Investment Banking Analyst", school: "", email: "avery.synthetic@gs.example", source: "apollo-export.csv, row 1", ...o });
// A batch of n approved-ready drafts in the store, for the turn and the caps.
async function batchOf(store: ReturnType<typeof memoryOutreachStore>, n: number, at = OCT14, firm = "Goldman Sachs") {
  const ds = [];
  for (let k = 1; k <= n; k++) {
    const d: any = { n: k, recipient: recipient({ name: `Person ${k} Synthetic`, email: `p${k}.${at}@gs.example`, firm }), subject: `Subject ${k}`, body: `Hi, body ${k}.`, footer: `Sam Student\n\n${OPT_OUT_LINE}`,
      status: "shown", approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date(at).toISOString(), hash: "", shared: [] };
    d.hash = await payloadHash(messageOf(d));
    ds.push(d);
  }
  const saved = await store.saveBatch(U, TH, ds, at);
  store.setIntent(TH, OUTREACH_INTENT);
  return saved;
}
const turn = (store: any, message: string, now = OCT14, extra: Record<string, unknown> = {}) =>
  outreachTurn({ message, userId: U, threadId: TH, now, store, gmailConnected: async () => true, ...extra });
function fakeGmail(): Sender & { sent: { to: string; subject: string; text: string }[] } {
  const sent: any[] = [];
  return { sent, async send(_u, m) { sent.push(m); return { status: "sent", id: `G${sent.length}`, thread_id: `T${sent.length}` }; } };
}

// ------------------------------------------------------------------------------------------------ contacts
Deno.test("WO-033/C1 an Apollo export: mapped by header name, firms normalized, duplicates out, profile URLs never kept, Apollo's status is only its claim", () => {
  const r = importContactsCsv("apollo-export.csv", APOLLO);
  eq([r.vendor, r.rows.length, r.duplicates], ["apollo", 4, 1]);
  eq(r.rows.map((x) => [x.row, x.name, x.firm, x.title, x.email]), [
    [1, "Avery Synthetic", "Goldman Sachs", "Investment Banking Analyst", "avery.synthetic@gs.example"],
    [2, "Blake Fixture", "JPMorgan", "Investment Banking Associate", "blake.fixture@jpm.example"],
    [3, "Casey Sample", "Morgan Stanley", "Vice President", "careers@ms.example"],
    [4, "Drew Testcase", "Citi", "Analyst", "drew.testcase@mailinator.com"],
  ]);
  eq(r.rows.map((x) => x.vendor_email_status), ["Verified", "Verified", "Unverified", "Guessed"]);
  assert(!JSON.stringify(r.rows).includes("linkedin.com"), "no profile URL is kept from any column");
  eq([normalizeFirm("Goldman Sachs & Co. LLC"), normalizeFirm("GS"), normalizeFirm("BofA Securities"), normalizeFirm("Acme Capital, Inc.")], ["Goldman Sachs", "Goldman Sachs", "Bank of America", "Acme Capital"]);
});

Deno.test("WO-033/C2 the person's LinkedIn export: preamble skipped, the URL column dropped, every row numbered", () => {
  const r = importContactsCsv("Connections.csv", LINKEDIN);
  eq([r.vendor, r.rows.map((x) => [x.row, x.name, x.firm, x.connected_on])], [null, [[1, "Jordan Example", "Goldman Sachs", "03 Mar 2025"], [2, "Riley Placeholder", "Lazard", "15 Jun 2025"], [3, "Morgan Dummy", "Evercore", "01 Feb 2024"], [4, "Taylor Mock", "Stripe", "10 Jan 2023"]]]);
  assert(!JSON.stringify(r.rows).includes("linkedin.com"), "the URL column is never kept");
});

Deno.test("WO-033/C3 verification labels never claim a check that did not run", async () => {
  const rows = importContactsCsv("apollo-export.csv", APOLLO).rows;
  // MX not wired (offline): the label checks syntax, role and disposable only, and says MX was not checked.
  const off = listReport(await verifyRows(rows, MX_NOT_WIRED), null);
  assert(!/Checked:[^.]*MX/.test(off.label), off.label);
  assert(off.not_checked.some((x) => /MX/.test(x)) && off.not_checked.some((x) => /Hunter/.test(x)), off.label);
  eq([off.with_email, off.verified, off.hunter.target_85], [4, 2, "not run"], "a role inbox (careers@) and a throwaway domain fail; Apollo's 'Verified' counts for nothing");
  // MX wired: it is named as checked.
  const on = listReport(await verifyRows(rows, MX_OK), 0);
  assert(/Checked: syntax, mail server \(MX\), not a role inbox, not a throwaway domain\./.test(on.label), on.label);
  // MX fails for a domain with no mail server: never verified.
  const bad = await checkAddress("someone@nowhere.invalid", MX_OK);
  eq([bad.check.mx, bad.verified], ["fail", false]);
  const syn = await checkAddress("a@b, c@d.com", MX_OK);
  eq([syn.check.syntax, syn.check.ran, syn.verified], ["fail", ["syntax"], false], "a list in one cell fails syntax; nothing else is claimed");
  // A label from rows with MX run on only some says exactly how many.
  const mixed = listReport([...(await verifyRows(rows.slice(0, 2), MX_OK)), ...(await verifyRows(rows.slice(2), MX_NOT_WIRED))], 0);
  assert(/mail server \(MX\) on 2 of 4/.test(mixed.label), mixed.label);
  assert(/never probes a mailbox over SMTP/.test(on.never));
});

Deno.test("WO-033/C4 Hunter: NOT_WIRED without a key; only 'valid' is deliverable; accept_all apart; 85% over Hunter-checked only; cached per address per month; rate limit", async () => {
  const rows = await verifyRows(importContactsCsv("apollo-export.csv", APOLLO).rows, MX_OK);
  const none = await hunterPass(rows, hunterVerifier({ fetch: (() => { throw new Error("no call without a key"); }) as any, apiKey: undefined, cache: memoryCheckCache(), now: () => OCT14 }));
  eq([none.checked, /not connected/.test(String(none.stopped))], [0, true]);
  const answers: Record<string, string> = { "avery.synthetic@gs.example": "valid", "blake.fixture@jpm.example": "accept_all" };
  const calls: string[] = [];
  let limited = 1;
  const fetchFake = (async (url: string) => {
    calls.push(url);
    assert(url.startsWith("https://api.hunter.io/v2/email-verifier?email="), url);
    if (limited-- > 0) return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    const email = decodeURIComponent(/email=([^&]+)/.exec(url)![1]);
    return new Response(JSON.stringify({ data: { status: answers[email] ?? "unknown", score: 90 } }), { status: 200 });
  }) as any;
  const cache = memoryCheckCache(), slept: number[] = [];
  const v = hunterVerifier({ fetch: fetchFake, apiKey: "TEST-KEY", cache, now: () => OCT14, sleep: async (ms) => { slept.push(ms); } });
  const r = await hunterPass(rows, v);
  eq([r.checked, calls.length], [2, 3], "only the 2 addresses that passed the free pass spend credits; the 429 is retried once");
  assert(slept.some((ms) => ms >= 1000), "the rate limit is waited out");
  const rep = listReport(r.rows, 0);
  eq([rep.hunter.checked, rep.hunter.valid, rep.hunter.accept_all, rep.hunter.deliverable_share, rep.hunter.target_85], [2, 1, 1, 50, "not met"]);
  eq(r.rows.filter((x) => x.verified).map((x) => x.name), ["Avery Synthetic"], "accept_all is never counted as deliverable");
  const again = await hunterPass(rows, v);
  eq([again.checked, again.cached, calls.length], [2, 2, 3], "the same address in the same month is not paid for twice");
  eq([mapHunter("webmail"), mapHunter("deliverable"), mapHunter(undefined)], ["webmail", "unknown", "unknown"], "an unknown word fails closed");
});

Deno.test("WO-033/C5 a bulk list is NOT_WIRED with a one-line ask; a list's cost is VERIFIED only with an invoice number", async () => {
  const v = await vendorSource().fetch();
  eq([v.status, v.cost_usd], ["NOT_WIRED", 0]);
  assert(v.status === "NOT_WIRED" && v.ask.length < 160 && !v.ask.includes("\n"), "one line");
  const c = listCost({ file: "apollo-export.csv", plan_price_usd: 59, exports_in_period: 1000, rows: 500, invoice: "INV-TEST-0001", now: OCT14 });
  assert(!("error" in c));
  eq([c.usd, c.label, c.under_target], [29.5, "VERIFIED", true]);
  const guess = listCost({ file: "x.csv", plan_price_usd: 59, exports_in_period: 1000, rows: 500, now: OCT14 });
  assert(!("error" in guess) && guess.label === "ASSUMED", "no invoice: ASSUMED");
  assert("error" in listCost({ file: "x.csv", plan_price_usd: 59, exports_in_period: 10, rows: 500, now: OCT14 }), "a list larger than the period's exports is refused");
});

// ------------------------------------------------------------------------------------------------ the fact-lock
Deno.test("WO-033/F1 the fact-lock: an invented shared school is caught; claims are checked against the right side", () => {
  const facts = ["BS Economics, NYU, Class of 2027", "Summer Analyst, Lazard, 2025"];
  const r = recipient({ school: "Wharton" });
  const shared = sharedFacts(FACTS, r);
  eq(shared, [], "Wharton is on their row only: nothing in common");
  const invented = outreachLock("Hi Avery,\n\nAs a fellow Wharton alum, I'd value your view on Goldman Sachs.", { facts, recipient: r, shared });
  assert(!invented.pass && invented.misattributed.some((x) => /Wharton/.test(x)), JSON.stringify(invented));
  const mine = outreachLock("I studied at Wharton and would love your view.", { facts, recipient: r, shared });
  assert(!mine.pass && mine.misattributed.some((x) => /says this about you/.test(x)), "a school from their row claimed as the person's");
  const theirs = outreachLock("I saw you worked at Lazard before.", { facts, recipient: r, shared });
  assert(!theirs.pass && theirs.misattributed.some((x) => /says this about them/.test(x)), "the person's firm claimed as theirs");
  const made = outreachLock("I led a $2B deal at Evercore in March.", { facts, recipient: r, shared });
  assert(!made.pass && ["$2B", "Evercore", "March"].every((w) => made.untraced.some((u) => u.includes(w))), JSON.stringify(made));
  const junior = outreachLock("I'm a junior at NYU and know Python.", { facts, recipient: r, shared });
  assert(!junior.pass && junior.untraced.includes("junior") && junior.untraced.includes("Python"), `WO-030's lock catches titles and tools too: ${JSON.stringify(junior)}`);
  const honestR = recipient({ school: "NYU" }), honestShared = sharedFacts(FACTS, honestR);
  eq(honestShared.map((s) => [s.kind, s.value, s.fact, s.field]), [["school", "NYU", "F-001", "school"]]);
  const ok = outreachLock("Hi Avery,\n\nI'm studying at NYU and interned at Lazard. As a fellow NYU student, would you have 15 minutes to talk about your work at Goldman Sachs?", { facts, recipient: honestR, shared: honestShared });
  assert(ok.pass, JSON.stringify(ok));
  eq(sharedFacts(FACTS, recipient()).length, 0, "a fact still waiting for the person's yes (F-003) is never a shared firm");
});

Deno.test("WO-033/F2 a draft with an invented shared school is written again; if it stays invented it is not shown", async () => {
  const fixed = await draftFor({ model: scripted("invent_once"), facts: FACTS, r: recipient({ school: "Wharton" }), personal: false }); // the fact-lock writer (PERSONALIZED OUTREACH: first emails use the engine)
  assert(fixed.ok && !/Wharton/.test(fixed.body) && fixed.tries === 2, JSON.stringify(fixed));
  const never = await draftFor({ model: scripted("invent"), facts: FACTS, r: recipient({ school: "Wharton" }), personal: false });
  assert(!never.ok && never.why === "unverified" && never.detail.some((d) => /Wharton/.test(d)), JSON.stringify(never));
  const thin = await draftFor({ model: scripted(), facts: [FACTS[2]], r: recipient(), personal: false });
  assert(!thin.ok && thin.why === "thin", "no confirmed fact, no draft");
});

// ------------------------------------------------------------------------------------------------ the reply
Deno.test("WO-033/P1 'send 1-7,9' and its adversarial kin", () => {
  eq(parseOutreachReply("send 1-7,9"), { kind: "send", all: false, ns: [1, 2, 3, 4, 5, 6, 7, 9], except: [] });
  eq(parseOutreachReply("Send 1 - 7, 9."), { kind: "send", all: false, ns: [1, 2, 3, 4, 5, 6, 7, 9], except: [] });
  eq(parseOutreachReply("send 2 and 5"), { kind: "send", all: false, ns: [2, 5], except: [] });
  eq(parseOutreachReply("send all"), { kind: "send", all: true, ns: [], except: [] });
  eq(parseOutreachReply("SEND ALL!"), { kind: "send", all: true, ns: [], except: [] });
  eq(parseOutreachReply("send all except 3, 5"), { kind: "send", all: true, ns: [], except: [3, 5] });
  eq(parseOutreachReply("redo 3"), { kind: "redo", n: 3 });
  eq(parseOutreachReply("skip 4"), { kind: "skip", ns: [4] });
  eq(parseOutreachReply("edit 3: Hi Avery, a shorter note."), { kind: "edit", n: 3, text: "Hi Avery, a shorter note." });
  eq(parseOutreachReply("send none"), { kind: "none" });
  for (const [t, why] of [["send 1-100", /no draft 100/], ["send all except", /leave out by number/], ["send all except everyone", /leave out by number/], ["send 0", /from 1/],
    ["send 7-3", /runs backwards/], ["send 1-7; drop table drafts", /by number/], ["send 1--7", /by number/], ["send -3", /by number/], ["send 3.5", /by number/], ["send 1e3", /by number/]] as const) {
    const r = parseOutreachReply(t);
    assert(r && r.kind === "bad" && why.test(r.why), `${t}: ${JSON.stringify(r)}`);
  }
  for (const t of ["stop", "yes", "sounds good", "send me jobs in Boston", "send my resume to Stripe please, thanks a lot"]) eq(parseOutreachReply(t)?.kind === "send" ? "send" : parseOutreachReply(t)?.kind ?? null, t === "send me jobs in Boston" || t.startsWith("send my") ? "bad" : null, t);
});

Deno.test("WO-033/P2 the turn: exactly the drafts named are approved, each bound to its text; out of range approves nothing", async () => {
  const store = memoryOutreachStore(), events = memoryEventStore();
  await batchOf(store, 10);
  const big = await turn(store, "send 1-100");
  assert(big && /Nothing was approved/.test(big.reply) && big.intent === OUTREACH_INTENT, JSON.stringify(big));
  const far = await turn(store, "send 1-12");
  assert(far && /there is no 11, 12/.test(far.reply), far?.reply);
  eq((await store.latestBatch(U)).filter((d) => d.status === "approved").length, 0, "nothing approved by a bad reply");
  const r = await turn(store, "send 1-7,9", OCT14, { events });
  assert(r && /^Approved 8, exactly as shown/.test(r.reply) && /Not sent: 8, 10/.test(r.reply), r?.reply);
  const b = await store.latestBatch(U);
  eq(b.map((d) => d.status), ["approved", "approved", "approved", "approved", "approved", "approved", "approved", "shown", "approved", "shown"]);
  assert(b.filter((d) => d.status === "approved").every((d) => d.approved_hash === d.hash), "each approval is the exact message's hash");
  eq(events.dump().filter((e) => e.kind === "outreach_approved").length, 8);
  const skip = await turn(store, "skip 8");
  assert(skip && /Dropped 8/.test(skip.reply) && /Still waiting: 10/.test(skip.reply), skip?.reply);
  store.setIntent(TH, "agent");
  eq(await turn(store, "send all"), null, "a 'send all' after something else was said is not an answer to the batch");
});

Deno.test("WO-033/P3 the batch is shown in full and numbered, split on purpose at 1,500 characters, plain text", async () => {
  const store = memoryOutreachStore();
  const b = await batchOf(store, 10);
  for (const d of b) d.body = `Hi ${d.recipient.name},\n\n${"I'm a junior at NYU and interned at Lazard last summer. ".repeat(4)}Would you have 15 minutes next week?`;
  const msgs = batchMessages(b);
  assert(msgs.every((m) => m.length <= 1500), msgs.map((m) => m.length).join(","));
  const all = msgs.join("\n\n");
  for (const d of b) assert(all.includes(`${d.n}. To: ${d.recipient.name}`) && all.includes(d.body) && all.includes(d.footer), `draft ${d.n} in full`);
  assert(all.includes(BATCH_FOOT) && !/[*_#`]{2}|\[[^\]]+\]\(/.test(all), "the reply words, no markdown");
  // "show me the drafts" answers with the same messages as parts (WO-038), each under the 4,000-character outbox limit.
  store.setIntent(TH, OUTREACH_INTENT);
  const shown = await turn(store, "show me the drafts", OCT14);
  assert(shown && shown.parts && shown.parts.length > 1 && shown.parts.every((p) => p.length <= 4000), JSON.stringify(shown?.parts?.map((p) => p.length)));
  eq(shown!.parts!.join("\n\n"), shown!.reply, "the parts are exactly the reply");
});

// ------------------------------------------------------------------------------------------------ approval, edits, caps
Deno.test("WO-033/S1 no send without approval; an edit after approval needs a new one; a tampered message is refused", async () => {
  const store = memoryOutreachStore(), gmail = fakeGmail();
  await batchOf(store, 3);
  let s = await runOutreachSends({ store, sender: gmail, now: OCT14 });
  eq([s.sent, gmail.sent.length], [0, 0], "nothing approved, nothing sent");
  await turn(store, "send all");
  const e = await turn(store, "edit 2: Hi Person, a note in my own words.");
  assert(e && /It was approved before; this new version needs your approval/.test(e.reply), e?.reply);
  eq((await store.latestBatch(U)).map((d) => d.status), ["approved", "shown", "approved"]);
  // Someone changes draft 3's body under the approval: the send recomputes the hash and refuses.
  const d3 = (await store.latestBatch(U))[2];
  await store.update(U, { ...d3, body: "Hi, a different message nobody approved." });
  for (let k = 0; k < 4; k++) s = await runOutreachSends({ store, sender: gmail, now: OCT14 + k * 120_000 });
  eq(gmail.sent.map((m) => m.subject), ["Subject 1"], "only the one still approved as shown went");
  const after = await store.latestBatch(U);
  eq(after.map((d) => d.status), ["sent", "shown", "shown"], "the changed one went back to waiting for approval");
  await turn(store, "send 2");
  await runOutreachSends({ store, sender: gmail, now: OCT14 + 600_000 });
  eq(gmail.sent.map((m) => m.text.split("\n")[0]), ["Hi, body 1.", "Hi Person, a note in my own words."], "the edit goes once approved");
});

Deno.test("WO-033/S2 NO LIMITS: no warm-up, daily number, spacing or per-run number; no limit tool; only Gmail's 429 slows it", async () => {
  // A brand-new sender (no send history) with 40 approved: one run sends all 40, back to back.
  const store = memoryOutreachStore();
  for (let b = 0; b < 4; b++) { await batchOf(store, 10, OCT14 + b); await turn(store, "send all"); }
  let refusedAt = Infinity, refusals = 0;
  const sent: string[] = [];
  const gmail: Sender = { async send(_u, m) {
    if (sent.length >= refusedAt) { refusals++; return { status: "RATE_LIMITED", detail: "HTTP 429 userRateLimitExceeded" }; }
    sent.push(m.to); return { status: "sent", id: `G${sent.length}`, thread_id: `T${sent.length}` };
  } };
  const run = await runOutreachSends({ store, sender: gmail, now: OCT14 });
  eq([run.sent, Object.keys(run.refused)], [40, []], "all 40 in one run: no warm-up 10, no daily 20, no 90 seconds, no one-per-run");
  eq(new Set(sent).size, 40, "each once");
  eq((await runOutreachSends({ store, sender: gmail, now: OCT14 + 1000 })).sent, 0, "and never again");
  // The next day, 30 more; Gmail's own ceiling answers 429 after 25: that person's run stops at the first refusal (no
  // tight retry loop), the other 5 stay approved and go on the next run once Gmail allows.
  const day2 = OCT14 + 86_400_000;
  for (let b = 0; b < 3; b++) { await batchOf(store, 10, day2 + b); await turn(store, "send all", day2 + b); }
  refusedAt = 65;
  const hit = await runOutreachSends({ store, sender: gmail, now: day2 + 1000 });
  eq([hit.sent, hit.rate_limited, refusals], [25, 1, 1], "Gmail's refusal is the only brake, and it is asked once");
  eq(store.dump().drafts.filter((d) => d.status === "approved").length, 5, "the rest wait, approved");
  refusedAt = Infinity;
  eq((await runOutreachSends({ store, sender: gmail, now: day2 + 3600_000 })).sent, 5, "they go when Gmail allows");
  eq([sent.length, new Set(sent).size], [70, 70]);
  // No tool sets a number, and the rule itself has none.
  const tools = byName(careerTools({ postings: async () => [], outreach: { store } }));
  eq(tools.set_outreach_limit, undefined, "no outreach limit tool");
  const d = { status: "approved", approved_hash: "h", hash: "h", approved_at: new Date(day2).toISOString(), created_at: new Date(day2).toISOString() } as unknown as OutreachDraft;
  eq(admitSend({ draft: d, hash: "h", now: day2, dnc: false }), "ok", "admission is the approval, its age, pause and do-not-contact only");
  assert(!/capFor|WARMUP|GAP_MS|MAX_DAILY|DEFAULT_DAILY|daily_cap"|RECIPIENT_CAP/.test(SRC_OUTREACH), "no volume constant in the outreach code");
  assert(!/set_outreach_limit|MAX_DAILY|BATCH_MAX/.test(SRC_TOOLS), "no volume constant in the tools");
});

Deno.test("WO-033/S3 Gmail: one recipient, no Cc or Bcc, no smuggled header, NOT_WIRED without the grant's gmail.send", async () => {
  const raw = buildRaw({ to: "avery.synthetic@gs.example", subject: "Question", text: "Hi.\n\nSam Student\n\n" + OPT_OUT_LINE });
  const head = atob(raw.replace(/-/g, "+").replace(/_/g, "/")).split("\r\n\r\n")[0];
  eq(head.split("\r\n").map((h) => h.split(":")[0]), ["To", "Subject", "MIME-Version", "Content-Type", "Content-Transfer-Encoding"]);
  for (const to of ["a@x.example, b@y.example", "Avery <a@x.example>", "a@x.example\r\nBcc: b@y.example"]) {
    let threw = false; try { buildRaw({ to, subject: "S", text: "T" }); } catch { threw = true; } assert(threw, `refused: ${to}`);
  }
  let threw = false; try { buildRaw({ to: "a@x.example", subject: "S\r\nBcc: b@y.example", text: "T" }); } catch { threw = true; } assert(threw, "a subject that smuggles a header");
  const calls: string[] = [];
  const g = gmailSender({ fetch: (async (u: string) => { calls.push(u); return new Response("{}"); }) as any, token: async () => null });
  eq([(await g.send(U, { to: "a@x.example", subject: "S", text: "T" })).status, calls.length], ["NOT_WIRED", 0]);
  const deps = { connection: async () => ({ vault_name: `oauth_google_career_${U}`, scopes: "https://www.googleapis.com/auth/gmail.readonly" }), readVault: async () => JSON.stringify({ access_token: "t", expires_at: OCT14 + 3600_000 }), writeVault: async () => {}, fetch: fetch, env: { get: () => undefined }, now: () => OCT14 };
  eq(await careerTokenFor(deps, GMAIL_SEND_SCOPE)(U), null, "a grant without gmail.send cannot send");
  eq(await careerTokenFor(deps, "https://www.googleapis.com/auth/gmail.readonly")(U), "t", "the same reader, asked for the scope it has");
  // Approved, but no grant: nothing goes, the approval stays for when Gmail is connected.
  const store = memoryOutreachStore();
  await batchOf(store, 1); await turn(store, "send all");
  const s = await runOutreachSends({ store, sender: g, now: OCT14 });
  eq([s.sent, s.not_wired, (await store.latestBatch(U))[0].status], [0, 1, "approved"]);
  const noGmail = await (async () => { const st = memoryOutreachStore(); await batchOf(st, 1); return turn(st, "send all", OCT14, { gmailConnected: async () => false, connectAsk: "Connect Gmail - here's the link.\n\nhttps://example.test/connect/gmail" }); })();
  assert(noGmail && /Nothing can go out until your Gmail is connected/.test(noGmail.reply) && /\nhttps:\/\/example\.test\/connect\/gmail$/.test(noGmail.reply), noGmail?.reply);
});

// ------------------------------------------------------------------------------------------------ stop, bounce, events
Deno.test("WO-033/O1 a 'stop' or 'unsubscribe' reply puts them on the do-not-contact list forever; a bounce is recorded", async () => {
  const store = memoryOutreachStore(), gmail = fakeGmail(), events = memoryEventStore();
  await batchOf(store, 3); await turn(store, "send all");
  for (let k = 0; k < 3; k++) await runOutreachSends({ store, sender: gmail, now: OCT14 + k * 91_000, events });
  const [d1, d2, d3] = await store.latestBatch(U);
  eq(await recordReply({ store, userId: U, draft: d1, mail: { from: `Person 1 <${d1.recipient.email}>`, subject: "Re: Subject 1", snippet: "Please unsubscribe me from these emails.", at: "2026-10-15T12:00:00Z" }, now: OCT14, events }), "stop");
  eq(await recordReply({ store, userId: U, draft: d2, mail: { from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Delivery Status Notification (Failure)", snippet: "Address not found", at: "2026-10-15T12:00:00Z" }, now: OCT14, events }), "bounce");
  eq(await recordReply({ store, userId: U, draft: d3, mail: { from: d3.recipient.email, subject: "Re: Subject 3", snippet: "Happy to chat, how is Thursday?", at: "2026-10-15T12:00:00Z" }, now: OCT14, events }), "reply");
  eq(classifyReply({ from: d1.recipient.email, subject: "Re: hi", snippet: "STOP", at: "" }, d1.recipient.email), "stop");
  eq(classifyReply({ from: "someone.else@x.example", subject: "Re: hi", snippet: "stop", at: "" }, d1.recipient.email), "other", "only the recipient can opt themselves out");
  assert((await store.dnc(U)).has(await emailHash(d1.recipient.email)), "on the list, as a hash");
  eq(events.dump().filter((e) => /^outreach_(replied|bounced)$/.test(e.kind)).map((e) => [e.kind, e.detail.stop ?? null]), [["outreach_replied", true], ["outreach_bounced", null], ["outreach_replied", null]]);
  // Forever: a new approved draft to the same address is never sent, and drafting skips them.
  const again: any = { ...d1, n: 1, status: "shown", approved_hash: null, approved_at: null, sent_at: null, created_at: new Date(OCT14 + 86400_000 * 30).toISOString() };
  again.hash = await payloadHash(messageOf(again));
  await store.saveBatch(U, TH, [again], OCT14 + 86400_000 * 30); store.setIntent(TH, OUTREACH_INTENT);
  await turn(store, "send all", OCT14 + 86400_000 * 30);
  const s = await runOutreachSends({ store, sender: gmail, now: OCT14 + 86400_000 * 30 });
  eq([s.sent, s.refused.do_not_contact], [0, 1]);
});

// One recipient, many Trainee users: the owner removed the cross-person count (2026-10-27 20:40 CDT: no "3 emails per
// address per 30 days across all users"). Each person's own approved email goes once; a "stop" still stops everyone (X2).
async function approvedTo(store: ReturnType<typeof memoryOutreachStore>, user: string, email: string, at: number) {
  const d: any = { n: 1, recipient: recipient({ name: "Shared Banker Synthetic", email, firm: "Goldman Sachs" }), subject: `From ${user}`, body: `Hi from ${user}.`,
    footer: `${user}\n\n${OPT_OUT_LINE}`, status: "approved", approved_at: new Date(at).toISOString(), sent_at: null, gmail_id: null, gmail_thread: null, result: null,
    created_at: new Date(at).toISOString(), hash: "", shared: [] };
  d.hash = await payloadHash(messageOf(d)); d.approved_hash = d.hash;
  return (await store.saveBatch(user, `${user}-thread`, [d], at))[0];
}
Deno.test("WO-033/X1 one recipient, five Trainee users: no cross-person count; each person's approved email goes once", async () => {
  const store = memoryOutreachStore(), gmail = fakeGmail(), to = "shared.banker@gs.example";
  for (let k = 1; k <= 5; k++) await approvedTo(store, `TEST-U${k}`, to, OCT14);
  const s = await runOutreachSends({ store, sender: gmail, now: OCT14 });
  eq([s.sent, Object.keys(s.refused)], [5, []], "all five people's own approved emails go");
  eq(gmail.sent.filter((m) => m.to === to).map((m) => m.subject), ["From TEST-U1", "From TEST-U2", "From TEST-U3", "From TEST-U4", "From TEST-U5"], "one each, none doubled");
  eq((await runOutreachSends({ store, sender: gmail, now: OCT14 + 1000 })).sent, 0, "and none again");
});
Deno.test("WO-033/X2 a 'stop' to any Trainee user stops every Trainee user's drafts to that address", async () => {
  const store = memoryOutreachStore(), gmail = fakeGmail(), to = "asked.to.stop@gs.example";
  const a = await approvedTo(store, "TEST-UA", to, OCT14);
  await runOutreachSends({ store, sender: gmail, now: OCT14 });
  eq(await recordReply({ store, userId: "TEST-UA", draft: { ...a, status: "sent" }, mail: { from: to, subject: "Re: hi", snippet: "Please stop emailing me.", at: "2026-10-15T12:00:00Z" }, now: OCT14 }), "stop");
  await approvedTo(store, "TEST-UB", to, OCT14 + 86400_000);
  const s = await runOutreachSends({ store, sender: gmail, now: OCT14 + 86400_000 });
  eq([s.sent, s.refused.do_not_contact], [0, 1], "another user's draft to the same address is never sent");
});

Deno.test("WO-033/E1 'which bankers did I email in October?' end to end: import, draft, approve, send, recall", async () => {
  // PERSONALIZED OUTREACH (2026-10-31): the two bankers each carry one sourced fact and the model writes from the engine's
  // payload (personal-fixture.ts); was a generic email to bankers with nothing on record but a title and firm.
  const store = memoryOutreachStore(), events = memoryEventStore(), gmail = fakeGmail(), model = engineAware(scripted());
  await seedFacts(store, U, ["avery.synthetic@gs.example", "blake.fixture@jpm.example"]);
  const state: Record<string, any> = { profile: { facts: FACTS, connections: [] } };
  const imported = await importContactsFile(state, { name: "apollo-export.csv", text: APOLLO }, MX_OK);
  assert(imported.ok && /imported 4 contacts/.test(imported.note), imported.note);
  const tools = byName(careerTools({ postings: async () => [], events, outreach: { store, model }, tz: "America/New_York" }));
  const ctx = (message: string, now = OCT14) => ({ userId: U, threadId: TH, now, state, turn: { message, added: [] as string[] } as any });
  const first = await tools.draft_outreach.run({}, ctx("draft emails to the bankers on my list"));
  eq([first.drafted, first.needs], [0, "signature"], "no signature, no drafts");
  await tools.set_outreach_signature.run({ signature: "Sam Student\nNYU '27" }, ctx("sign them Sam Student\nNYU '27"));
  const c = ctx("draft emails to the bankers on my list");
  const out = await tools.draft_outreach.run({}, c);
  eq([out.drafted, out.held_out], [2, { no_email: 0, not_verified: 2, already_contacted: 0, do_not_contact: 0 }], "only addresses that passed every check run");
  assert(c.turn.show?.intent === OUTREACH_INTENT && /1\. To: Avery Synthetic, Investment Banking Analyst, Goldman Sachs/.test(c.turn.show.text) && /Sam Student\nNYU '27/.test(c.turn.show.text), c.turn.show?.text);
  assert(!/Goldman Sachs.*intern/i.test(c.turn.show.text.split("Subject:")[1] ?? ""), "a fact still waiting for a yes is never used");
  // WO-038's contract: the batch also goes as separate messages, so a texting channel delivers each draft whole.
  eq(c.turn.show.parts, batchMessages(await store.latestBatch(U)), "the shown batch travels as its own messages");
  eq(c.turn.show.parts.join("\n\n"), c.turn.show.text, "the parts are exactly the shown text");
  store.setIntent(TH, OUTREACH_INTENT);
  await turn(store, "send all", OCT14, { events });
  for (let k = 0; k < 2; k++) await runOutreachSends({ store, sender: gmail, now: OCT14 + k * 91_000, events });
  eq(gmail.sent.map((m) => m.to), ["avery.synthetic@gs.example", "blake.fixture@jpm.example"]);
  // A September send to someone else must not answer an October question.
  await events.add({ user_id: U, at: "2026-09-20T14:00:00.000Z", kind: "outreach_sent", subject: "Old Contact, Barclays", detail: { name: "Old Contact", company: "Barclays", role: "Banker" }, source: "outreach" });
  const asked = await tools.recall.run({ kinds: ["outreach_sent"], subject: "bankers", when: "in October" }, ctx("which bankers did I email in October?", Date.parse("2026-10-30T15:00:00Z")));
  eq([asked.window, asked.count, asked.events.map((e: any) => [e.subject, e.detail.title])], ["October 2026", 2, [["Blake Fixture, JPMorgan", "Investment Banking Associate"], ["Avery Synthetic, Goldman Sachs", "Investment Banking Analyst"]]]);
  const loose = await tools.recall.run({ subject: "bankers", when: "October" }, ctx("which bankers did I email in October?", Date.parse("2026-10-30T15:00:00Z")));
  eq([...new Set(loose.events.map((e: any) => e.kind))].sort(), ["outreach_approved", "outreach_drafted", "outreach_sent"], "every step is on the timeline");
});

// ------------------------------------------------------------------------------------------------ the referral map
Deno.test("WO-033/R1 the referral map cites rows, uses only the person's exports and confirmed facts, and asks for the export when there is none", async () => {
  eq(referralMap({ targets: ["Goldman Sachs"], rows: [], facts: [] }).ask, REFERRAL_ASK);
  assert(/^Export your LinkedIn connections \(Settings, Data privacy, Get a copy of your data\) and send me the file\.$/.test(REFERRAL_ASK));
  const rows = importContactsCsv("Connections.csv", LINKEDIN).rows;
  const alumni = { file: "nyu-alumni.csv", row: 7, name: "Quinn Alum", email: null, firm: "Goldman Sachs", firm_raw: "Goldman Sachs", company: "Goldman Sachs", title: "Associate", school: "NYU", connected_on: null };
  const m = referralMap({ targets: targetFirms([["GS", "Lazard", "Goldman Sachs & Co."], ["Stripe"]]), rows: [...rows, alumni], facts: FACTS });
  eq(m.firms.map((f) => f.firm), ["Goldman Sachs", "Lazard", "Stripe"], "one spelling per firm");
  const gs = m.firms[0];
  eq(gs.paths.map((p) => [p.name, p.source]), [["Quinn Alum", "nyu-alumni.csv, row 7"], ["Jordan Example", "Connections.csv, row 1"]]);
  assert(gs.paths[0].why.some((w) => /went to NYU, as you did/.test(w)) && gs.paths[1].why.includes("a 1st-degree connection"));
  eq(gs.own, [], "an unconfirmed internship is not a path");
  eq(m.firms[1].own.map((o) => o.fact), ["F-002"], "their own confirmed internship at Lazard is a path, citing the fact");
  eq(m.schools, ["NYU"]);
  const tools = byName(careerTools({ postings: async () => [] }));
  const noTargets = await tools.referral_map.run({}, { userId: U, threadId: TH, now: OCT14, state: {}, turn: { message: "who can refer me", added: [] } });
  eq([noTargets.firms.length, noTargets.export_ask], [0, REFERRAL_ASK]);
});

Deno.test("WO-033/R2 the referral map over a 2,000-row connections export, 20 firms: measured", () => {
  const firms = ["Goldman Sachs", "JPMorgan", "Morgan Stanley", "Bank of America", "Citi", "Barclays", "Deutsche Bank", "Wells Fargo", "Evercore", "Lazard", "Centerview Partners", "PJT Partners", "Moelis", "Houlihan Lokey", "Jefferies", "Stripe", "Ramp", "Plaid", "Brex", "Acme Synthetic"];
  const lines = ["First Name,Last Name,URL,Email Address,Company,Position,Connected On"];
  for (let i = 0; i < 2000; i++) lines.push(`Person${i},Synthetic${i},https://www.linkedin.com/in/synthetic-${i},,${i % 3 === 0 ? firms[i % 20] : `Other Co ${i}`},Analyst,01 Jan 2025`);
  const t0 = performance.now();
  const rows = importContactsCsv("Connections.csv", lines.join("\n")).rows;
  const m = referralMap({ targets: firms, rows, facts: FACTS });
  const ms = performance.now() - t0;
  console.log(`  referral map: 2,000 connections, 20 firms, ${m.firms.reduce((s, f) => s + f.paths.length + f.more, 0)} paths, ${ms.toFixed(0)} ms (import + map)`);
  eq([rows.length, m.firms.length], [2000, 20]);
  assert(m.firms.every((f) => f.paths.every((p) => /^Connections\.csv, row \d+$/.test(p.source))), "every path names its row");
  assert(ms < 5000, `${ms} ms`);
});

// ------------------------------------------------------------------------------------------------ never LinkedIn
Deno.test("WO-033/L1 no LinkedIn URL is ever fetched: none in the code, and an import with profile URLs makes no request", async () => {
  for (const [name, src] of Object.entries({ SRC_CONTACTS, SRC_OUTREACH, SRC_GMAIL, SRC_REFERRALS, SRC_TOOLS, SRC_PROACTIVE })) {
    assert(!/linkedin\.com/i.test(src), `${name} names no linkedin.com URL`);
    for (const m of src.matchAll(/fetch\w*\(\s*([^,)]*)/g)) assert(!/linkedin|\.url\b|row\.|\burl\b/i.test(m[1]), `${name}: fetch(${m[1]}) reads no URL from a row`);
  }
  const real = globalThis.fetch, calls: string[] = [];
  globalThis.fetch = (async (u: any) => { calls.push(String(u)); throw new Error("no network in this test"); }) as any;
  try {
    const state: Record<string, unknown> = {};
    await importContactsFile(state, { name: "Connections.csv", text: LINKEDIN }, MX_NOT_WIRED);
    referralMap({ targets: ["Goldman Sachs"], rows: contactsOf(state), facts: FACTS });
    eq(calls, [], "nothing was fetched");
    assert(!JSON.stringify(state).includes("linkedin.com/in/"), "no profile URL is stored");
  } finally { globalThis.fetch = real; }
});
