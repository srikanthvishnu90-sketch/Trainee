// F09 rounds 4-5: the posting screen's yes/no question gets Yes / No inline buttons on Telegram. Their callback data is
// scr:<question id>:yes|no, bound to the ONE open question; a tap is an explicit screen answer (never a typed "yes" for another consumer).
// Other channels get the plain words "Reply yes or no.". Fake deps, no network (the real-handler proof is screen-tap-handler-pg.test.ts).
import assert from "node:assert/strict";
import { CareerProfile } from "../../supabase/functions/_shared/router_core.career.js";
import { runInbound, screenButtons } from "../../supabase/functions/_shared/channel_inbound.ts";
import { chatThroughAgent } from "../../supabase/functions/_shared/channel_runtime.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { screenMeta, screenTapTurn, TAP_STALE_REPLY } from "../../supabase/functions/_shared/career_apply_screen_answer.ts";

const NOW = Date.parse("2026-10-28T18:00:00Z");
const QID = "0a1b2c3d";
function deps(chatOut: Record<string, unknown>) {
  const sent: any[] = [], chats: any[] = [], toasts: string[] = [], taps: string[] = [];
  const d: any = {
    env: { get: () => undefined }, now: () => NOW, render: (t: string) => [t],
    store: { claimMessage: async () => true, person: async (c: string) => ({ userId: "u1", threadId: "t1", contact: c }), refusedBefore: async () => false, createPerson: async () => { throw new Error("no"); },
      setThread: async () => {}, setOptOut: async () => {}, enqueueReply: async () => true, confirmLink: async () => { throw new Error("a button tap must never confirm a link"); } },
    reply: async (_c: string, b: string[], opts?: any) => { sent.push({ b, opts }); return { ok: true }; },
    chat: async (a: any) => { chats.push(a); return { status: 200, reply: "Will you need visa sponsorship?", threadId: "t1", ...chatOut }; }, deliver: async () => {},
    cardTap: async (a: any) => { taps.push(a.data); return { toast: "no", reply: "Nothing was approved.", status: "refused" }; },
    answerCallback: async (_id: string, t: string) => { toasts.push(t); return true; },
  };
  return { d, sent, chats, toasts, taps };
}
const text = (channel: string, t: string) => ({ provider: channel, channel, messageId: String(Math.random()), contact: channel === "telegram" ? "tg:1" : "wa:1", address: "1", kind: "text", text: t });
const tap = (data: string) => ({ provider: "telegram", channel: "telegram", messageId: String(Math.random()), contact: "tg:1", address: "1", kind: "callback", text: "", callback: { id: "cb1", data, messageId: "77" } });

Deno.test("the buttons are Yes / No bound to the open question: scr:<qid>:yes|no", async () => {
  assert.deepEqual(screenButtons(QID), [[{ text: "Yes", data: `scr:${QID}:yes` }, { text: "No", data: `scr:${QID}:no` }]]);
  const calls: any[] = [];
  const a = telegramAdapter({ token: "T", fetch: (async (_u: string, i: RequestInit) => { calls.push(JSON.parse(String(i.body))); return Response.json({ ok: true, result: { message_id: 1 } }); }) as any, sleep: async () => {} });
  await a.send("9", ["Yes or no?"], { buttons: screenButtons(QID) });
  assert.deepEqual(calls[0].reply_markup.inline_keyboard, [[{ text: "Yes", callback_data: `scr:${QID}:yes` }, { text: "No", callback_data: `scr:${QID}:no` }]]);
  assert.ok(`scr:${QID}:yes`.length <= 64);
});

Deno.test("Telegram: a turn that asks the yes/no question sends it with the Yes / No buttons", async () => {
  const t = deps({ screenButtons: true, screenQid: QID });
  await runInbound(text("telegram", "apply to all") as any, t.d);
  assert.deepEqual(t.sent.at(-1), { b: ["Yes or no?"], opts: { buttons: screenButtons(QID) } });
});

Deno.test("other channels: the plain words 'Reply yes or no.' (once, not again when the reply already says it)", async () => {
  const wa = deps({ screenButtons: true, screenQid: QID });
  await runInbound(text("whatsapp", "apply to all") as any, wa.d);
  assert.deepEqual(wa.sent.at(-1), { b: ["Reply yes or no."], opts: undefined });
  const said = deps({ screenButtons: true, screenQid: QID, reply: "Reply yes or no. I need a real answer for that." });
  await runInbound(text("whatsapp", "maybe") as any, said.d);
  assert.equal(said.sent.length, 0);
  const none = deps({});
  await runInbound(text("telegram", "hello") as any, none.d);
  assert.equal(none.sent.length, 0, "no yes/no question open: no buttons");
});

Deno.test("a tap on scr:<qid>:yes|no goes to the chat as an explicit screen answer (message + qid), never as a reply-to or a typed yes", async () => {
  for (const w of ["yes", "no"]) {
    const t = deps({});
    await runInbound(tap(`scr:${QID}:${w}`) as any, t.d);
    assert.equal(t.chats.length, 1);
    assert.equal(t.chats[0].message, w);
    assert.deepEqual(t.chats[0].screenTap, { qid: QID, answer: w });
    assert.ok(!t.chats[0].replyToMessageId, "not a reply to anything: it can never be the yes a card needs");
    assert.equal(t.toasts.length, 1);
    assert.deepEqual(t.taps, []);
  }
  // a button from before question ids (data exactly yes / no), another case, junk and other callbacks never reach the screen path
  for (const data of ["yes", "no", "YES", "scr:XYZ:yes", "scr:0a1b2c3d:maybe", "scr:0a1b2c3d:yes:x", "scr:0a1b2c3:yes"]) {
    const t = deps({});
    await runInbound(tap(data) as any, t.d);
    assert.equal(t.chats.length, 0, `callback data ${data} must not reach the chat`);
  }
});

