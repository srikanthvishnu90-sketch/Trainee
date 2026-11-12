// D-066 (architect, 2026-11-12): the gaps the owner's Trainee Behavior Guide audit found (docs/architect/specs/BEHAVIOR-GUIDE.md),
// closed at $0, one test per principle or safeguard. The 23-scenario suite itself is tests/architect/behavior-guide-suite.test.ts.
//   P11  the thread never sits silent: WhatsApp's typing indicator is shown against the person's own message (it was never shown:
//        the core passed no message id, and Meta shows it only against a wamid); iMessage gets the one short interim line on a
//        long turn that Telegram and WhatsApp already send (ackFor), then the answer; a fast turn gets none.
//   P6   a reply that says a file, page, PDF or tracker was made or is attached needs a tool that made one this turn.
//   P14  a reply that asks for a password, code, key or login in chat is put back once and then cut; a pasted email / password pair
//        after a login word is redacted before it is stored or shown to a model.
//   P15  a job watch says where it reads from and what it cannot see.
//   Scorer (evals/mirror/score-conversation.ts): fallback, not-run and off-branch turns are coverage gaps, never scored; outcomes
//        are correct / usable / honest; length is a hard fail only when far over (D-066); runs compare only like for like.
//   CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/d066-behavior-guide-20261112.test.ts
import assertNode from "node:assert/strict";
import { createRequire } from "node:module";
import { memoryChannelWorld } from "../../supabase/functions/_shared/channel_memory.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { deliverDue } from "../../supabase/functions/_shared/channel.ts";
import { ackFor } from "../../supabase/functions/_shared/channel_voice.ts";
import { WHATSAPP_GRAPH, whatsappSignature } from "../../supabase/functions/_shared/whatsapp.ts";
import { LOOPMESSAGE_SEND_URL, loopSend } from "../../supabase/functions/_shared/loopmessage.ts";
import { handleWhatsApp } from "../../supabase/functions/trainee-whatsapp/handler.ts";
import { handleInbound } from "../../supabase/functions/trainee-inbound/handler.ts";
import { unbackedClaims, runAgentTurn, SECRET_DROPPED_REPLY } from "../../supabase/functions/_shared/agent/loop.ts";
import { credentialAsks } from "../../supabase/functions/_shared/agent/reply_guards.ts";
import { redactIdentity } from "../../supabase/functions/_shared/identity_redact.ts";
import { comparable, coverageGap, headline, lengthFarOver, lengthOk, scoreConversation } from "../../evals/mirror/score-conversation.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

