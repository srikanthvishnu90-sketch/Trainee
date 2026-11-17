// Review of #849, round 9 (2026-11-15). Earlier tests are unchanged. Fixtures are invented. Stub judges only; no network.
// B1: every employer a comparison gives a figure or date must have it in its OWN unit, whatever the word order or phrasing.
// B2: code's record check covers only the "isn't on file" template; every other clause of the sentence is checked as usual.
// B3: an employer that opens a sentence beside a full date some unit holds is still checked against that unit's employer.
// B4: plain advice, Trainee's own offers and needs lists (no figure or date) stand; a posting with no company field is its URL's
//     employer's; the fallback lists the one posting's facts when the ask names no employer.
// B5: a hard cap on judge calls and claims per reply, failing closed past it; the trace counts every judge call and claim.
// (namespace imports, so each test runs, and fails on its own, against a head that lacks the names this round adds)
import * as RP from "../../../supabase/functions/_shared/agent/reply_pipeline.ts";
import * as SP from "../../../supabase/functions/_shared/agent/research/support.ts";
import { agentTurn } from "../../../supabase/functions/agent-chat/career_brain.ts";
import { FAIL_CLOSED } from "../../../supabase/functions/_shared/agent/research/market.ts";
import { testSupportJudge } from "../support-test-judge.ts";
const { Ledger, runReplyPipeline } = RP, { keepSupported } = SP;
type Ledger = InstanceType<typeof RP.Ledger>;
const REPLY_JUDGE_MAX_CALLS: number = (RP as any).REPLY_JUDGE_MAX_CALLS ?? Infinity, REPLY_JUDGE_MAX_CLAIMS: number = (RP as any).REPLY_JUDGE_MAX_CLAIMS ?? Infinity;
const recordCheck = (w: string): (s: string) => boolean | null => { const f = (SP as any).recordCheck; if (typeof f !== "function") throw new Error("support.ts has no recordCheck"); return f(w); };

FAIL_CLOSED.support = true;
function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
type C = { claim: string; source: string };
const yes = async (cs: C[]) => cs.map(() => "yes" as const);
const no = async (cs: C[]) => cs.map(() => "no" as const);
const words = testSupportJudge;
const id = (l: Ledger, re: RegExp) => l.units.find((u) => re.test(u.text))!.id;
const paypal = (l: Ledger, extra: Record<string, unknown> = {}) => l.fromToolResult("get_posting", { posting: { company: "PayPal", title: "SWE Intern", location: "Chicago, IL", pay: "$28-$49 an hour", state: "open", url: "https://paypal.example/1", ...extra } });
const citadel = (l: Ledger) => l.fromToolResult("get_posting", { posting: { company: "Citadel", title: "SWE Intern", location: "New York, NY", pay: "$80 an hour", state: "open", url: "https://citadel.example/1" } });
const both = () => { const l = new Ledger(); paypal(l); citadel(l); return l; };
const P = (l: Ledger) => id(l, /^PayPal.*pay/), Ct = (l: Ledger) => id(l, /^Citadel.*pay/);

