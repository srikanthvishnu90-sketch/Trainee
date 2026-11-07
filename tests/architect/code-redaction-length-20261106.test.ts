// CODE REDACTION HAS NO LENGTH LIMIT (Greptile P1 on PR #549, comment r4495617701, reproduced 2026-11-06). The chat accepts 4,000
// characters, but career_code_in_chat.ts skipped every message over 400: "The Workday portal sent me 739201, can you enter it?"
// after ~480 characters of ordinary context was stored unredacted and sent to the model. Rule that never moves: no password or
// one-time code is stored or sent to a model through chat.
//   1. Pure code (chat_input.ts then codeInChat, as the handler runs them): lengths 399/400/401/1000/4000, the unlabeled sentence
//      at the start, middle and end, and labeled secrets: no token survives, at any length. Controls (pay, GPA, year, zip, phone,
//      a count) are untouched at every length.
//   2. The REAL handler on real Postgres with a fake model on the wire: the stored user message, every model request, and the
//      thread and its state carry no token. Up to 400 characters the fixed safety reply answers; a longer message (a pasted
//      document) keeps its normal turn, with the token removed.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/code-redaction-length-20261106.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";
import { CODE_IN_CHAT_INTENT, CODE_IN_CHAT_REPLY, codeInChat } from "../../supabase/functions/_shared/career_code_in_chat.ts";
import { chatInput } from "../../supabase/functions/agent-chat/_shared/chat_input.ts";
import { redactIdentity } from "../../supabase/functions/_shared/identity_redact.ts";
import { redactIdentity as trunkRedact } from "./helpers/identity_redact_trunk_e3da539.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";

// Ordinary context with no code word and no number in it.
const FILL = "I have worked in retail for a while and I enjoy helping customers find what they need, and I would like to move into a clinic role. ";
const LENGTHS = [399, 400, 401, 1000, 4000];
type Where = "start" | "middle" | "end";
// The sentence plus filler, exactly `len` characters, the sentence at the start, middle or end.
function place(sentence: string, len: number, where: Where): string {
  const room = len - sentence.length - 1;
  const fill = (n: number) => { let s = ""; while (s.length < n) s += FILL; return s.slice(0, n).replace(/\s+$/, "").padEnd(n, "."); };
  const before = where === "start" ? 0 : where === "middle" ? Math.floor(room / 2) : room;
  const a = before ? `${fill(before)} ` : "", b = room - before ? ` ${fill(room - before - 1)}` : "";
  return `${a}${sentence}${b}`.padEnd(len, ".").slice(0, len);
}
const WORKDAY = "The Workday portal sent me 739201, can you enter it?";
const LABELED: [string, string][] = [["Greenhouse sent me code 482913.", "482913"], ["My OTP 123456 is here.", "123456"], ["My workday password is hunter2.", "hunter2"]];
const CONTROLS = ["They offered me $24/hour.", "My GPA is 3.85.", "I graduated in 2024.", "My zip is 94107.", "Call me at 415-555-0134.", "I applied to 1200 jobs."];

const turn = (m: string) => {
  const i = chatInput(m, [], 4000, {}) as any;
  assert(i.ok, `chatInput refused a ${m.length}-char message: ${i.error}`);
  const c = codeInChat(i.message, { userContent: i.userContent, removed: i.redacted });
  return { message: c ? c.text : i.message, stored: c ? c.userContent : i.userContent, c };
};

Deno.test("CRL-1 no code or password survives in the stored or model-bound text at any length, start, middle or end", () => {
  for (const len of LENGTHS) for (const where of ["start", "middle", "end"] as Where[]) {
    for (const [sentence, token] of [[WORKDAY, "739201"], ...LABELED] as [string, string][]) {
      // A labeled value is replaced by a longer marker in chat_input.ts, so 4000 labeled characters are refused ("message too
      // long", nothing stored); the largest accepted one is shorter.
      const m = place(sentence, sentence === WORKDAY || len < 4000 ? len : 3970, where);
      eq(m.length, sentence === WORKDAY || len < 4000 ? len : 3970, "built to length");
      const t = turn(m);
      assert(!t.message.includes(token), `${len}/${where} ${token}: model-bound text kept it`);
      assert(!t.stored.includes(token), `${len}/${where} ${token}: stored text kept it`);
      assert(/\[(code|password) removed\]/.test(t.stored), `${len}/${where} ${token}: marker missing`);
    }
  }
});

