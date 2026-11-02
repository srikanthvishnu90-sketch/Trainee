// 1v1 (owner request, 2026-11-01: reply like a texting-native agent, with links given the way Instinct gives them). The 120-scenario 1v1 (evals/career/one-v-one) and the fixes it ranked first,
// each written failing first:
//   1. links: a link inside a sentence goes on its own line right after the sentence that says what it is (Q584, Q585,
//      Q632), and the router numbers the roles it lists so the person can answer with a digit (Q89);
//   2. bubbles: on iMessage and SMS no bubble runs past a text's length (Q77), split between sentences, never inside one;
//   3. dates: a texting channel shows "Oct 19, 2026", never the database's 2026-10-19 (Q94);
//   4. the staged brain's system prompt carries the texting rules on a texting channel (plain text, one link alone on its
//      own line, short bubbles, one question), and the channel reaches it;
// Text the person approves word for word is never reshaped (career_reply_writer.ts writable(); not this layer).
import { ctxOf, SCENARIOS } from "../../evals/career/one-v-one/scenarios.ts";
import { grade } from "../../evals/career/one-v-one/score.ts";
import { probeCounts } from "../../evals/career/one-v-one/probes.ts";
import { judgeReply, parseVerdict } from "../../evals/career/one-v-one/judge.ts";
import { CODE_TURN_ORDER } from "../../evals/career/world.ts";
import { toOpenAI } from "../../supabase/functions/_shared/model_gateway.ts";
import { formatForChannel, imessageNativeRender, linksOnOwnLine, nativeRender } from "../../supabase/functions/_shared/channel_voice.ts";
import { careerSystemPrompt } from "../../supabase/functions/_shared/agent/prompt.ts";
import { findUrls } from "../../supabase/functions/_shared/channel_text.ts";

const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}\n got ${JSON.stringify(a)}\nwant ${JSON.stringify(b)}`); };

const F = "https://job-boards.greenhouse.io/figma/jobs/7004004", B = "https://job-boards.greenhouse.io/brex/jobs/7005005", N = "https://job-boards.greenhouse.io/notion/jobs/7007007";
// The router's search reply as trunk writes it (142-career-router.js roleSentence: the link rides inside each role's sentence).
const SEARCH = `Here are 3 roles that match your search.\nData Analyst, Growth at Figma (${F}) — remote: matches your search; heads-up: SQL, Figma named in the posting and not yet on your profile. Data Analyst at Brex (${B}) — Chicago, IL: matches your search. Data Analyst at Notion (${N}) — Chicago, IL: matches your search.\nWant me to rank them against your resume?`;

Deno.test("the 1v1 set: 120 scenarios over every channel and state, and every gold reply passes its own rubric", () => {
  eq(SCENARIOS.length, 120, "scenario count");
  eq(new Set(SCENARIOS.map((s) => s.id)).size, 120, "ids are unique");
  for (const ch of ["imessage", "sms", "whatsapp", "telegram", "web"]) assert(SCENARIOS.filter((s) => s.channel === ch).length >= 10, `${ch} has at least 10`);
  for (const st of ["new", "profile", "inflight"]) assert(SCENARIOS.some((s) => s.state === st), `state ${st}`);
  const bad = SCENARIOS.map((s) => ({ id: s.id, g: grade(s.gold, s.channel, s.r, ctxOf(s)) })).filter((x) => !x.g.pass);
  eq(bad.map((b) => `${b.id}:${b.g.failed.join("+")}`), [], "gold fails its own rubric");
});

Deno.test("the rubric catches what the owner named: a link inside a sentence, markdown on iMessage, a wall of text", () => {
  const r = { links: 1 };
  assert(grade([`Data Analyst at Brex (${B}) is in Chicago.`], "imessage", r).failed.includes("link_format"), "link inside a sentence");
  assert(grade([`**Brex** Data Analyst:\n${B}`], "imessage", r).failed.includes("markdown"), "markdown on iMessage");
  assert(grade(["word ".repeat(120)], "imessage", {}).failed.includes("bubble_len"), "a wall of text");
  assert(grade([`Data Analyst at Brex:\n${B}`], "imessage", r, { links: [B] }).pass, "the Instinct way passes");
});

Deno.test("fix 1: each link alone on its own line, right after the sentence that names it", () => {
  const lines = linksOnOwnLine(SEARCH).split("\n");
  for (const u of [F, B, N]) {
    const i = lines.indexOf(u);
    assert(i > 0, `${u} alone on a line`);
    const before = lines[i - 1];
    const company = /figma/.test(u) ? "Figma" : /brex/.test(u) ? "Brex" : "Notion";
    assert(before.includes(company) && !findUrls(before).length, `the line before ${company}'s link names it: "${before}"`);
  }
  // Review of #368: every sentence kept, in order; a link-free sentence before or after stays where it was.
  eq(linksOnOwnLine(`Intro here. Data Analyst at Brex (${B}) in Chicago. Trailing words.`), `Intro here.\nData Analyst at Brex in Chicago.\n${B}\nTrailing words.`);
  eq(linksOnOwnLine(`One. Two (${B}). Three. Four (${N}). Five.`), `One.\nTwo.\n${B}\nThree.\nFour.\n${N}\nFive.`);
  // Review of #368: emphasis spanning two sentences is never split open (it stays one unit, rendered whole).
  const bold = linksOnOwnLine(`**Bold. Two** sentences ${B}. Third.`);
  assert(!bold.split("\n").some((l) => (l.match(/\*\*/g) || []).length % 2 === 1), `a line left with an open **: ${JSON.stringify(bold)}`);
  const shown = formatForChannel(`**Bold. Two** sentences ${B}. Third.`, "imessage");
  assert(!/\*/.test(shown) && shown.includes(B) && /Third\./.test(shown), `raw ** reached iMessage: ${JSON.stringify(shown)}`);
  // One sentence with one link keeps today's shape exactly.
  eq(linksOnOwnLine(`Here's the posting: ${B}`), `Here's the posting\n${B}`);
});