Deno.test("#849 round 9 B1: a figure a comparison gives two employers must be in each one's own unit, in any order or phrasing", async () => {
  // Fail-open on f39fe18e9: only the last-named employer's part carried the figure, so PayPal's unit was never asked for $80.
  for (const s of ["Both PayPal and Citadel pay $80 an hour", "PayPal, like Citadel, pays $80 an hour", "Citadel pays $80 an hour, the same as PayPal",
    "Citadel pays $80 an hour and so does PayPal", "PayPal and Citadel pay $80 an hour", "PayPal matches Citadel at $80 an hour", "Citadel and PayPal each pay $80 an hour"]) {
    for (const cite of [(l: Ledger) => `${P(l)},${Ct(l)}`, (l: Ledger) => Ct(l)]) for (const j of [yes, words]) {
      const l = both();
      const out = await runReplyPipeline(`${s} [${cite(l)}].`, l, { judge: j, ask: "compare paypal and citadel pay", repair: null });
      eq(out.text.includes("$80"), false, `${s} [${cite(l)}] ${out.text}`);
    }
  }
  // Dates too: a shared date is each employer's own.
  const l = both(); const pd = l.fromToolResult("get_posting", { posting: { company: "PayPal", title: "SWE Intern", state: "open", deadline: "December 7, 2026", url: "https://paypal.example/1" } });
  const cd = l.fromToolResult("get_posting", { posting: { company: "Citadel", title: "SWE Intern", state: "open", url: "https://citadel.example/1" } });
  const out = await runReplyPipeline(`PayPal and Citadel both close December 7, 2026 [${pd.at(-1)},${cd.at(-1)}].`, l, { judge: yes, ask: "when do they close", repair: null });
  eq(out.text.includes("December 7"), false, out.text);
  // Each employer with its own figure stands, in either order.
  for (const s of ["PayPal pays $28-$49 an hour and Citadel pays $80 an hour", "Citadel pays $80 an hour and PayPal pays $28-$49 an hour", "Citadel pays $80 an hour, more than PayPal's $28-$49 an hour"]) {
    const m = both();
    const o2 = await runReplyPipeline(`${s} [${P(m)},${Ct(m)}].`, m, { judge: yes, ask: "compare paypal and citadel pay", repair: null });
    eq(o2.text.startsWith(s), true, `${s}: ${o2.text}`);
  }
});

const onRecordOf = () => recordCheck(["education Lakeshore University BS Computer Science", "skill Python", "experience Harbor Global, Intern", "experience Crestline Partners"].join("\n").toLowerCase());
Deno.test("#849 round 9 B2: the record check covers only the 'isn't on file' part; any other clause is checked", async () => {
  const l = new Ledger(); citadel(l);
  for (const s of ["Citadel pays $150 an hour, but your phone isn't on file.", "Citadel sponsors H-1B visas for every intern, and your phone and city aren't on file.",
    "I don't have proof Citadel's deadline was moved to January 3, 2027 on file."]) {
    // Fail-open on f39fe18e9: the whole sentence skipped every check. Also with a caller whose check says yes to anything.
    for (const r0 of [() => true, null]) {
      const rec = r0 ?? onRecordOf();
      const out = await runReplyPipeline(s, l, { judge: no, onRecord: rec, ask: "what does citadel pay", repair: null });
      eq(out.text.includes(s.slice(0, 20)), false, `${s}: ${out.text}`);
      const k = await keepSupported(s, [{ text: "Citadel, SWE Intern (New York, NY): pay $80 an hour" }], { judge: yes, onRecord: rec });
      eq(k.text, "", `legacy: ${s}`);
    }
  }
  const onRecord = onRecordOf();
  // The template's free part may not carry a figure, a date or a name the record does not hold.
  eq(onRecord("Citadel pays $150 an hour, but your phone isn't on file."), null, "a figure in the template's free part");
  eq(onRecord("I don't have proof Citadel's deadline was moved to January 3, 2027 on file."), null, "a date and an employer in it");
  eq(onRecord("Citadel's offer isn't on file."), null, "a name the record does not hold");
  eq(onRecord("Your city and phone aren't on file."), true, "a plain gap");
  eq(onRecord("Harbor Global's dates aren't on file."), true, "a record name with its gap");
  eq(onRecord("Your education isn't on file."), false, "the record holds it");
  // The gap alone still stands, unjudged, and a gap clause beside a true, cited fact does not sink it.
  const out = await runReplyPipeline(`Citadel pays $80 an hour [${Ct(both())}], but your phone isn't on file.`, both(), { judge: yes, onRecord, ask: "what does citadel pay", repair: null });
  eq(out.text.startsWith("Citadel pays $80 an hour, but your phone isn't on file."), true, out.text);
  const g = await runReplyPipeline("Your city and phone aren't on file.", l, { judge: no, onRecord, ask: "x", repair: null });
  eq(g.text.startsWith("Your city and phone aren't on file."), true, g.text);
});