Deno.test("CRL-2 only the fixed reply keeps a length limit: 400 and under answers; longer keeps its own turn", () => {
  for (const len of LENGTHS) {
    const t = turn(place(WORKDAY, len, "end"));
    assert(t.c, `${len}: found`);
    eq(t.c!.reply, len <= 400, `${len}: reply flag`);
  }
});

Deno.test("CRL-3 controls are untouched at every length", () => {
  for (const len of LENGTHS) for (const where of ["start", "middle", "end"] as Where[]) for (const s of CONTROLS) {
    const m = place(s, len, where);
    const t = turn(m);
    eq(t.c, null, `${len}/${where} ${s}`);
    eq(t.stored, (chatInput(m, [], 4000, {}) as any).userContent, "stored as chat_input left it");
    assert(t.message.includes(s.replace(/\.$/, "")), `${len}/${where} ${s}: kept`);
  }
});

const PEOPLE: Record<string, string> = {};
for (let i = 1; i <= 8; i++) PEOPLE[`tok-crl-${i}`] = `7b0f8f8e-6a43-4a49-9d2c-00000c0d0a0${i}`;
type Call = { body: string };
const calls: Call[] = [];
const fakeModel = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request && !init ? input : new Request(input as any, init);
  if (new URL(req.url).hostname !== "api.anthropic.com") return new Response("not reachable in this test", { status: 404 });
  return anthropicWire(req, async (body: any) => {
    calls.push({ body: JSON.stringify(body) });
    return new Response(JSON.stringify({ id: "fake-crl", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Thanks for the background. Which kind of clinic sounds best?" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
  });
};

Deno.test({ name: "CRL-4 the real handler: stored row, model requests, thread and state carry no token at any length", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  const realFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  for (const k of ["CAREER_BRAIN", "CAREER_BRAIN_ROUTER_INTENTS", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_REPLY_WRITER"]) saved[k] = Deno.env.get(k);
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    await supabaseParity(pg);
    for (const id of Object.values(PEOPLE)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    for (const k of ["CAREER_BRAIN", "CAREER_BRAIN_ROUTER_INTENTS", "MODEL_PROVIDER", "CAREER_REPLY_WRITER"]) Deno.env.delete(k);
    Deno.env.set("ANTHROPIC_API_KEY", "sk-fake-crl-not-a-key");
    globalThis.fetch = fakeModel as typeof fetch;
    handler = await careerHandler(pg, PEOPLE);
    const say = async (c: Chat, message: string) => { const r = await c.say(message); eq(r.status, 200, r.reply); return r; };
    const lastUserRow = async (id: string) => (await pg.sql(`select content from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${id}' and m.role = 'user' order by m.id desc limit 1`)).trim();
    const allRows = async (id: string) => await pg.sql(`select coalesce(string_agg(m.content, ' || '), '') from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${id}'`)
      + await pg.sql(`select coalesce(string_agg(state::text, ' || '), '') from public.agent_flow_state where user_id = '${id}'`);

    const cases: [number, Where, string, string][] = [
      [399, "start", WORKDAY, "739201"], [401, "end", WORKDAY, "739201"], [1000, "middle", WORKDAY, "739201"], [4000, "start", WORKDAY, "739201"], [4000, "end", WORKDAY, "739201"],
      [1000, "end", "Greenhouse sent me code 482913.", "482913"], [3970, "middle", "My OTP 123456 is here.", "123456"], [1000, "start", "My workday password is hunter2.", "hunter2"],
    ];
    let who = 0;
    for (const [len, where, sentence, token] of cases) {
      const tok = `tok-crl-${(who++ % 8) + 1}`, id = PEOPLE[tok], msg = place(sentence, len, where), n = calls.length;
      const r = await say(handler.chat(tok), msg);
      const label = `${len}/${where} ${token}`;
      assert(!r.reply.includes(token), `${label}: reply echoed it`);
      assert(!(await lastUserRow(id)).includes(token), `${label}: stored user message kept it`);
      assert(/\[(?:code|password) removed\]/.test(await lastUserRow(id)), `${label}: stored message has the marker`);
      for (const c of calls.slice(n)) assert(!c.body.includes(token), `${label}: a model request carried it`);
      assert(!(await allRows(id)).includes(token), `${label}: thread or state kept it`);
      assert(!(await pg.sql(`select coalesce(string_agg(title, ' || '), '') from public.agent_threads where user_id = '${id}'`)).includes(token), `${label}: thread title kept it`);
      if (len <= 400) { eq(r.intent, CODE_IN_CHAT_INTENT, label); assert(r.reply.includes(CODE_IN_CHAT_REPLY), label); eq(calls.length, n, `${label}: no model call`); }
      else assert(r.intent !== CODE_IN_CHAT_INTENT, `${label}: a long message keeps its normal turn (${r.intent})`);
    }
    // A control inside a long message is stored as typed.
    const ctl = place("They offered me $24/hour and my GPA is 3.85, I graduated in 2024, zip 94107.", 1000, "middle");
    const r = await say(handler.chat("tok-crl-8"), ctl);
    assert(r.intent !== CODE_IN_CHAT_INTENT, r.intent);
    eq(await lastUserRow(PEOPLE["tok-crl-8"]), ctl, "stored as typed");
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
    handler?.restore();
    globalThis.fetch = realFetch;
    await pg.stop();
  }
} });

const GAPS: [string, string][] = [
  ["The Workday portal sent me 739 201, can you enter it?", "739 201"], ["The Workday portal sent me 739-201, can you enter it?", "739-201"],
  ["Lever texted me 739 201.", "739 201"], ["Plaid emailed me 739-201 just now.", "739-201"],
  ["Verification code: 739\n201", "739\n201"], ["The portal sent a code. It is 739201.", "739201"],
  // Greptile on #566: a weak cue, then a code split by a line break (pasted from a text message)
  ["Workday sent me 739\n201", "739\n201"], ["The Workday portal sent me 739\n201, can you enter it?", "739\n201"], ["Lever texted me 739\n201.", "739\n201"],
  // Greptile on #567: Windows and old-Mac line endings
  ["Workday sent me 739\r\n201", "739\r\n201"], ["Lever texted me 739\r201.", "739\r201"], ["Verification code: 739\r\n201", "739\r\n201"],
  ["Workday sent a verification code. The code is 739201, please enter it.", "739201"], ["I got a one-time code from Lever. Here's 739201.", "739201"],
];
Deno.test("CRL-5 split codes, a code across a line break and a code in the next sentence are removed, at every length", () => {
  for (const len of [60, 399, 401, 1000, 3900]) for (const where of ["start", "middle", "end"] as Where[]) for (const [sentence, token] of GAPS) {
    const m = len === 60 ? sentence : place(sentence, len, where);
    const t = turn(m);
    const digits = token.replace(/\D/g, "");
    assert(!t.message.replace(/\D/g, "").includes(digits) && !t.stored.replace(/\D/g, "").includes(digits), `${len}/${where} ${JSON.stringify(sentence)}: ${t.stored.slice(0, 120)}`);
    assert(/\[code removed\]/.test(t.stored), `${len}/${where} ${JSON.stringify(sentence)}: marker`);
  }
});

// Numbers that look like a split code but are not one stay as typed, with and without a cue word in front.
const KEEP = ["Call me at 415-555-1234.", "My number is 415 555 1234.", "My number is (415) 555-1234.", "The meeting is at 9:30.", "I want 3-5 years of growth.",
  "The pay is $24-26 an hour.", "My zip is 94107-1234.", "The offer letter is dated 11-06-2026.", "The office is in room 739 201.",
  "The portal phone is 415-555-1234.", "The portal says call 415 555 1234.", "The portal lists (415) 555-1234.", "The portal opens at 9:30.", "The portal asked for 3-5 years.",
  "The portal shows $24-26.", "The portal shows 94107-1234.", "The portal shows 11-06-2026.", "I learned to code. It was 2019.", "I wrote some code. It is 5000 lines.", "My zip code is 94107. It is 94107-1234.",
  "My number is 415\n555\n1234.", "The portal says call 415\n555\n1234.", "The portal phone is 415\n555-1234."];
Deno.test("CRL-6 phones, times, ranges, zip+4, dates and years are never redacted, at every length", () => {
  for (const len of [60, 399, 401, 1000, 3900]) for (const where of ["start", "middle", "end"] as Where[]) for (const s of KEEP) {
    const m = len === 60 ? s : place(s, len, where);
    const t = turn(m);
    eq(t.c, null, `${len}/${where} ${s}`);
    assert(t.message.includes(s.replace(/\.$/, "")), `${len}/${where} ${s}: kept`);
  }
});

Deno.test({ name: "CRL-7 the real handler: a first message never puts a code in the thread title", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  const realFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  for (const k of ["CAREER_BRAIN", "CAREER_BRAIN_ROUTER_INTENTS", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_REPLY_WRITER"]) saved[k] = Deno.env.get(k);
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    await supabaseParity(pg);
    for (const id of Object.values(PEOPLE)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    for (const k of ["CAREER_BRAIN", "CAREER_BRAIN_ROUTER_INTENTS", "MODEL_PROVIDER", "CAREER_REPLY_WRITER"]) Deno.env.delete(k);
    Deno.env.set("ANTHROPIC_API_KEY", "sk-fake-crl-not-a-key");
    globalThis.fetch = fakeModel as typeof fetch;
    handler = await careerHandler(pg, PEOPLE);
    const cases: [string, string][] = [["The Workday portal sent me 739201, can you enter it?", "739201"], ["The Workday portal sent me 739 201, can you enter it?", "739 201"],
      ["The portal sent a code. It is 739201.", "739201"], ["Greenhouse sent me code 482913", "482913"]];
    for (const [i, [m, token]] of cases.entries()) {
      const tok = `tok-crl-${i + 1}`, id = PEOPLE[tok], n = calls.length;
      const r = await handler.chat(tok).say(m);
      eq(r.status, 200, r.reply);
      const everything = await pg.sql(`select coalesce(string_agg(title, ' || '), '') from public.agent_threads where user_id = '${id}'`)
        + await pg.sql(`select coalesce(string_agg(content, ' || '), '') from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${id}'`);
      assert(!everything.replace(/\D/g, "").includes(token.replace(/\D/g, "")), `${m}: title or thread kept it: ${everything}`);
      for (const c of calls.slice(n)) assert(!c.body.includes(token), `${m}: a model request carried it`);
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
    handler?.restore();
    globalThis.fetch = realFetch;
    await pg.stop();
  }
} });

// Greptile P1 on 80f645f: a labeled security code must be removed whatever follows it. The branch may remove MORE than trunk
// ("Security code\n123\n456 Oak St" loses 456), never less: every digit run trunk removed is removed here too.
const LABELED_CVV = ["The 3 digits on the back are 123\n2024 was the year I opened the account", "The 3 digits on the back are 123 2024 was the year", "The 3 digits on the back of my card are 123\n456 Oak St",
  "My card security code is 123\n2024 is when I opened it", "Card security code: 4821 2024", "cvv 123\n2024", "CVV: 123 and the zip is 94107", "cvc2 is 123 2024",
  "Security code 123\n456 Oak St", "Verification code: 739\n201", "Verification code: 739 201", "verification code is 739 2024", "security code: 739\n2024 was a good year",
  "The security code is 123. 2024 was the year.", "OTP 123456\n2024", "one-time code 482913 2024", "Greenhouse sent me code 482913\n2024", "pin: 4821\n94107", "code is 4821 1200 jobs"];
Deno.test("CRL-8 a labeled code or security code is removed whatever follows it: never weaker than trunk", () => {
  for (const base of LABELED_CVV) for (const [pre, post] of [["", ""], ["Hello there. ", ""], ["", " Thanks!"], ["Line one\n", "\nLine three 2024"]]) {
    const m = `${pre}${base}${post}`;
    const t = trunkRedact(m).text, n = redactIdentity(m).text;
    for (const tok of new Set(m.match(/\d+/g) ?? [])) if (!t.includes(tok)) assert(!n.includes(tok), `${JSON.stringify(m)}: trunk removed ${tok}, the branch kept it: ${JSON.stringify(n)}`);
  }
  for (const m of ["The 3 digits on the back are 123\n2024 was the year I opened the account", "Verification code: 739\n201"]) {
    const n = redactIdentity(m).text;
    assert(!n.includes("123") && !n.includes("739") && !n.includes("201"), n);
  }
});

// Greptile on #567: a code pasted with Windows or old-Mac line breaks is removed in every pass, labeled or not.
Deno.test("CRL-9 \\r\\n and \\r line breaks are removed like \\n", () => {
  for (const m of ["Workday sent me 739\r\n201", "Verification code: 739\r\n201", "my code is 739\r\n201", "Security code 123\r\n456", "OTP 123456\r\n2024 thanks", "Lever texted me 739\r201."]) {
    const t = turn(m);
    for (const g of ["739", "201", "123456"]) if (m.includes(g)) assert(!t.stored.includes(g), `${JSON.stringify(m)}: ${g} stored: ${JSON.stringify(t.stored)}`);
  }
  for (const m of ["The portal says call 415\r\n555\r\n1234.", "My number is 415\r\n555\r\n1234."]) eq(turn(m).c, null, m);
  // the redaction module on its own (other callers pass it raw text): no CRLF code survives
  for (const [m, gone] of [["Verification code: 739\r\n201", ["739", "201"]], ["Security code 123\r\n456", ["123", "456"]], ["OTP 123456\r\n2024", ["123456"]],
    ["my one-time code is 482\r\n913", ["482", "913"]], ["my code is 739\r\n201", ["739", "201"]]] as [string, string[]][]) {
    const r = redactIdentity(m).text;
    for (const g of gone) assert(!r.includes(g), `${JSON.stringify(m)}: ${g} kept: ${JSON.stringify(r)}`);
  }
});

// Review of #567: a no-break, thin or figure space, a tab, or an en/em dash between the groups is a separator like a space.
Deno.test("CRL-10 no-break and thin spaces, tabs and en dashes between code groups are removed", () => {
  const seps = ["\u00a0", "\u2007", "\u2009", "\u202f", "\t", "\u2013", "\u2014"];
  for (const sep of seps) for (const [pre, post] of [["Workday sent me ", ""], ["my code is ", ""], ["My security code is ", ""], ["Verification code: ", " thanks"], ["Your one-time code is ", "."]]) {
    const m = `${pre}739${sep}201${post}`;
    const t = turn(m);
    assert(!t.stored.includes("739") && !t.stored.includes("201"), `chat ${JSON.stringify(m)}: ${JSON.stringify(t.stored)}`);
    if (!pre.startsWith("Workday")) { const r = redactIdentity(m).text; assert(!r.includes("739") && !r.includes("201"), `raw ${JSON.stringify(m)}: ${JSON.stringify(r)}`); }
  }
  // the same separators in numbers that are not codes stay as they were (after normalising), with and without a weak cue
  for (const m of ["My number is 415\u00a0555\u00a01234.", "The portal says call 415\u2013555\u20131234.", "The pay is $24\u201326 an hour.", "I want 3\u20135 years of growth."]) eq(turn(m).c, null, m);
});

// Greptile on #568: a code whose groups are split by a run of spaces around a line break or dash ("739\n  201", "739 -  201")
// is removed like "739 201"; the same runs in a phone number keep it; a long run of spaces stays fast.
Deno.test("CRL-11 code groups split by up to 8 spaces or tabs around a line break or dash are removed", () => {
  for (const sep of ["\n  ", "  \n", " \n\t", "   ", "\t\t", " - ", "\r\n    ", " \u2013 "]) for (const pre of ["Workday sent me ", "my code is ", "Verification code: "]) {
    const m = `${pre}739${sep}201`;
    const t = turn(m);
    assert(!t.stored.includes("739") && !t.stored.includes("201"), `${JSON.stringify(m)}: ${JSON.stringify(t.stored)}`);
  }
  for (const m of ["My number is 415\n  555\n  1234.", "The portal says call 415   555   1234."]) eq(turn(m).c, null, m);
  const t0 = performance.now();
  turn(`Workday sent me 7${" ".repeat(3900)}x`); turn(`my code is 7${"\n ".repeat(1900)}`);
  assert(performance.now() - t0 < 500, `long whitespace took ${performance.now() - t0} ms`);
});