Deno.test("fix 1 on the wire: the router's search reply grades clean for links on iMessage, SMS, WhatsApp and Telegram", () => {
  for (const ch of ["imessage", "whatsapp", "telegram"] as const) {
    const bubbles = ch === "imessage" ? imessageNativeRender(SEARCH) : nativeRender(ch, ch === "telegram" ? 4000 : 1500)(SEARCH);
    const g = grade(bubbles, ch, { links: 3, maxBubbles: 6, maxChars: 2000 }, { links: [F, B, N] });
    for (const c of ["link_format", "links_present", "markdown"] as const) assert(!g.failed.includes(c), `${ch}: ${c} ${g.why[c]}\n${JSON.stringify(bubbles)}`);
  }
});

Deno.test("fix 2: no iMessage or SMS bubble runs past a text's length; splits fall between sentences", () => {
  const long = Array.from({ length: 9 }, (_, i) => `This is sentence number ${i + 1}, and it says one plain thing about the role.`).join(" ");
  const b = imessageNativeRender(long);
  assert(b.length > 1, "split");
  for (const x of b) assert(x.length <= 320, `a ${x.length}-char bubble`);
  for (const x of b) assert(/[.!?]$/.test(x), `cut inside a sentence: "${x}"`);
  eq(b.join(" "), long, "nothing lost");
});

Deno.test("fix 3: a texting channel shows a date as a person writes it, never 2026-10-19; links keep theirs", () => {
  const t = formatForChannel("Plaid: applied 2026-10-19.\nhttps://x.example.test/2026-10-19/a", "imessage");
  assert(/Oct 19, 2026/.test(t) && !/applied 2026-10-19/.test(t), t);
  assert(t.includes("https://x.example.test/2026-10-19/a"), "a link is never rewritten");
  assert(formatForChannel("on 2026-10-19", "web").includes("2026-10-19"), "web is unchanged");
  // Review of #368: code is the person's or the employer's text, never rewritten.
  const code = formatForChannel("Set `d='2026-10-19'` then run:\n```\nstart = 2026-10-19\n```\nDue 2026-10-20.", "telegram");
  assert(code.includes("d='2026-10-19'") && code.includes("start = 2026-10-19") && /Oct 20, 2026/.test(code), code);
});