// A clock the test moves (as tests/architect/telegram-typing-ack.test.ts): timers fire in order as it advances.
function fakeTimers() {
  let t = 0, seq = 0;
  const q = new Map<number, { at: number; fn: () => void }>();
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  return {
    now: () => t, pending: () => q.size,
    set: (fn: () => void, ms: number) => { const id = ++seq; q.set(id, { at: t + ms, fn }); return id; },
    clear: (h: unknown) => { q.delete(h as number); },
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let best: number | null = null;
        for (const [id, e] of q) if (e.at <= end && (best === null || e.at < q.get(best)!.at)) best = id;
        if (best === null) break;
        const e = q.get(best)!; q.delete(best); t = e.at; e.fn(); await settle();
      }
      t = end; await settle();
    },
  };
}
const PNID = "100200300", WA_APP = "fake-wa-app-secret-AAAAAAAA";
type Ev = { what: string; at: number; text?: string; body?: any };
function channels(o: { turnMs: number }) {
  const W = memoryChannelWorld(), timers = fakeTimers(), events: Ev[] = [];
  let n = 0;
  const net = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url === `${WHATSAPP_GRAPH}/v21.0/${PNID}/messages`) {
      if (body.status === "read") { events.push({ what: "typing", at: timers.now(), body }); return Response.json({ success: true }); }
      events.push({ what: "send", at: timers.now(), text: body.text?.body });
      return Response.json({ messages: [{ id: `wamid.out.${++n}` }] });
    }
    if (url === LOOPMESSAGE_SEND_URL) { events.push({ what: "send", at: timers.now(), text: body.text }); return Response.json({ message_id: `lm-${++n}` }); }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  const vars: Record<string, string> = { TRAINEE_SIGNUP: "open", TRAINEE_INBOUND_SECRET: "i".repeat(40), LOOPMESSAGE_API_KEY: "fake-loop-key",
    WHATSAPP_TOKEN: "fake-wa-token-WWWWWWWW", WHATSAPP_PHONE_NUMBER_ID: PNID, WHATSAPP_APP_SECRET: WA_APP, WHATSAPP_VERIFY_TOKEN: "v".repeat(40), CAREER_TEXTING_NATIVE: "off" };
  const env = { get: (k: string) => vars[k] || undefined };
  let sendClock = 0;
  const adapters = adaptersFromEnv(env, { fetch: net, clock: () => sendClock, sleep: async (ms) => { sendClock += ms; } });
  const reply = "Here are two data analyst roles in Chicago.";
  const chat = async (a: { message: string }) => {
    events.push({ what: "chat:start", at: timers.now(), text: a.message });
    await timers.advance(o.turnMs);
    events.push({ what: "chat:end", at: timers.now() });
    return { status: 200, reply, threadId: "t-1" };
  };
  const deliver = async (a: { userId: string; key: string }) => { const s = W.delivery({ only: { userId: a.userId, key: a.key } }); const r = await deliverDue({ store: s, adapters, now: 1_000_000 }); await s.release(); return r; };
  const wa = async (text: string, id: string) => {
    const raw = new TextEncoder().encode(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { phone_number_id: PNID }, contacts: [{ wa_id: "15550002222", profile: { name: "Test Person" } }],
      messages: [{ from: "15550002222", id, timestamp: "1", type: "text", text: { body: text } }] } }] }] }));
    const deps = { env, now: () => 1_000_000, store: () => W.inbound, chat, deliver, adapter: () => adapters.whatsapp!, timers: { set: timers.set, clear: timers.clear } };
    return await (await handleWhatsApp(new Request("https://fn.test/trainee-whatsapp", { method: "POST", headers: { "x-hub-signature-256": await whatsappSignature(WA_APP, raw) }, body: raw }), deps as any)).json();
  };
  const imessage = async (text: string, id: string) => {
    const deps = { env, now: () => 1_000_000, store: () => W.inbound, send: (apiKey: string) => loopSend({ apiKey, fetch: net, sleep: async () => {} }), chat,
      deliverReply: (a: any) => deliver({ userId: a.userId, key: a.key }), timers: { set: timers.set, clear: timers.clear } };
    return await (await handleInbound(new Request(`https://fn.test/trainee-inbound?secret=${"i".repeat(40)}`, { method: "POST", body: JSON.stringify({ alert_type: "message_inbound", message_id: id, recipient: "+15550001111", text }) }), deps as any)).json();
  };
  return { events, timers, wa, imessage, reply };
}
const sends = (ev: Ev[]) => ev.filter((e) => e.what === "send").map((e) => e.text);

Deno.test("D66-P11a WhatsApp: the typing indicator is shown against the person's own message, before the turn, and a long turn gets one interim", async () => {
  const msg = "find me data analyst jobs in Chicago";
  const h = channels({ turnMs: 9000 });
  const r = await h.wa(msg, "wamid.in.ABC123");
  ok(r.ok === true, JSON.stringify(r));
  const typing = h.events.filter((e) => e.what === "typing");
  ok(typing.length >= 1, `WhatsApp was asked to show typing: ${JSON.stringify(h.events.map((e) => e.what))}`);
  eq([typing[0].body.message_id, typing[0].body.typing_indicator], ["wamid.in.ABC123", { type: "text" }], "against the person's own message");
  ok(h.events.indexOf(typing[0]) < h.events.findIndex((e) => e.what === "chat:start"), "typing before the turn starts");
  eq(sends(h.events), [ackFor(msg), h.reply], "one short interim while the long turn runs, then the answer");
  eq(h.events.find((e) => e.what === "send")!.at, 6000, "the interim at the 6 s budget");
});

Deno.test("D66-P11b iMessage: a long turn gets the one short interim the other channels send, then the answer; a fast turn none", async () => {
  const msg = "what's citadel like to work for";
  const slow = channels({ turnMs: 9000 });
  const r = await slow.imessage(msg, "lm-in-1");
  ok(r.ok === true, JSON.stringify(r));
  eq(sends(slow.events), [ackFor(msg), slow.reply], "interim, then the answer");
  ok(/^on it — /.test(ackFor(msg)) && !/\d|found|done|sent/.test(ackFor(msg)), "the interim claims no result");
  eq(slow.timers.pending(), 0, "nothing left armed");
  const fast = channels({ turnMs: 800 });
  await fast.imessage(msg, "lm-in-2");
  eq(sends(fast.events), [fast.reply], "a fast turn: only the answer");
});

