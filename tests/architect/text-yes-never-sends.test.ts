// The card's yes (D-031; SERIAL-1440, 1442, 1451, 1461; the owner, 2026-10-22 5:09 PM: "for submitting a yes, does handle
// a batch of submissions"; D-MS-1, 2026-10-27): one texted yes approves exactly the batch the card shows: in direct reply
// to the card's message, or as a plain text while the card is the thread's last word (any channel). Within 10 minutes of
// the showing, once (the card is single-use), each item by the payload hash the card carries (an item that changed since
// is refused by name). A yes in reply to any other or older message approves nothing and says how. The yes approves; it never sends:
// the person's own worker claims and finishes, and no chat turn module names a claim or finish door. The cloud card
// (the bridge draft, C9) is unchanged: its yes only opens that card. Synthetic only; no network, no database.
import { CARD_INTENT, type CardStore, cardTurn } from "../../supabase/functions/_shared/career_apply_cards.ts";
const ok = (v: unknown, why: string) => { if (!v) throw new Error(why); };
const YES_FORMS = ["yes", "Yes!", "yep", "yeah", "y", "approve", "approve all", "yes please", "yes send them", "send them", "send all"];
const EXCEPT_FORMS = ["yes but not 2", "yes except 1", "approve, skip 2"];
// Every database door that approves, queues, claims or finishes an application.
const SEND_DOORS = /career_apply_(card_answer_(as|own)|message_card_approve_own|batch_approve_own|enqueue|cloud_begin_agent_own|extension_begin(_agent)?_own|claim(_own|_at)?|cloud_claim(_at)?|finish|cloud_finish)\b/;
const NOW = Date.parse("2026-10-22T13:00:00Z");
const CARD_MSG = "msg-card-1"; // the message that carried card-1

function wo022Store(o: { shownAgoMs?: number; changed?: number[]; open?: boolean; intent?: string | null; shownCard?: string | null; messages?: Record<string, string | null> } = {}) {
  const approvals: number[][] = [];
  let open = o.open ?? true;
  const messages = o.messages ?? { [CARD_MSG]: "card-1", "msg-other": null };
  const store: CardStore = {
    async pending() { return []; },
    async open() { throw new Error("not used"); },
    async latestOpen() { return open ? { id: "card-1", items: [{ n: 1, prepared_id: "p1", payload_hash: "a".repeat(64) }, { n: 2, prepared_id: "p2", payload_hash: "b".repeat(64) }], shown_at: new Date(NOW - (o.shownAgoMs ?? 60_000)).toISOString() } : null; },
    // career_apply_card_answer_as: approving a number enqueues that application by its shown hash; a changed one is refused; the card closes.
    async answer(_u, _c, approve) { approvals.push(approve); open = false; return [1, 2].map((n) => ({ n, company: `Synthetic ${n}`, result: (o.changed ?? []).includes(n) ? "changed" : approve.includes(n) ? "queued" : "declined" })); },
    async lastAssistantIntent() { return o.intent === undefined ? CARD_INTENT : o.intent; },
    async lastShownCard() { return o.shownCard === undefined ? (open ? "card-1" : null) : o.shownCard; },
    async cardOfMessage(_t, id) { return messages[String(id)] ?? null; },
  };
  return { store, approvals, closed: () => !open };
}
const turn = (s: { store: CardStore }, message: string, extra: { now?: number; replyTo?: string | number | null; threadId?: string; userId?: string } = {}) =>
  cardTurn({ message, userId: extra.userId ?? "u", threadId: extra.threadId ?? "t", now: extra.now ?? NOW, store: s.store, replyTo: extra.replyTo });