const ASK = (qid = QID, fact = "sponsorship") => ({ intent: "career_apply_queue", meta: { screen_ask: [{ fact, question: `${fact}?` }], screen_held: [], screen_qid: qid, screen_buttons: ["Yes", "No"] } });
Deno.test("screenTapTurn: records the answer only when the qid is the open question; otherwise nothing is written", async () => {
  const run = async (answer: string, qid: string, last: any) => {
    const profile: any = CareerProfile.createProfile({});
    const r = await screenTapTurn({ qid, answer, now: NOW, last, profile, addFact: (p, f) => CareerProfile.addFact(p, f) });
    return { r, facts: (profile.facts ?? []).length };
  };
  const yes = await run("yes", QID, ASK());
  assert.deepEqual(yes.r.saved, [{ fact: "sponsorship", value: "yes" }]);
  assert.equal(yes.facts, 1);
  const no = await run("no", QID, ASK());
  assert.deepEqual(no.r.saved, [{ fact: "sponsorship", value: "no" }]);
  for (const [answer, qid, last] of [["yes", "ffffffff", ASK()], ["yes", QID, ASK("11111111")], ["yes", QID, null], ["yes", QID, { intent: "x", meta: {} }],
    ["maybe", QID, ASK()], ["yes", QID, ASK(QID, "location")], ["yes", "zz", ASK()],
    ["yes", QID, { intent: "x", meta: { ...ASK().meta, screen_ask: [{ fact: "sponsorship", question: "?" }, { fact: "citizenship", question: "?" }] } }]] as const) {
    const r = await run(answer, qid, last);
    assert.equal(r.r.status, "stale", JSON.stringify([answer, qid]));
    assert.ok(r.r.reply.startsWith(TAP_STALE_REPLY), r.r.reply);
    assert.deepEqual(r.r.saved, []);
    assert.equal(r.facts, 0);
    // round 6: a stale tap carries the open question forward (its id, buttons, ask, held), so what is open is never killed
    const m: any = (last as any)?.meta ?? {};
    if (m.screen_ask) {
      assert.deepEqual((r.r.meta as any)?.screen_qid, m.screen_qid);
      assert.deepEqual((r.r.meta as any)?.screen_ask, m.screen_ask);
      assert.deepEqual((r.r.meta as any)?.screen_buttons, m.screen_buttons);
      assert.deepEqual((r.r.meta as any)?.screen_held, m.screen_held);
      assert.equal(r.r.intent, (last as any).intent);
    } else {
      assert.equal((r.r.meta as any)?.screen_ask, undefined, "no question is invented");
    }
  }
  // the old button of question 1 while question 2 is open: question 2 survives, and its own tap then records
  const q2 = ASK("22222222", "relocation");
  const stale = await run("yes", QID, q2);
  assert.equal(stale.r.status, "stale");
  assert.equal((stale.r.meta as any).screen_qid, "22222222");
  assert.ok(stale.r.reply.includes("relocation?"), "the open question is put again under the notice");
  const profile: any = CareerProfile.createProfile({});
  const done = await screenTapTurn({ qid: "22222222", answer: "yes", now: NOW, last: { intent: q2.intent, meta: stale.r.meta as any }, profile, addFact: (p, f) => CareerProfile.addFact(p, f) });
  assert.deepEqual(done.saved, [{ fact: "relocation", value: "yes" }]);
});

Deno.test("meta.screen_buttons + a question id reach the channel; the screen asks ONE question at a time", async () => {
  const run = async (meta: unknown) => {
    const f = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ reply: "q", thread_id: "t", meta })) as any;
    try { return await chatThroughAgent("https://x.test", "k")({ userId: "u", threadId: null, message: "m", turnKey: "k" }); } finally { globalThis.fetch = f; }
  };
  assert.equal((await run({ screen_buttons: ["Yes", "No"], screen_qid: QID })).screenButtons, true);
  assert.equal((await run({ screen_buttons: ["Yes", "No"], screen_qid: QID })).screenQid, QID);
  assert.equal((await run({ screen_buttons: ["Yes", "No"] })).screenButtons, undefined, "no question id, no buttons");
  assert.equal((await run({ screen_buttons: ["Yes", "No"], screen_qid: "nope" })).screenButtons, undefined);
  assert.equal((await run({ screen_buttons: ["Yes", "No", "Maybe"], screen_qid: QID })).screenButtons, undefined);
  assert.equal((await run({})).screenButtons, undefined);
  const ask = (facts: string[]) => screenMeta({ asks: facts.map((fact) => ({ fact, question: "?" })), held: [] } as any);
  assert.deepEqual(ask(["sponsorship"])!.screen_buttons, ["Yes", "No"]);
  assert.match(String(ask(["sponsorship"])!.screen_qid), /^[0-9a-f]{8}$/);
  assert.equal(ask(["location"])!.screen_buttons, undefined);
  const two = ask(["sponsorship", "citizenship"])!;
  assert.deepEqual((two.screen_ask as any[]).map((a) => a.fact), ["sponsorship"], "ONE question at a time");
  assert.deepEqual(two.screen_buttons, ["Yes", "No"]);
  assert.notEqual(ask(["sponsorship"])!.screen_qid, ask(["sponsorship"])!.screen_qid, "each ask has its own id");
});