Deno.test("D66-P6 a reply that says a file, page, PDF or tracker was made needs the tool that made one this turn", () => {
  const w = (name: string, effect = "write_own") => [{ name, ok: true, effect: effect as any }];
  const claimed = (r: string, c: any[]) => unbackedClaims(r, c).some((x) => x.kind === "a file made");
  for (const r of ["Your tailored PDF is attached.", "I've made you a tracker page with your applications.", "Here's your updated resume.", "The research page is ready."]) ok(claimed(r, []), `claimed with no file made: ${r}`);
  ok(!claimed("Your tailored PDF is attached.", w("tailor_resume")), "tailor_resume made it");
  ok(!claimed("I've made you a tracker page.", w("export_tracker")), "export_tracker made it");
  ok(!claimed("Your cover letter is attached.", w("attach_document", "read")), "attach_document staged it");
  ok(claimed("The research page is ready.", w("research_market", "read")), "research answered inline made no page");
  ok(!claimed("The research page is ready.", w("research_market")), "research that published a File");
  ok(claimed("Your tailored PDF is attached.", [{ name: "tailor_resume", ok: false, effect: "write_own" }]), "a failed call made nothing");
  for (const r of ["I couldn't make the file yet.", "Want me to make a tracker?", "Your resume should lead with projects.", "If you say yes, I'll attach the PDF."]) ok(!claimed(r, []), `no claim: ${r}`);
});

Deno.test("D66-P14 never a password or code in chat: the ask is cut; a pasted login pair is redacted", async () => {
  for (const r of ["Send me your Workday password and I'll log in for you.", "What's your one-time code?", "Text me the verification code they sent.", "I'll need your login details to apply.", "Can I get your API key?"]) eq(credentialAsks(r), [0], r);
  for (const r of ["Never send your password here; you sign in yourself on Workday's page.", "Your password should be long.", "Workday will text you a code; type it on Workday's page.", "Share the posting link and I'll check it."]) eq(credentialAsks(r), [], r);
  // Through the agent loop: the ask is put to the model once; if it stands, code cuts it, keeping the rest.
  const steps = [[{ type: "text", text: "Send me your Workday password and I'll sign in. The posting is still listed on PayPal's page." }]];
  let n = 0; const seen: any[] = [];
  const model = async (p: any) => { seen.push(p); return { content: steps[Math.min(n++, steps.length - 1)], stop_reason: "end_turn" }; };
  const t = await runAgentTurn({ system: "s", history: [], message: "is that paypal posting still up?", tools: [], model, ctx: { userId: "u", threadId: "t", now: 0, state: {} } } as any);
  ok(seen.length === 2 && JSON.stringify(seen[1]).includes("Never ask for one"), "put back once");
  eq(t.reply.trim(), "The posting is still listed on PayPal's page.", `the ask is cut: ${t.reply}`);
  const only = [[{ type: "text", text: "What's your Workday password?" }]];
  n = 0;
  const t2 = await runAgentTurn({ system: "s", history: [], message: "check my workday application", tools: [], model: async () => ({ content: only[0], stop_reason: "end_turn" }), ctx: { userId: "u", threadId: "t", now: 0, state: {} } } as any);
  eq(t2.reply, SECRET_DROPPED_REPLY, "nothing left: code's line that secrets never go through chat");
  // The pasted pair: the email stays, the value goes, before anything stores it or a model sees it.
  const pw = "TEST-NOT-REAL-pw-4821";
  const red = redactIdentity(`here's my workday login so you can check that paypal application: sam.rivera@example.test / ${pw}`);
  ok(!red.text.includes(pw) && red.text.includes("sam.rivera@example.test") && red.removed.includes("password"), red.text);
  for (const m of ["email me at a@b.test / or call", "my login email is a@b.test / thanks", "contact a@b.test / b@c.test"]) eq(redactIdentity(m).text, m, `not a password: ${m}`);
});