Deno.test("the card's yes: in direct reply to the card's message, within 10 minutes, it approves exactly the shown batch; 'yes but not 2' leaves 2 out; nothing is sent by the yes itself", async () => {
  for (const m of YES_FORMS) {
    const s = wo022Store();
    const r = await turn(s, m, { replyTo: CARD_MSG });
    ok(r?.status === "answered" && JSON.stringify(s.approvals) === "[[1,2]]", `"${m}" approves the whole card: ${JSON.stringify({ r, approvals: s.approvals })}`);
    ok(/2 approved exactly as shown/.test(r!.reply) && /Nothing has gone to an employer yet/.test(r!.reply), `"${m}": the words say approved, not sent: ${r!.reply}`);
  }
  for (const m of EXCEPT_FORMS) {
    const s = wo022Store();
    const r = await turn(s, m, { replyTo: CARD_MSG });
    const left = Number(m.match(/\d/)![0]);
    ok(r?.status === "answered" && s.approvals.length === 1 && !s.approvals[0].includes(left) && s.approvals[0].length === 1, `"${m}" leaves ${left} out: ${JSON.stringify(s.approvals)}`);
  }
});

Deno.test("D-MS-1 reply identity: a plain yes while the card is the last word approves it (every channel); a reply to a different message, or to an older card's message, approves nothing and says how; a decline needs no reply id", async () => {
  for (const m of [...YES_FORMS, ...EXCEPT_FORMS]) {
    // D-MS-1 (owner, 2026-10-27; replaces SERIAL-1461's reply-only rule): no reply id (iMessage, SMS, the web app), the
    // card the thread's last word: the yes approves exactly the batch shown.
    const absent = wo022Store();
    const a = await turn(absent, m);
    ok(a?.status === "answered" && absent.approvals.length === 1, `"${m}" with no reply id, card the last word: ${JSON.stringify(a)}`);
    const other = wo022Store();
    const d = await turn(other, m, { replyTo: "msg-other" });
    ok(d?.status === "needs_reply" && other.approvals.length === 0, `"${m}" in reply to another message, with the card as the last word: ${JSON.stringify(d)}`);
    const unknown = wo022Store();
    const u = await turn(unknown, m, { replyTo: "msg-unknown" });
    ok(u?.status === "needs_reply" && unknown.approvals.length === 0, `"${m}" in reply to an unknown message: ${JSON.stringify(u)}`);
    const older = wo022Store({ messages: { "msg-card-0": "card-0", [CARD_MSG]: "card-1" } });
    const o = await turn(older, m, { replyTo: "msg-card-0" });
    ok(o?.status === "card_outdated" && /out of date/.test(o!.reply) && older.approvals.length === 0, `"${m}" in reply to an older card's message: ${JSON.stringify(o)}`);
  }
  // A decline needs no reply id: it counts while the card is the thread's last word, and sends nothing.
  const no = wo022Store();
  await turn(no, "no");
  ok(JSON.stringify(no.approvals) === "[[]]", `a no declines with no approvals: ${JSON.stringify(no.approvals)}`);
  // The matching reply after another reply in the thread still counts: the reply id, not the last word, binds it.
  const later = wo022Store({ intent: "career_apply_status" });
  const r = await turn(later, "yes", { replyTo: CARD_MSG });
  ok(r?.status === "answered" && JSON.stringify(later.approvals) === "[[1,2]]", `a direct reply to the card's message after another reply: ${JSON.stringify(r)}`);
});

Deno.test("the card's yes: refused outside the 10-minute window, after the card was answered, and for an item that changed since it was shown", async () => {
  const late = wo022Store({ shownAgoMs: 11 * 60_000 });
  const r = await turn(late, "yes", { replyTo: CARD_MSG });
  ok(r?.status === "stale_card" && /more than 10 minutes ago/.test(r!.reply) && /show my applications/.test(r!.reply) && late.approvals.length === 0, `late yes: ${JSON.stringify(r)}`);
  const once = wo022Store();
  await turn(once, "yes", { replyTo: CARD_MSG });
  const again = await turn(once, "yes", { replyTo: CARD_MSG, now: NOW + 1000 });
  ok(again === null && once.approvals.length === 1, `a second yes finds no open card: ${JSON.stringify({ again, approvals: once.approvals })}`);
  const changed = wo022Store({ changed: [2] });
  const c = await turn(changed, "yes", { replyTo: CARD_MSG });
  ok(c?.status === "answered" && /2\. Synthetic 2: not sent: it changed after the card was shown/.test(c!.reply) && /1 approved exactly as shown/.test(c!.reply), `changed item refused by name: ${c?.reply}`);
});