Deno.test("fix 4: the brain's system prompt carries the texting rules on a texting channel, and only there", () => {
  for (const ch of ["imessage", "sms", "whatsapp", "telegram"]) {
    const p = careerSystemPrompt("2026-11-01", { channel: ch });
    assert(/no markdown/i.test(p) && /alone on its own line/i.test(p) && /one question/i.test(p), `${ch} rules missing`);
  }
  assert(!/HOW THIS TEXT LOOKS/.test(careerSystemPrompt("2026-11-01", { channel: "web" })), "web keeps the app's prompt");
  assert(!/HOW THIS TEXT LOOKS/.test(careerSystemPrompt("2026-11-01")), "no channel: unchanged");
});

Deno.test("fix 4 on the path: agentTurn passes the channel to the prompt the model sees", async () => {
  const { agentTurn } = await import("../../supabase/functions/agent-chat/career_brain.ts");
  let system = "";
  const model = async (p: any) => { system = p.system; return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }; };
  await agentTurn({ message: "hi", history: [], stores: {}, userId: "U", threadId: "T", now: Date.UTC(2026, 10, 1), model, channel: "imessage" } as any);
  assert(/HOW THIS TEXT LOOKS \(iMessage\)/.test(system), "the iMessage rules reach the model");
});

Deno.test("fix 1 at the source: the router numbers the roles it lists, and each link lands under its own role", async () => {
  const { openWorld, worldTurn } = await import("../../evals/career/world.ts");
  const world = JSON.parse(Deno.readTextFileSync(new URL("../../evals/career/worlds/in-flight.json", import.meta.url)));
  const w = await openWorld({ now: world.now, postings: world.postings });
  const r = await worldTurn(w, { brain: "router", threadId: "A", message: "find me data analyst jobs in chicago", now: w.now });
  assert(r.intent === "career_discovery", r.intent ?? "no intent");
  assert(/(^|\s)1\) \S/.test(r.reply) && /\s2\) \S/.test(r.reply), `numbered: ${r.reply}`);
  const lines = linksOnOwnLine(r.reply).split("\n");
  for (const [i, l] of lines.entries()) if (findUrls(l).length) assert(findUrls(l)[0].url === l.trim() && /^\d\) /.test(lines[i - 1]), `link under its role: ${lines[i - 1]} / ${l}`);
});

Deno.test("grammar at the source: one role found reads 'Here is 1 role that matches your search', not 'that match'", async () => {
  const { openWorld, worldTurn } = await import("../../evals/career/world.ts");
  const { EXTRA_POSTINGS } = await import("../../evals/career/one-v-one/postings.ts");
  const world = JSON.parse(Deno.readTextFileSync(new URL("../../evals/career/worlds/in-flight.json", import.meta.url)));
  const w = await openWorld({ now: world.now, postings: [...world.postings, ...EXTRA_POSTINGS] });
  const r = await worldTurn(w, { brain: "router", threadId: "A", message: "marketing jobs remote", now: w.now });
  assert(/Here is 1 role that matches your search\./.test(r.reply) && !/role that match your/.test(r.reply), r.reply);
});