Deno.test("#849 round 9 B3: an employer opening a sentence beside a date some unit holds is checked against that unit's employer", async () => {
  const mk = () => { const l = new Ledger(); paypal(l, { deadline: "2026-12-07" }); return l; };
  for (const s of ["Citadel closes December 7, 2026", "Citadel's posting closes December 7, 2026", "Goldman closes applications on December 7, 2026", "Citadel closes 2026-12-07"]) {
    for (const j of [yes, words]) {
      const l = mk();
      const out = await runReplyPipeline(`${s} [${id(l, /closes/)}].`, l, { judge: j, ask: "when does it close", repair: null });
      eq(out.text.startsWith(s), false, `${s}: ${out.text}`);
    }
    const k = await keepSupported(`${s}.`, [{ text: "PayPal, SWE Intern: the posting is open; it closes 2026-12-07.", title: "Posting record" }], { judge: yes });
    eq(k.text, "", `legacy: ${s}`);
  }
  // Live-12 C11 still stands: "Applications" is the sentence's subject word, and the date ties it to PayPal's unit.
  const l = new Ledger(); paypal(l, { deadline: "2026-12-06" });
  const out = await runReplyPipeline(`Applications are open through Sunday, December 6th, 2026 [${id(l, /closes/)}].`, l, { judge: yes, ask: "is the paypal role open", repair: null });
  eq(out.text.startsWith("Applications are open through Sunday, December 6th, 2026."), true, out.text);
});

Deno.test("#849 round 9 B4: plain advice, Trainee's own offers and needs lists stand; a posting with no company is its URL's employer's", async () => {
  // (a) plain talk: no figure, no name, no date: needs no tag and no unit that states it.
  // (Amended under the round-10 ruling, D-088: no shape skips the check. Advice stands on the judge's yes and drops on its no; the
  // word judge, which only matches words, is measured in the report, not asserted here.)
  for (const a of ["Apply early in the cycle.", "Lead your message with the project closest to the role.", "Keep it short and specific.", "Mention the team you want to join.", "Ask for a referral only after a short chat."]) {
    for (const j of [yes]) {
      const l = new Ledger(); paypal(l);
      const out = await runReplyPipeline(`PayPal's SWE Intern pays $28-$49 an hour [${P(l)}]. ${a}`, l, { judge: j, ask: "what does it pay and any tips", repair: null });
      eq(out.text.includes(a), true, `${a}: ${out.text}`);
    }
  }
  // ... but a claim about the world in plain words is still checked.
  for (const c of ["Citadel stopped hiring interns.", "Hospitals have stopped checking licences.", "Most interns there get return offers."]) {
    const l = new Ledger(); paypal(l);
    const out = await runReplyPipeline(`PayPal's SWE Intern pays $28-$49 an hour [${P(l)}]. ${c}`, l, { judge: words, ask: "what does it pay", repair: null });
    eq(out.text.includes(c), false, `${c}: ${out.text}`);
  }
  // (b) Trainee's own offer naming the turn's employer, and its own list of what it needs from the person's record.
  const rec = (l: Ledger) => l.addRecord(["experience: Harbor Global, Intern: AI tooling.", "experience: Crestline Partners, Private equity intern (2025)."], ["email"]);
  for (const [d, keep] of [
    ["Want me to prepare the PayPal application for your approval?", true],
    ["I need your email, Harbor Global's dates, and Crestline's exact name.", true],
    ["Before sending, settle your email, Harbor Global's dates, and the Crestline name.", true],
    ["Want me to prepare the PayPal application before it closes December 9, 2026?", false],
    ["I need your email because PayPal pays $90 an hour.", false],
    ["Want me to apply to Goldman Sachs for you?", false],
  ] as const) {
    // (amended under the round-10 ruling: a yes judge keeps the offers and lists; the ones with a date, a figure or an unknown
    // employer are refused by code even then)
    const l = new Ledger(); paypal(l); rec(l);
    const out = await runReplyPipeline(`PayPal's SWE Intern pays $28-$49 an hour [${P(l)}]. ${d}`, l, { judge: yes, ask: "apply to paypal", repair: null });
    eq(out.text.includes(d), keep, `${d}: ${out.text}`);
  }
  // (c) An apply-flow result whose posting has no company field (Workday): its units are the URL's employer's.
  const flow = () => { const l = new Ledger(); l.fromToolResult("inspect_apply_flow", { url: "https://paypal.wd1.myworkdayjobs.com/x", posting: { title: "Software Engineer Intern - Summer 2027", location: "San Jose, CA", pay: "Chicago, Illinois: $28- $49 Hourly", state: "open", deadline: "2026-12-07" } }); return l; };
  for (const j of [yes, words]) {
    const l = flow();
    // (the word judge reads "$28- $49 Hourly" as other words than "$28-$49 an hour"; code's part is what is tested here, so the pay
    // sentence is judged yes, and the deadline below by both)
    const o1 = await runReplyPipeline(`PayPal's Chicago pay is $28-$49 an hour [${id(l, /Chicago/)}].`, l, { judge: yes, ask: "what does the paypal role pay in chicago", repair: null });
    eq(o1.text.startsWith("PayPal's Chicago pay is $28-$49 an hour."), true, o1.text);
    const l2 = flow();
    const dl = j === yes ? "December 7, 2026" : "2026-12-07"; // (the word judge does not read one date written two ways)
    const o2 = await runReplyPipeline(`PayPal's posting closes ${dl} [${id(l2, /closes/)}].`, l2, { judge: j, ask: "when does the paypal posting close", repair: null });
    eq(o2.text.startsWith(`PayPal's posting closes ${dl}.`), true, o2.text);
    // (another employer never takes them)
    const l3 = flow();
    const o3 = await runReplyPipeline(`Citadel's Chicago pay is $28-$49 an hour [${id(l3, /Chicago/)}].`, l3, { judge: j, ask: "what does citadel pay", repair: null });
    eq(o3.text.includes("$28-$49 an hour."), false, o3.text);
  }
  // (d) The fallback on a one-posting turn whose ask names no employer lists that posting's facts.
  const l = new Ledger(); paypal(l);
  const fb = await runReplyPipeline(`It pays $99 an hour [${P(l)}].`, l, { judge: yes, ask: "what's the pay?", repair: null });
  eq([fb.fallback, fb.text.includes("$28-$49"), fb.text.includes("$99")], [true, true, false], fb.text);
});

