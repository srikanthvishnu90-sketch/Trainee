// REQS DOC 1 (conversation and trust): the questions a person asks about Trainee itself are answered from what is true,
// never with the "I may have missed what you meant" banner and never with a confident wrong route. Items: Q33 (what it
// is), Q234/Q239/Q244 (privacy promise, never sold, what is stored), Q235 (what it can see and holds, from the person's
// own rows), Q202 (legal, tax and medical questions get a referral), Q84/Q127 (a thanks or a laugh gets a short reply).
// Outcome assertions on meaning (kind, the facts a reply rests on), not on exact wording.
// Review of #354 (R1-R7) each has its own test below.
import assertNode from "node:assert/strict";
import { createRequire } from "node:module";
import { ALWAYS_KEPT, ERASE_SENTENCE, POLICY_SERVICES, SAFETY_REPLY, type StoredRecord, TRUST_INTENTS, type TrustDeps, trustKind, trustRead, trustTurn } from "../../supabase/functions/_shared/career_trust_turn.ts";
import type { Connection } from "../../supabase/functions/_shared/career_capabilities.ts";
import { CAREER_READ_SCOPE, CAREER_SEND_SCOPE } from "../../supabase/functions/_shared/career_mail_gmail.ts";

const POLICY = Deno.readTextFileSync(new URL("../../docs/launch/legal-pages/privacy.template.html", import.meta.url));
const HOST = Deno.readTextFileSync(new URL("../../supabase/functions/_shared/career_host.js", import.meta.url));
const HANDLER = Deno.readTextFileSync(new URL("../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));
const ROUTER = Deno.readTextFileSync(new URL("../../packages/domain/142-career-router.js", import.meta.url));
const FALLBACK = /I may have missed what you meant|I didn't catch that/i;
const BANNED = /I'?d be happy to|great question|absolutely!|let me know if you need anything else|I hope this helps|how can I help you today/i;
const EMPTY: StoredRecord = { resume: false, facts: 0, tracker: 0, applications: 0 };
const deps = (conns: Connection[] | null = [], stored: StoredRecord | null = EMPTY): TrustDeps => ({ connections: () => Promise.resolve(conns), stored: () => Promise.resolve(stored) });
const say = async (m: string, d: TrustDeps = deps()) => (await trustTurn({ message: m, deps: d }))!;
const google = (...scopes: string[]): Connection => ({ provider: "google_career", scopes, connected_at: null });
const outlook = (...scopes: string[]): Connection => ({ provider: "microsoft", scopes, connected_at: null });

Deno.test("Q33: 'are you a bot / AI / a real person' is answered plainly: an AI career agent, not a person", async () => {
  for (const m of ["are you a bot?", "Are you an AI?", "r u a real person", "am I talking to a real person?", "is this a bot", "wait are you human?", "who am I texting with?", "are you a bot or a person"]) {
    eq(trustKind(m), "identity", m);
    const a = await say(m);
    eq(a.intent, TRUST_INTENTS.identity, m);
    assert(/\bAI\b/.test(a.reply) && /not a (real )?person/i.test(a.reply) && /Trainee/.test(a.reply), a.reply);
  }
});

Deno.test("Q234/Q239: 'do you sell my data' gets the policy's own promise", async () => {
  for (const m of ["do you sell my data?", "will you sell my information", "who can see my messages?", "is my data safe", "do you share my info with employers?", "do you train on my data", "what happens with my data"]) {
    eq(trustKind(m), "privacy_sell", m);
    const a = await say(m);
    eq(a.intent, "career_privacy", m);
    assert(/don't sell/i.test(a.reply) && /advertis/i.test(a.reply) && /approve the exact/i.test(a.reply), a.reply);
  }
  assert(/We do not sell your information, use it for advertising/.test(POLICY));
  assert(/Employers, when you approve an application:<\/strong> the exact answers and resume you approved/.test(POLICY));
});

Deno.test("R6: the services named are the policy's list, derived from its text, none missing and none added", async () => {
  const li = POLICY.match(/<li><strong>Service providers that run Trainee for us,<\/strong>([\s\S]*?)<\/li>/)![1];
  // Every capitalized company name the policy's list carries: "Supabase (", "OpenAI (", "Vercel (", "Telegram, LoopMessage (", "Meta (".
  const named = [...new Set([...li.matchAll(/\b([A-Z][A-Za-z]+)\b(?= \(|,| or )/g)].map((m) => m[1]))].filter((w) => !["Trainee", "SMS"].includes(w));
  eq([...named].sort(), [...POLICY_SERVICES].sort(), `policy list: ${named}`);
  const r = (await say("who can see my messages?")).reply;
  for (const n of named) assert(r.includes(n), `${n} named: ${r}`);
  for (const other of ["Anthropic", "Google", "Stripe", "Twilio", "Amazon", "Microsoft"]) assert(!r.includes(other), `${other} is not in the policy's list: ${r}`);
});

Deno.test("R7: 'forget everything' is described as what the erase does, never as deleting the messages", async () => {
  for (const m of ["do you sell my data?", "what do you keep about me?"]) {
    const r = (await say(m)).reply;
    assert(r.includes(ERASE_SENTENCE), r);
    assert(!/(delete|erase)[^.]*\bmessages\b/i.test(r.replace(ERASE_SENTENCE, "")) && /messages stay in the chat record/.test(ERASE_SENTENCE), r);
  }
  // What the erase sentence claims is the code's: the host keeps the chat record and pauses work; the handler removes the
  // tailored resumes; the router's erase names the watches and the tracker.
  assert(/Existing chat\/audit records may retain earlier text; it is excluded from active context/.test(HOST));
  assert(/_hostPatch = \{ erase: true, paused: true \}/.test(HOST));
  assert(/erase === true\) await supabaseResumeStore\(admin\)\.removeAll/.test(HANDLER));
  assert(/your job watches and alerts, your application tracker/.test(ROUTER));
});

Deno.test("Q244 + R3: 'what do you keep about me' answers from this person's record; questions about other things pass", async () => {
  for (const m of ["what do you store about me?", "what data do you have on me", "do you save my messages?", "what do you keep about me"]) eq(trustKind(m), "privacy_store", m);
  const r = (await say("what do you keep about me?", deps([], { resume: true, facts: 4, tracker: 2, applications: 3 }))).reply;
  assert(/your resume/.test(r) && /4 confirmed facts/.test(r) && /2 applications on your tracker/.test(r) && /3 applications sent or queued/.test(r), r);
  const none = (await say("what do you keep about me?", deps([], EMPTY))).reply;
  // Re-review 2: never "nothing saved": the contact details and the messages are always kept (the policy's own list).
  assert(none.includes(ALWAYS_KEPT) && /Nothing else yet/.test(none) && !/Nothing about you is saved/.test(none), none);
  const lost = (await say("what do you keep about me?", deps([], null))).reply;
  assert(lost.includes(ALWAYS_KEPT) && /couldn't read what else is saved/.test(lost), lost);
  for (const w of [/the name and phone number you give us when you sign up, the messaging account you use/, /your email address if you give it to Trainee/, /What you tell Trainee:<\/strong> your messages/]) assert(w.test(POLICY), String(w));
  // R3: not about the person's own data.
  for (const m of ["what did you save about the Stripe application?", "what do you collect from employers", "what data do you keep on companies?", "does Acme sell my data to recruiters"]) eq(trustKind(m), null, m);
});

Deno.test("Q235 + R1: every connection on the account is named from its own scopes, never 'nothing connected' when one is", async () => {
  const m = "can you see my other apps?";
  eq(trustKind(m), "access");
  const none = (await say(m, deps([]))).reply;
  assert(/No account is connected/.test(none), none);
  const cases: [Connection[], RegExp[], RegExp[]][] = [
    [[google(CAREER_READ_SCOPE)], [/Gmail: I read your job mail/, /can't send/], [/No account is connected/]],
    [[google(CAREER_READ_SCOPE, CAREER_SEND_SCOPE)], [/Gmail: I read your job mail[^\n]*only after your yes/], [/No account/]],
    [[google(CAREER_SEND_SCOPE)], [/Gmail: I can send an email only after your yes/, /can't read your mail/], [/No account is connected/, /I read your job mail/]],
    [[outlook("openid", "https://graph.microsoft.com/Mail.Read", "Mail.Send")], [/Outlook: I read your job mail[^\n]*only after your yes/], [/No account is connected/, /Gmail/]],
    [[google(CAREER_READ_SCOPE), outlook("Mail.Send")], [/Gmail: I read/, /Outlook: I can send/], [/No account/]],
  ];
  for (const [conns, want, never] of cases) {
    const r = (await say(m, deps(conns))).reply;
    for (const w of want) assert(w.test(r), `${w} in ${r}`);
    for (const n of never) assert(!n.test(r), `${n} not in ${r}`);
  }
  const unread = (await say(m, deps(null))).reply;
  assert(/couldn't read your connected accounts/.test(unread) && !/No account is connected|Gmail:/.test(unread), unread);
});

Deno.test("R2: access answers from what Trainee actually holds, never 'only this chat' or 'can't see your files'", async () => {
  for (const m of ["do you have access to my resume?", "can you see my tracker", "can you see my applications?", "can you see my files?"]) eq(trustKind(m), "access", m);
  const r = (await say("do you have access to my resume?", deps([], { resume: true, facts: 2, tracker: 1, applications: 0 }))).reply;
  assert(/plus your resume, 2 confirmed facts about you, 1 application on your tracker/.test(r), r);
  assert(!/only this chat|can't see[^.]*files|haven't connected any account/i.test(r), r);
  const partial = (await say("can you see my tracker", deps([], { resume: true, facts: 0, tracker: null, applications: null }))).reply;
  assert(/your resume/.test(partial) && /couldn't read your tracker and applications/.test(partial), partial);
});

Deno.test("R4: a privacy or access question with another ask in it is left whole to the router", () => {
  for (const m of ["is my data safe? find me jobs", "is my data safe, find me data analyst jobs", "are you a bot? also tailor my resume", "can you see my email? what did Acme say",
    "do you sell my data. apply to the Stripe role", "who can see my messages, and can you draft a note to Maya", "can you see my other apps\nfind me jobs in Austin"]) eq(trustKind(m), null, m);
  for (const m of ["is my data safe?", "ok, are you a bot?"]) assert(trustKind(m) !== null, m);
  // The referral checks are not anchored to the whole text, so the one-question rule is what keeps the rest of these.
  // A referral asked beside something else keeps the something else (re-review 3): the referral first, the rest after.
  for (const [m, rest] of [["can my boss withhold my last paycheck? draft a note to HR for me", /^draft a note to hr for me$/], ["should I see a doctor about stress, and what should I tell my manager", /^what should i tell my manager$/]] as [string, RegExp][]) {
    const r = trustRead(m)!;
    eq(r.kind, "referral", m);
    assert(rest.test(r.rest ?? ""), `${m}: rest ${r.rest}`);
  }
});

Deno.test("Q202 + R5: a personal legal, tax or medical question gets a referral; an offer or negotiation question does not", async () => {
  const cases: [string, RegExp][] = [
    ["is it legal for my employer to fire me for this?", /lawyer/], ["can my boss withhold my last paycheck?", /lawyer/],
    ["should I sue my old company", /lawyer/], ["is my non-compete enforceable?", /lawyer/],
    ["do I owe taxes on my signing bonus?", /tax professional/], ["how much tax will I pay on a $20k bonus", /tax professional/],
    ["is my relocation stipend taxable", /tax professional/],
    ["should I see a doctor about stress?", /doctor/], ["what meds should I take for anxiety", /doctor/],
  ];
  for (const [m, who] of cases) {
    eq(trustKind(m), "referral", m);
    const a = await say(m);
    eq(a.intent, "career_out_of_domain", m);
    assert(who.test(a.reply) && /won't guess/.test(a.reply), `${m}: ${a.reply}`);
  }
  for (const m of ["can my employer rescind my offer if I ask for more money", "can they rescind the offer if I counter?", "can my employer rescind my start date if I push it back?", "is it legal for them to lowball my salary offer",
    "find me tax associate jobs in Chicago", "any nursing roles near me", "paralegal internships", "help me negotiate my signing bonus",
    "I want to become a lawyer", "is it legal to apply to two jobs at the same company", "I am legally authorized to work in the U.S.", "is it legal for me to work on OPT?",
    "do I need a lawyer for my H-1B?", "medical assistant openings"]) eq(trustKind(m), null, m);
});

Deno.test("a text over 300 characters is the router's even when it opens with one of these questions", () => {
  const long = "is it legal for my landlord to keep my deposit " + "when the apartment was left clean and every receipt was kept ".repeat(5);
  assert(long.length > 300 && long.length < 400);
  eq(trustKind(long), null);
  eq(trustKind(long.slice(0, 120)), "referral", "the same question, short");
});

Deno.test("Q84/Q127: a bare thanks or laugh gets one short word back, marked as an acknowledgment", async () => {
  for (const m of ["thanks", "Thank you!", "ty", "thx", "ok thanks", "appreciate it", "lol", "haha", "lmao", "😂"]) {
    eq(trustKind(m), "ack", m);
    const a = await say(m);
    eq(a.intent, "conversation_ack", m);
    eq(a.meta?.ack, true, m);
    assert(a.reply.split(/\s+/).length <= 2, `short: ${a.reply}`);
  }
  for (const m of ["ok", "yes", "cool", "👍", "sure", "thanks, now find me data analyst jobs", "lol find me jobs"]) assert(trustKind(m) !== "ack", m);
});

Deno.test("every trust reply: no fallback banner, no banned phrase, no em-dash or semicolon, at most 3 sentences a bubble", async () => {
  const msgs = ["are you a bot?", "do you sell my data?", "what do you keep about me?", "can you see my other apps?", "do I owe taxes on my bonus?", "thanks"];
  const depSets = [deps(null, null), deps([]), deps([google(CAREER_READ_SCOPE), outlook("Mail.Read")], { resume: true, facts: 3, tracker: 1, applications: 1 })];
  for (const m of msgs) for (const d of depSets) {
    const r = (await say(m, d)).reply;
    assert(!FALLBACK.test(r) && !BANNED.test(r), r);
    assert(!/[—;]/.test(r), `no em-dash or semicolon (Q101): ${r}`);
    for (const bubble of r.split("\n")) assert((bubble.match(/[.!?](\s|$)/g) ?? []).length <= 3, `Q66: ${bubble}`);
  }
});

Deno.test("career asks and everyday texts are left to the router", () => {
  for (const m of ["find me data analyst jobs in Chicago", "what do you know about me?", "what's connected?", "do you have my resume?", "hi",
    "apply to the Stripe role", "where are my applications?", "forget everything", "can you tailor my resume", "who are you?", "what can you do",
    "can you check my email for replies", "can you read my email from Acme and tell me what they said", "can you go through my inbox"]) eq(trustKind(m), null, m);
});

Deno.test("re-review 1: distress always gets the crisis answer, never the doctor referral, at any length or with anything else in it", async () => {
  const Intel = createRequire(import.meta.url)("../../packages/domain/125-career-intel.js");
  eq(SAFETY_REPLY, Intel.respondToRequest("I want to kill myself").text, "the router's own crisis answer, word for word");
  const msgs = ["should I see a therapist because I want to die", "should I see a therapist? I want to die", "I want to die, should I see a doctor",
    "should I talk to a counselor, I've been thinking about killing myself", "my meds aren't working and I want to end my life", "do I owe taxes on my bonus and honestly I want to kill myself",
    "is it legal for them to fire me, I don't want to live anymore", "thanks. i'm better off dead", "I keep thinking about suicide", "wanna die lol", "Should I see a doctor? I've been cutting myself",
    "I want to kill myself " + "x ".repeat(200)];
  for (const m of msgs) {
    eq(trustKind(m), "safety", m);
    const a = await say(m);
    eq(a.intent, "safety_support", m);
    eq(a.reply, SAFETY_REPLY, m);
    assert(!/doctor|therapist|lawyer|tax professional|won't guess/.test(a.reply), `${m}: never the referral line`);
    eq(a.rest, undefined, `${m}: nothing else is answered`);
  }
});

Deno.test("re-review 3: a referral with a second ask joined by and / also / plus keeps the second ask", async () => {
  const cases: [string, RegExp, RegExp][] = [
    ["do I owe taxes on my signing bonus and should I counter", /tax/, /^should i counter$/],
    ["is my relocation stipend taxable, also how do I ask for more equity", /tax/, /^how do i ask for more equity$/],
    ["can my boss withhold my last paycheck plus can you draft a note to HR", /legal/, /^can you draft a note to hr$/],
  ];
  for (const [m, part, rest] of cases) {
    const a = await say(m);
    eq(a.kind, "referral", m);
    assert(rest.test(a.rest ?? ""), `${m}: rest ${a.rest}`);
    assert(new RegExp(`^The ${part.source} part is a question for`).test(a.reply) && a.reply.split(/(?<=[.!?])\s/).length === 1, `one line: ${a.reply}`);
  }
  // Without a second ask the full referral line stands.
  const solo = await say("do I owe taxes on my signing bonus?");
  eq(solo.rest, undefined);
  assert(/job-search side/.test(solo.reply), solo.reply);
});

function eq(a: unknown, b: unknown, m?: string) { assertNode.deepStrictEqual(a, b, m); }
function assert(v: unknown, m?: string) { assertNode.ok(v, m); }