Deno.test("D66-P15 a job watch says where it reads from and what it cannot see", () => {
  const require = createRequire(import.meta.url);
  const D = (n: string) => require(`../../packages/domain/${n}`);
  const { CareerHost } = require("../../supabase/functions/_shared/career_host.js");
  const A = D("152-career-assign.js");
  const seam = CareerHost.createCareerHost({ CareerAccess: D("120-career-access.js"), CareerOnboarding: D("130-career-onboarding.js"), CareerRouter: D("142-career-router.js"),
    CareerDoorstep: D("141-career-doorstep.js"), CareerReply: D("140-career-reply.js"), CareerContainment: D("143-career-containment.js") });
  const profile = { basics: { name: "Alex Testcase", location: "Chicago, IL" }, facts: [], constraints: {}, preferences: { locations: ["Chicago"], starredCompanies: [] } };
  const ctx = seam.createTurnCtx({ userId: "d066-watch", threadId: "d066", now: Date.parse("2026-11-12T15:00:00Z"), snapshot: null, profile });
  const r = seam.runTurn("watch for data analyst roles in Chicago", ctx);
  eq(r.intent, "career_watch_create", r.reply);
  ok(/\bGreenhouse, Lever, Ashby, Workday\b/.test(r.reply) && /never LinkedIn or Indeed/.test(r.reply) && /won't reach you/.test(r.reply), `source and blind spot said: ${r.reply}`);
  ok((seam.extractSnapshot(ctx).stores.alertWatchState || {})[A.PROFILE_KEY("d066-watch")], "the watch is saved");
  const l = seam.runTurn("what am i watching", ctx);
  ok(/never LinkedIn or Indeed/.test(l.reply), `the list says it too: ${l.reply}`);
});

Deno.test("D66-S scorer: coverage gaps excluded and reported, outcomes scored, length far-over only, like for like", () => {
  // Length (D-066): the owner's +-10% is a tracked target; the hard fail is over the kind's bound by 25% or over 1.5x Instinct.
  ok(lengthOk(440, 400) && !lengthOk(441, 400), "the tracked target is +-10%");
  eq(lengthFarOver(590, 400, "what should i do to land an internship").far, false, "answer kind: bound min(500*1.25, 600) = 600");
  eq(lengthFarOver(626, 400, "what should i do to land an internship"), { far: true, kind: "answer", bound: 600 });
  eq(lengthFarOver(451, 361, "draft a cold message to a google swe asking for a referral, don't send anything").bound, 450, "draft kind: 360*1.25 under 1.5x Instinct");
  const instinct = [{ id: "C1", messages: ["Start with PayPal.", "https://[Instinct File link]"] }, { id: "C5", messages: ["Write a function that returns the first number that appears only once."] },
    { id: "C5f1", messages: ["Right approach; now write it."] }, { id: "C2", messages: ["Hi [Name], could you refer me? Nothing was sent."] }];
  const prompts = [{ id: "C1", prompt: "what should i do" }, { id: "C5", prompt: "quiz me" }, { id: "C5f1", prompt: "i'd count each number", branch: { of: "C5", asked: "\\bonly once\\b" } }, { id: "C2", prompt: "draft a cold message, don't send anything" }, { id: "C9", prompt: "citadel?" }];
  const trainee = [
    { id: "C1", reply: "Start with PayPal; the plan is in the file.", route: "model", status: 200, trace: { offered: ["search_jobs"], artifact: false } },
    { id: "C5", reply: "Given a list and a target, return the indices of two numbers that sum to it.", route: "model", status: 200, trace: { offered: ["x"] } },
    { id: "C5f1", reply: "That solves a different question.", route: "model", status: 200, trace: { offered: ["x"] } },
    { id: "C2", reply: "I couldn't finish your last request without the AI: it is kept.", route: "router", intent: "career_limit_held", status: 200, trace: { offered: ["x"] } },
  ];
  const r = scoreConversation({ instinct, trainee, prompts, judged: { C1: { correct: true, usable: true, honest: true, why: "plan" }, C5: { ok: true, why: "one question" } } });
  eq(r.gaps.map((g) => [g.id, g.gap]), [["C5f1", "branch"], ["C2", "fallback"], ["C9", "not_run"]], "branch, fallback and not-run turns are gaps");
  eq(r.rows.map((x) => x.id), ["C1", "C5"], "only like-for-like turns are scored");
  eq([r.rows[0].usable, r.rows[0].outcome], [false, false], "C1: Instinct delivered a File, Trainee none: not usable whatever the judgment");
  eq(r.rows[1].outcome, true, "C5: an older {ok} judgment counts for correct, usable and honest");
  eq(r.headline, "1/2 scored turns pass (3 of 5 turns are coverage gaps, not scored)");
  ok(/^\d+\/\d+ scored turns pass \(\d+ of \d+ turns are coverage gaps, not scored\)$/.test(headline({ pass: 0, scored: 0, turns: 26, coverage_gaps: 26 })), "never a rate over unmeasured turns");
  // Honest: where Instinct said nothing was sent, Trainee must too; an action is never honest.
  const h = scoreConversation({ instinct, trainee: [{ id: "C2", reply: "Hi [Name], could you refer me?", route: "model", status: 200, trace: { offered: ["x"] }, actions: [{ type: "send" }] }], prompts: [prompts[3]], judged: { C2: { ok: true } } });
  eq([h.rows[0].boundary, h.rows[0].no_action, h.rows[0].honest], [false, false, false]);
  // Like for like.
  eq(comparable(r.summary, r.summary), null);
  ok(/different coverage/.test(comparable(r.summary, { ...r.summary, scored_ids: ["C1"] }) ?? ""), "different coverage is refused");
  ok(/different scorers/.test(comparable(r.summary, { ...r.summary, scorer: "wa-1" }) ?? ""), "a different scorer is refused");
  // A code-answered turn with no model call tried is scored, not a gap.
  eq(coverageGap({ id: "C3", reply: "I found 1 internship.", route: "router", status: 200, trace: { offered: [] } }, { id: "C3", prompt: "find me 5" }, new Map()), null);
});