Deno.test("SERIAL-1442 outside the batch card a text yes never approves: no card, another thread's last word, a question asked after the card, another person", async () => {
  for (const m of [...YES_FORMS, ...EXCEPT_FORMS, "yes, approve", "approve it"]) {
    const none = wo022Store({ open: false });
    ok((await turn(none, m, { replyTo: CARD_MSG })) === null && none.approvals.length === 0, `"${m}" with no card open: ${JSON.stringify(none.approvals)}`);
    const other = wo022Store({ intent: "agent" });
    ok((await turn(other, m, { threadId: "t2" }))?.status !== "answered" && other.approvals.length === 0, `"${m}" in a thread whose last word is not the card`);
    const asked = wo022Store({ intent: "career_apply_questions" });
    ok((await turn(asked, m))?.status !== "answered" && asked.approvals.length === 0, `"${m}" after a question was asked: could answer that question, so not the card's`);
    const person = wo022Store({ open: false });
    ok((await turn(person, m, { userId: "someone-else", replyTo: CARD_MSG })) === null && person.approvals.length === 0, `"${m}" from a person with no card of their own`);
  }
});

Deno.test("SERIAL-1442 once: after 'yes', after 'yes but not 2' and after 'no' the card is closed and a further yes approves nothing; a replay of the same yes does nothing", async () => {
  for (const first of ["yes", "yes but not 2", "no"]) {
    const s = wo022Store();
    const r1 = await turn(s, first, { replyTo: CARD_MSG });
    ok(r1?.status === "answered" && s.closed(), `"${first}" answers the card once: ${JSON.stringify(r1)}`);
    for (const again of ["yes", first, "approve all"]) {
      const r2 = await turn(s, again, { replyTo: CARD_MSG, now: NOW + 5_000 });
      ok(r2 === null && s.approvals.length === 1, `after "${first}", "${again}" approves nothing more: ${JSON.stringify(s.approvals)}`);
    }
  }
});