// Style targets (evals/career/one-v-one/style-targets.json, derived from the owner's brief, observed): at most 3 sentences a
// bubble on every texting channel, split only between sentences, nothing lost or reordered.
// WhatsApp and Telegram keep their message contract (a Telegram answer in at most two messages, #301; tables and headings
// whole): there the sentence budget is the brain's rule (below), not a cut.
Deno.test("style: no iMessage or SMS bubble carries more than 3 sentences; splits fall between sentences, nothing lost", async () => {
  const { styleOf } = await import("../../evals/career/one-v-one/style.ts");
  const five = "Notion is confirmed. Brex is queued. Figma waits on two answers. Plaid waits on your code. Ramp stopped on a phone number.";
  for (const ch of ["imessage", "sms"] as const) {
    const b = imessageNativeRender(five);
    assert(styleOf(b, ch).sentencesPerBubble <= 3, `${ch}: ${JSON.stringify(b)}`);
    eq(b.join(" "), five, `${ch}: every sentence, in order`);
  }
  eq(imessageNativeRender("One. Two. Three."), ["One. Two. Three."], "three short sentences stay one bubble");
});

Deno.test("style: the texting rules give the brain the numbers (3 sentences a bubble, short sentences, plain words)", () => {
  const p = careerSystemPrompt("2026-11-01", { channel: "imessage" });
  assert(/three sentences/i.test(p) && /20 words/i.test(p) && /grade/i.test(p), p.slice(-900));
});

// ------------------------------------------------------------------------------------------------ review of #368: hardening
const byId = (id: string) => SCENARIOS.find((x) => x.id === id)!;
const g = (id: string, reply: string[]) => { const s = byId(id); return grade(reply, s.channel, s.r, ctxOf(s)); };

Deno.test("hardening: replies that game the rubric pass about none of the 120 (Ok., empty, echo, keyword stuffing, invented)", () => {
  const p = probeCounts();
  for (const k of ["ok", "empty", "echo", "invented", "link"]) eq(p[k], 0, `${k} probe passes`);
  assert(p.stuffing <= 2, `keyword stuffing passes ${p.stuffing}`);
  assert(p.fixed <= 5, `one fixed reply passes ${p.fixed} (only asks whose right answer is "what role and city?")`);
});

Deno.test("hardening: every scenario requires content the person's own message does not already carry", () => {
  for (const s of SCENARIOS) {
    const own = (s.r.must ?? []).filter((m) => !new RegExp(m, "i").test([...(s.prior ?? []), s.msg].join(" ")));
    assert(own.length, `${s.id} has no required content beyond the message`);
  }
});

Deno.test("hardening: each check catches its own mutation of a passing gold reply", () => {
  const v009 = byId("V009").gold;
  assert(g("V009", v009).pass, "the gold passes");
  const fails = (id: string, reply: string[], check: string) => { const r = g(id, reply); assert(r.failed.includes(check as any), `${id} ${check}: ${JSON.stringify(r.why)}`); };
  fails("V009", [...v009.slice(0, -1), "More here:\nhttps://jobs.example.test/x/1", v009.at(-1)!], "links_valid");
  fails("V046", [...byId("V046").gold, "I submitted it already."], "claims");
  fails("V009", v009.map((b) => b.replace(/Stripe|Brex|Notion/g, "Acme")), "facts");
  fails("V009", v009.map((b) => b.replace(/^\d\. /gm, "")), "numbered");
  fails("V033", ["One page. Why? Who knows? Want me to look at yours?"], "questions");
  fails("V033", ["Great question! One page, since a second page mostly gets skipped.", "Want me to look at yours?"], "voice");
  fails("V017", ["Kaiser in Denver lists $98,000 for an RN; contact Dana Smith there.", "Want me to watch for more?"], "invented");
  fails("V024", ["Brex sponsors visas for this role, so you're fine.", "Ask their recruiter if you want it in writing."], "invented");
  fails("V009", [byId("V009").msg], "substance");
  fails("V009", ["stripe brex notion chicago data analyst roles watch"], "substance");
});

Deno.test("hardening: links are allowed per scenario, never from one global list", () => {
  // A real posting link, but V033 (resume length) has no posting in its answer: not allowed there.
  const r = g("V033", ["One page. With under 10 years of experience, a second page mostly gets skipped.", "An example:\nhttps://job-boards.greenhouse.io/brex/jobs/7005005", "Want me to look at yours?"]);
  assert(r.failed.includes("links_valid"), JSON.stringify(r.why));
});