Deno.test("#849 round 9 B5: judge calls per reply are capped, past the cap it fails closed, and the trace counts every call and claim", async () => {
  const STEPS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango"];
  for (const N of [3, 10, 20]) {
    const cos = ["Acme", ...Array.from({ length: N }, (_, i) => `Beta${String.fromCharCode(65 + i)}corp`)];
    const l = new Ledger(); const open: Record<string, string> = {};
    for (const c of cos) { l.fromToolResult("get_posting", { posting: { company: c, title: "Intern", state: "open", url: `https://${c.toLowerCase()}.example/1` } }); open[c] = l.units.find((u) => u.owner === c && /open/.test(u.text))!.id; }
    const pg = STEPS.slice(0, N).map((s) => l.add("page", `Interns must pass screening step ${s}.`, { host: "s.example", url: "https://s.example/x" }));
    const sentences = [`Acme's posting is open [${open.Acme}].`, ...STEPS.slice(0, N).map((s, i) => `Interns must pass screening step ${s} [${pg[i]}], and ${cos[i + 1]}'s posting is open [${open[cos[i + 1]]}].`)];
    let calls = 0, claims = 0; const said = new Map<string, string>();
    const judge = async (cs: C[]) => { calls++; claims += cs.length; return cs.map((c) => { const v = /^Acme's posting/.test(c.claim) || /^Interns must pass/.test(c.claim) ? "no" as const : "yes" as const; said.set(c.claim, v); return v; }); };
    const out = await runReplyPipeline(sentences.join(" "), l, { judge, ask: "which postings are open", repair: async () => sentences.slice(1).join("\n") });
    eq(calls <= Math.min(4, REPLY_JUDGE_MAX_CALLS), true, `${N + 1} sentences: ${calls} judge calls`);
    eq(claims <= REPLY_JUDGE_MAX_CLAIMS, true, `${N + 1} sentences: ${claims} claims`);
    eq([(out as any).judgeCalls, (out as any).judgeClaims], [calls, claims], `the trace counts every call and claim (${N + 1} sentences)`);
    eq(out.calls, 1, "one repair call");
    // Fail closed: nothing the judge did not say yes to is sent.
    for (const s of sentences) { const t = s.replace(/\s*\[E[\d,E]+\]/g, ""); if (out.text.includes(t.slice(0, 40))) eq(said.get(t.replace(/\.$/, "")) ?? said.get(t), "yes", t); }
  }
  eq(REPLY_JUDGE_MAX_CALLS <= 4, true, "at most four judge calls a reply");
  // A plain reply's claims go to the judge in one call.
  const l = both(); let n = 0;
  const out = await runReplyPipeline(`PayPal's SWE Intern pays $28-$49 an hour [${P(l)}]. Citadel's SWE Intern pays $80 an hour [${Ct(l)}]. Citadel's posting is open [${id(l, /^Citadel.*open/)}].`, l,
    { judge: async (cs) => { n++; return cs.map(() => "yes"); }, ask: "compare", repair: null });
  eq([n, (out as any).judgeCalls], [1, 1], out.text);
});

Deno.test("#849 round 9 B5 (turn): the trace of a real turn counts the judge's calls and claims", async () => {
  const NOW = Date.parse("2026-11-14T15:00:00Z");
  const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
  const tool = { name: "get_posting_test", effect: "read", description: "Read one posting (test).", input_schema: { type: "object", properties: {} },
    run: async () => ({ posting: { company: "Hudson Ridge Capital", title: "Summer Analyst 2027", location: "New York, NY", pay: "$55 - $60 Hourly", state: "open", url: "https://careers.hudsonridge.example/sa" } }) };
  const m = async (p: any) => {
    if (!p.tools?.length) return text("");
    const tr = (p.messages ?? []).flatMap((x: any) => Array.isArray(x.content) ? x.content : []).filter((b: any) => b?.type === "tool_result");
    if (!tr.length) return { content: [{ type: "tool_use", id: "t1", name: "get_posting_test", input: {} }], stop_reason: "tool_use" };
    const ev: string[] = JSON.parse(String(tr.at(-1).content)).evidence ?? [];
    const e = /^\[(E\d+)\]/.exec(ev.find((x) => /pay/.test(x)) ?? "")?.[1];
    return text(`Hudson Ridge Capital's Summer Analyst role pays $55-$60 an hour [${e}].`);
  };
  const r: any = await agentTurn({ message: "what does the hudson ridge capital role pay", history: [], stores: { profile: { facts: [] } }, userId: "u-r9", threadId: "th-r9", now: NOW, model: m, capabilities: [tool], market: { judge: yes } } as any);
  eq(r.pipeline, "tagged", "tagged path");
  eq([r.piped?.judgeCalls, r.piped?.judgeClaims, r.piped?.calls], [1, 1, 0], JSON.stringify(r.piped));
});

Deno.test("#849 round 9 notes: first-pass drops are kept when the repair adds nothing; a sentence cut for length leaves no link", async () => {
  const l = new Ledger(); paypal(l);
  const d = `PayPal's SWE Intern pays $28-$49 an hour [${P(l)}]. It pays $99 an hour in Austin [${P(l)}].`;
  const out = await runReplyPipeline(d, l, { judge: yes, ask: "what does paypal pay", repair: async () => `PayPal's SWE Intern pays $28-$49 an hour [${P(l)}].` });
  eq(out.dropped.map((f) => f.sentence), ["It pays $99 an hour in Austin."], JSON.stringify(out.dropped));
  // Length: the second sentence (Citadel's, with its own link) is cut; its link goes with it.
  const m = both();
  const o2 = await runReplyPipeline(`PayPal's SWE Intern pays $28-$49 an hour [${P(m)}]. Citadel's SWE Intern in New York pays $80 an hour [${Ct(m)}].`, m, { judge: yes, ask: "compare", repair: null, maxChars: 60 });
  eq([o2.text.includes("paypal.example"), o2.text.includes("citadel.example")], [true, false], o2.text);
});