Deno.test("SERIAL-1442 exact payloads: whatever changed since the card was shown is refused by name and never queued (payload, the person's details, the employer screens, the pace)", async () => {
  const results = [
    { n: 1, company: "Changed Co", result: "changed" }, { n: 2, company: "Stale Co", result: "stale" }, { n: 3, company: "Cooldown Co", result: "company_cooldown" },
    { n: 4, company: "Dup Co", result: "duplicate" }, { n: 5, company: "Cap Co", result: "daily_cap" }, { n: 6, company: "Refused Co", result: "refused" }, { n: 7, company: "Fine Co", result: "queued" },
    { n: 8, company: "Pace Co", result: "pace_unreadable" },
  ];
  const store: CardStore = {
    async pending() { return []; }, async open() { throw new Error("not used"); },
    async latestOpen() { return { id: "card-7", items: results.map((r) => ({ n: r.n, prepared_id: `p${r.n}`, payload_hash: "a".repeat(64) })), shown_at: new Date(NOW - 1000).toISOString() }; },
    async answer() { return results; }, async lastAssistantIntent() { return CARD_INTENT; }, async lastShownCard() { return "card-7"; }, async cardOfMessage() { return "card-7"; },
  };
  const r = await cardTurn({ message: "yes", userId: "u", threadId: "t", now: NOW, store, replyTo: "msg-card-7" });
  ok(r?.status === "answered" && /^1 approved exactly as shown/.test(r!.reply), r?.reply);
  for (const [n, why] of [[1, "it changed after the card was shown"], [2, "your details changed after it was prepared"], [3, "you applied to them in the last 30 days"], [5, "it is over the daily pace you set yourself"], [6, "the queue refused it"], [8, "your saved daily pace could not be read"]] as const) {
    ok(new RegExp(`^${n}\\. [A-Za-z ]+: not sent: ${why.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m").test(r!.reply), `${n}: ${why}: ${r!.reply}`);
  }
  // The same posting already in the person's applications (sent, or approved and waiting for a site that asked us to slow
  // down: 20261029180000): never "you already applied" (it may never have been sent), never the word "duplicate".
  ok(/^4\. [A-Za-z ]+: not added again: this posting is already in your applications \(sent, or approved and waiting to go\)/m.test(r!.reply) &&
    !/already applied|duplicate/i.test(r!.reply), r!.reply);
  ok(/^7\. Fine Co: approved/m.test(r!.reply), r!.reply);
});

Deno.test("the cloud card's yes only opens the card (C9, bridge draft), calling no approve, queue, claim or finish door", async () => {
  let mod: any;
  try { mod = await import("../../supabase/functions/_shared/career_cloud_card_chat.ts"); } catch (e) { throw new Error(`the cloud card's yes turn is absent: ${e}`); }
  const CARD = "11111111-2222-4333-8444-555555555555";
  for (const m of [...YES_FORMS, "yes, approve", "approve it", "yes send it"]) {
    const rpcs: string[] = [], tables: string[] = [];
    const q: any = { select() { return q; }, eq() { return q; }, order() { return q; },
      limit() { return Promise.resolve({ data: [{ meta: { intent: "career_message_approval", career_approval_card_id: CARD } }], error: null }); } };
    const person = {
      from(t: string) { tables.push(t); return q; },
      rpc(name: string) { rpcs.push(name); return Promise.resolve({ data: { id: CARD, hash: "a".repeat(64), state: "open" }, error: null }); },
    };
    const r = await mod.cloudCardYesTurn({ message: m, threadId: "t", ownSession: true, store: mod.personCloudCardStore(person) });
    ok(!rpcs.some((n) => SEND_DOORS.test(n)), `"${m}" reached a send door: ${JSON.stringify(rpcs)}`);
    ok(rpcs.every((n) => n === "career_apply_message_card_read_own") && tables.every((t) => t === "agent_messages"), `"${m}": ${JSON.stringify({ rpcs, tables })}`);
    if (r) ok(r.status === "open_card" && r.card_id === CARD && /tap Approve/i.test(r.reply), `"${m}": ${JSON.stringify(r)}`);
  }
  ok(!("approve" in mod.personCloudCardStore({ from() {}, rpc() {} })), "the person's chat store has no approve method at all");
});

Deno.test("no chat turn module names a claim or finish door, and the cloud card turn names no send door", async () => {
  const read = (p: string) => Deno.readTextFile(new URL(`../../supabase/functions/${p}`, import.meta.url));
  for (const p of ["agent-chat/handler-career.ts", "_shared/career_apply_cards.ts", "_shared/career_cloud_optin.ts", "_shared/career_apply_confirm.ts", "_shared/career_apply_questions.ts"]) {
    const src = await read(p);
    ok(!/career_apply_(cloud_)?(claim(_own|_at)?|finish)\b/.test(src), `${p} names a claim or finish door`);
  }
  let src = "";
  try { src = await read("_shared/career_cloud_card_chat.ts"); } catch { throw new Error("the cloud card's yes turn is absent"); }
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  ok(!SEND_DOORS.test(code), "the cloud card's chat turn names a send door in code");
});

Deno.test("SERIAL-1451 card identity: a yes in reply to this thread's card message approves nothing when a newer card was shown since (the card is out of date)", async () => {
  // Thread A's card message carried card-0; the person's newest open card is card-1 (shown in another thread since).
  for (const m of [...YES_FORMS, ...EXCEPT_FORMS]) {
    const s = wo022Store({ messages: { "msg-card-A": "card-0" } });
    const r = await turn(s, m, { threadId: "A", replyTo: "msg-card-A" });
    ok(r?.status === "card_outdated" && /out of date/.test(r!.reply) && s.approvals.length === 0, `"${m}" on an outdated card: ${JSON.stringify(r)}`);
  }
});