Deno.test("hardening: the harness runs the handler's code turns in the handler's order", () => {
  const src = Deno.readTextFileSync(new URL("../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));
  const a = src.indexOf("async function handleChatInner"), b = src.indexOf("const turn = await agentTurn(", a);
  assert(a > 0 && b > a, "the handler's turn section is found");
  const order: string[] = [];
  for (const m of src.slice(a, b).matchAll(/(?:await|\?\?)\s+\(?(?:await\s+)?([a-zA-Z]+Turn)\(/g)) if (!order.includes(m[1])) order.push(m[1]);
  eq(CODE_TURN_ORDER.map((t) => t.name), order, "evals/career/world.ts CODE_TURN_ORDER must match handler-career.ts");
  for (const t of CODE_TURN_ORDER) assert(t.harness === "runs" || t.harness.length > 10, `${t.name}: runs, or says why not`);
  for (const n of ["cardTurn", "questionsTurn", "outreachTurn", "applyTurn", "followupTurn", "standingTurn", "reminderTurn", "overviewTurn", "applicationsTurn", "networkingTurn", "offerChatTurn"])
    eq(CODE_TURN_ORDER.find((t) => t.name === n)?.harness, "runs", `${n} runs in the harness`);
});

Deno.test("judge: strict JSON; a parse failure, a bad field, a pass that is not the AND, an error or a disagreement is a FAIL", async () => {
  const ok = { answers: true, facts: true, style: true, links: true, pass: true, note: "" };
  eq(parseVerdict(JSON.stringify(ok)).pass, true);
  for (const bad of ["", "not json", "{\"pass\": true}", JSON.stringify({ ...ok, facts: "yes" }), JSON.stringify({ ...ok, facts: false }), "Sure: " + JSON.stringify(ok)]) {
    let threw = false; try { parseVerdict(bad); } catch { threw = true; } assert(threw, `accepted: ${bad}`);
  }
  const say = (texts: string[]) => { let i = 0; return async (_p: any) => ({ content: [{ type: "text", text: texts[i++] }] }); };
  eq((await judgeReply(say([JSON.stringify(ok), JSON.stringify(ok)]), "p")).pass, true, "two passes agree");
  eq((await judgeReply(say([JSON.stringify(ok), "oops"]), "p")).pass, false, "a parse failure fails");
  eq((await judgeReply(say([JSON.stringify(ok), JSON.stringify({ ...ok, style: false, pass: false })]), "p")).pass, false, "a disagreement fails");
  eq((await judgeReply(async () => { throw new Error("429"); }, "p")).pass, false, "a model error fails");
  let seen: any = null;
  await judgeReply(async (p) => { seen = p; return { content: [{ type: "text", text: JSON.stringify(ok) }] }; }, "p");
  assert(seen.temperature === 0 && Number.isInteger(seen.seed) && seen.response_format?.json_schema?.strict === true, "temperature 0, fixed seed, strict schema");
  const body = toOpenAI({ ...seen }, { provider: "openai", model: "gpt-4.1-mini", apiKey: "k", reasoningEffort: null } as any);
  assert(body.temperature === 0 && body.seed === seen.seed && body.response_format?.type === "json_schema", `the request carries them: ${JSON.stringify({ t: body.temperature, s: body.seed })}`);
});

Deno.test("the voice-off arm sets CAREER_TEXTING_NATIVE=off explicitly (an unset flag may mean on once the voice is the default)", async () => {
  const { renderers } = await import("../../evals/career/one-v-one/run.ts");
  const off = await renderers(false), on = await renderers(true);
  const md = "**Brex** Data Analyst";
  assert(off("imessage", md).join("").includes("**"), "off renders as before (raw)");
  assert(!on("imessage", md).join("").includes("**"), "on strips markdown");
  const src = Deno.readTextFileSync(new URL("../../evals/career/one-v-one/run.ts", import.meta.url));
  assert(/CAREER_TEXTING_NATIVE: native \? "on" : "off"/.test(src), "both arms name the flag");
});
