// The situation knowledge and context layer (flag CAREER_KNOWLEDGE, off by default): the playbook library and its lint, the
// Person Context Pack, deterministic retrieval, the wiring behind the flag, and the situation eval's own checks.
// Free: no model, no network.   deno test -A --no-check tests/architect/situation-knowledge.test.ts
import assertNode from "node:assert/strict";
import { PLAYBOOKS } from "../../supabase/functions/_shared/agent/knowledge/playbooks.generated.ts";
import { parsePlaybook, SECTIONS } from "../../supabase/functions/_shared/agent/knowledge/parse.ts";
import { ALL_TAGS, signalsOf } from "../../supabase/functions/_shared/agent/knowledge/signals.ts";
import { buildContextPack, contextPackBlock } from "../../supabase/functions/_shared/agent/knowledge/context_pack.ts";
import { selectPlaybooks } from "../../supabase/functions/_shared/agent/knowledge/retrieve.ts";
import { knowledgeFor, knowledgeOn } from "../../supabase/functions/_shared/agent/knowledge/index.ts";
import { agentTurn } from "../../supabase/functions/agent-chat/career_brain.ts";
import { compile } from "../../scripts/build-playbooks.ts";
import { checkReply, retrievalCheck, score, unsupportedProperNouns, type Situation } from "../../evals/career/situations/situation-knowledge.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const FIX = JSON.parse(Deno.readTextFileSync(new URL("../../evals/career/situations/situations.json", import.meta.url)));
const SITS: Situation[] = FIX.situations;
const fact = (id: string, kind: string, text: string, confirmed = true) => ({ id, kind, text, status: confirmed ? "confirmed" : "draft", needs_confirmation: !confirmed });

// ---------------------------------------------------------------------------------------------------------- the library
Deno.test("library: about 40 playbooks, every file has the four sections, one question at most, a valid trigger", () => {
  const books = PLAYBOOKS.filter((b) => b.kind !== "core");
  ok(books.length >= 40 && books.length <= 60, `${books.length} playbooks`);
  eq(PLAYBOOKS.filter((b) => b.kind === "core").length, 1);
  eq(new Set(PLAYBOOKS.map((b) => b.id)).size, PLAYBOOKS.length, "unique ids");
  for (const b of PLAYBOOKS) {
    const heads = [...b.body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    eq(heads, [...SECTIONS], `${b.id} sections`);
    const section = (name: string) => b.body.split(new RegExp(`^## ${name}$`, "m"))[1]?.split(/^## /m)[0] ?? "";
    const bullets = (s: string) => s.split("\n").filter((l) => /^\s*(?:-|\d+[.)])\s/.test(l));
    ok(bullets(section("Principles")).length >= 2, `${b.id} principles`);
    ok(bullets(section("Steps")).length >= 3, `${b.id} steps`);
    eq(bullets(section("Ask")).length, 1, `${b.id}: exactly one thing to ask`);
    ok(bullets(section("Do not claim")).length >= 1, `${b.id} do-not-claim`);
    if (b.kind !== "core") {
      ok(b.when.length > 0, `${b.id} has a trigger`);
      for (const item of [...b.when, ...b.boost]) for (const tag of item.split("+")) ok(ALL_TAGS.has(tag), `${b.id}: unknown signal ${tag}`);
    }
    const words = b.body.split(/\s+/).length;
    ok(words >= 110 && words <= 520, `${b.id} is ${words} words`);
  }
});

Deno.test("library: the generated module is in sync with the markdown", () => {
  const have = Deno.readTextFileSync(new URL("../../supabase/functions/_shared/agent/knowledge/playbooks.generated.ts", import.meta.url));
  eq(have, compile(), "run: deno run -A scripts/build-playbooks.ts");
});

// LINT: playbooks are method. No invented company, pay figure, statistic or date.
const MONTH = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|oct|nov|dec)\b\.?\s*\d{0,4}/i;
const CAPS_OK = new Set(["I", "I'm", "I'd", "I'll", "I've", "GPA", "LinkedIn", "Indeed", "Friday", "B", "One"]);
const DENY = ["google", "amazon", "microsoft", "meta ", "apple", "netflix", "goldman", "morgan", "mckinsey", "deloitte", "stripe", "openai", "anthropic", "tesla", "nvidia", "salesforce", "walmart", "boeing", "nasa", "linkedin learning", "coursera", "udemy", "leetcode", "y combinator", "techstars", "fulbright", "rhodes", "forbes"];
export function lintPlaybook(body: string): string[] {
  const problems: string[] = [];
  const text = body.replace(/\r/g, "");
  if (/\$\s?\d/.test(text)) problems.push("a dollar figure");
  if (/\d\s?%|\bpercent\b/i.test(text)) problems.push("a percentage");
  if (/\b\d+\s?k\b/i.test(text)) problems.push("a pay figure like 90k");
  if (/\b(19|20)\d\d\b/.test(text)) problems.push("a year");
  if (MONTH.test(text.replace(/\bmay\b(?! \d)/gi, "") )) problems.push("a month or date");
  if (/https?:\/\/|www\.|@\w+\.\w+/i.test(text)) problems.push("a link or email address");
  // "Do not claim" may say what never to promise; the rest of a playbook may not promise anything itself.
  if (/\bguarantee[sd]?\b/i.test(text.split(/^## Do not claim$/m)[0])) problems.push("a guarantee");
  for (const d of DENY) if (new RegExp(`(^|[^a-z])${d.trim()}([^a-z]|$)`, "i").test(text)) problems.push(`the name "${d.trim()}"`);
  // A capitalized word in the middle of a sentence must be a generic term.
  for (const line of text.split("\n")) {
    if (/^##\s/.test(line)) continue;
    const t = line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").replace(/\[[^\]]*\]/g, " ");
    const re = /[A-Za-z][A-Za-z'’-]*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      const before = t.slice(0, m.index).trimEnd();
      const start = before === "" || /[.?!:"“—–(]$/.test(before);
      if (!start && /^[A-Z]/.test(m[0]) && !CAPS_OK.has(m[0].replace(/[.'’-]+$/, ""))) problems.push(`unexplained proper name "${m[0]}"`);
    }
  }
  return problems;
}

Deno.test("lint: every playbook is method only: no invented company, pay, statistic or date", () => {
  for (const b of PLAYBOOKS) eq(lintPlaybook(b.body), [], b.id);
});

Deno.test("lint: the linter itself catches an invented company, salary, statistic and date", () => {
  ok(lintPlaybook("## Steps\n- Apply to Acme Corp, which pays $90,000.").length >= 2);
  ok(lintPlaybook("- Most students get hired within 6 months, 80% of the time.").length >= 1);
  ok(lintPlaybook("- Applications open in September 2027.").length >= 1);
  ok(lintPlaybook("- Try Google, Amazon and Stripe first.").length >= 3);
  eq(lintPlaybook("- Write to the founder of a small studio near you."), []);
});

Deno.test("parse: bad front matter is refused", () => {
  assertNode.throws(() => parsePlaybook("no front matter"));
  assertNode.throws(() => parsePlaybook("---\nid: x\nkind: nope\n---\nbody"));
});

// ---------------------------------------------------------------------------------------------------------- signals
Deno.test("signals: stage, context and topic from plain words", () => {
  const t = (s: string) => [...signalsOf(s).tags].sort();
  ok(t("I'm a freshman studying economics").includes("stage:freshman"));
  ok(!t("my first year at the job was hard").includes("stage:freshman"), "a first year at a job is not a freshman");
  ok(!t("I applied for a junior analyst role").includes("stage:junior"), "a junior role is not a junior student");
  ok(t("I'm a junior in college").includes("stage:junior"));
  ok(t("I was laid off last week").includes("stage:laid_off"));
  ok(t("I'm on an F-1 and need sponsorship").includes("ctx:international"));
  ok(t("my GPA is 2.7").includes("ctx:low_gpa"));
  ok(!t("my GPA is 3.8").includes("ctx:low_gpa"));
  ok(t("how do I write a cold email to a founder").includes("topic:cold_email"));
  ok(t("I have 12 years of experience").includes("stage:mid_career"));
  eq(signalsOf("").tags.size, 0);
});

// ---------------------------------------------------------------------------------------------------------- the pack
Deno.test("pack: confirmed facts are confirmed; a draft fact or chat words are only 'said'; nothing else is invented", () => {
  const profile = { facts: [fact("F-1", "education", "Sophomore majoring in computer science"), fact("F-2", "skill", "Python", false), fact("F-3", "experience", "Built a laundry schedule app", true)] };
  const p = buildContextPack({ profile, message: "how do I get an internship?" });
  eq(p.stage.value, "sophomore"); eq(p.stage.status, "confirmed"); eq(p.stage.from, "F-1");
  eq(p.major.value, "computer science"); eq(p.major.status, "confirmed");
  eq(p.skills.status, "said", "an unconfirmed fact is not confirmed");
  eq(p.projects.status, "confirmed");
  eq(p.goals.status, "unknown"); eq(p.places.status, "unknown"); eq(p.authorization.status, "unknown");
  ok(p.unknown.includes("target role or field"));
  ok(!p.unknown.some((u) => /major|career stage/.test(u)), "known things are not listed as unknown");
  const block = contextPackBlock(p);
  ok(/Stage: sophomore \[confirmed F-1\]/.test(block));
  ok(/Skills: Python \[said, not confirmed\]/.test(block));
  ok(/Work authorization: unknown/.test(block));
  ok(/AT MOST ONE/.test(block));
});

Deno.test("pack: the message beats a confirmed fact for stage; an earlier chat statement is only 'said'; rejected and agent-made rows never count", () => {
  const profile = { facts: [fact("F-1", "education", "Freshman"), { ...fact("F-9", "education", "Senior at a big university"), status: "rejected" }, { ...fact("F-8", "goal", "CEO of everything"), source: "agent-generated" }] };
  eq(buildContextPack({ profile, message: "I'm now a sophomore, help" }).stage.value, "sophomore");
  const chat = buildContextPack({ profile: null, message: "what should I do", history: [{ role: "user", content: "I'm a senior in college" }, { role: "assistant", content: "ok" }] });
  eq(chat.stage.value, "senior"); eq(chat.stage.status, "said");
  const p = buildContextPack({ profile, message: "hi" });
  eq(p.stage.value, "freshman");
  eq(p.goals.status, "unknown", "an agent-generated goal is not the person's");
});

Deno.test("pack: standing instructions and the pay floor are constraints; alerts and tasks show", () => {
  const p = buildContextPack({ profile: { facts: [], preferences: { compFloor: "$80k", remote: "only" } }, standing: [{ id: "S-001", text: "no staffing agencies", said: "no staffing agencies", at: "2026-10-01" }], alertsLine: "Job alerts: on, for analyst", situation: { tasks: [{}, {}], next: [{ who: "person", what: "approve the card" }] }, message: "hello" });
  ok(p.constraints.value!.some((c) => /staffing/.test(c)) && p.constraints.value!.some((c) => /pay floor/.test(c)));
  eq(p.alerts, "Job alerts: on, for analyst");
  ok(/2 task/.test(p.in_flight!));
});

Deno.test("pack: values trace to the person's words (every situation, no invented field)", () => {
  for (const s of SITS) {
    const k = knowledgeFor({ profile: { facts: s.facts.map((f) => fact(f.id, f.kind, f.text, f.confirmed)) }, history: s.history, message: s.message });
    const source = (s.facts.map((f) => f.text).join(" ") + " " + s.message + " " + s.history.map((h) => h.content).join(" ")).toLowerCase().replace(/\s+/g, " ");
    const vals = [k.pack.major.value, k.pack.authorization.value, ...(k.pack.experience.value ?? []), ...(k.pack.skills.value ?? []), ...(k.pack.projects.value ?? []), ...(k.pack.education.value ?? []), ...(k.pack.goals.value ?? [])];
    for (const v of vals) if (v) ok(source.includes(v.toLowerCase().replace(/\s+/g, " ").slice(0, 40)) || /pay floor|remote:/.test(v), `${s.id}: "${v}" is not in anything they said`);
  }
});

// ---------------------------------------------------------------------------------------------------------- retrieval
Deno.test("retrieval: the freshman asking about small firms gets the freshman, small-firm and cold-email playbooks", () => {
  const k = knowledgeFor({ profile: { facts: [fact("F-1", "education", "Freshman at a state university, economics major")] }, message: "How do I get those internships at small firms or startups?" });
  eq(new Set(k.playbooks), new Set(["stage-freshman", "emp-small-firms-startups-approach", "how-cold-email"]));
  ok(/Stage: freshman \[confirmed F-1\]/.test(k.text));
  ok(k.text.includes("### Playbook: core"));
});

Deno.test("retrieval: a follow-up with no topic uses the person's previous message and their confirmed stage", () => {
  const k = knowledgeFor({ profile: { facts: [fact("F-1", "education", "Freshman, economics")] }, history: [{ role: "user", content: "I want an internship" }, { role: "assistant", content: "Tell me more." }], message: "how do I get those?" });
  ok(k.playbooks.includes("stage-freshman"));
});

Deno.test("retrieval: deterministic, at most 3, one stage playbook, emotional first for distress, nothing for a bare greeting", () => {
  for (const s of SITS) {
    const a = retrievalCheck(s), b = retrievalCheck(s);
    eq(a.picked, b.picked, s.id);
    ok(a.picked.length <= 3);
    ok(a.picked.filter((id) => PLAYBOOKS.find((p) => p.id === id)!.kind === "stage").length <= 1, `${s.id} two stage playbooks`);
    for (const id of a.picked) ok(PLAYBOOKS.some((p) => p.id === id));
  }
  eq(knowledgeFor({ message: "hey" }).playbooks, []);
  eq(knowledgeFor({ message: "I got rejected after the final round and feel hopeless" }).playbooks[0], "emo-rejection");
});

Deno.test("retrieval: the pack decides what is picked, not the playbook order", () => {
  const pack = buildContextPack({ message: "I'm a sophomore. Cold email a professor?" });
  const a = selectPlaybooks(pack, PLAYBOOKS).map((x) => x.book.id), b = selectPlaybooks(pack, [...PLAYBOOKS].reverse()).map((x) => x.book.id);
  eq(a, b);
});

// ---------------------------------------------------------------------------------------------------------- wiring
function modelSpy() {
  const seen: string[] = [];
  const model = async (p: { system: string }) => { seen.push(p.system); return { content: [{ type: "text", text: "Here is a plan you can start this week: first, list ten places. Which field?" }], stop_reason: "end_turn" }; };
  return { seen, model };
}
const base = (extra: Record<string, unknown>) => ({ message: "I'm a freshman. How do I get internships at small firms?", history: [], stores: {}, userId: "u1", threadId: "t1", now: Date.UTC(2026, 9, 28), ...extra });

Deno.test("wiring: the flag is off unless CAREER_KNOWLEDGE=on", () => {
  eq(knowledgeOn({ get: () => undefined }), false);
  eq(knowledgeOn({ get: (k) => (k === "CAREER_KNOWLEDGE" ? "yes" : undefined) }), false);
  eq(knowledgeOn({ get: (k) => (k === "CAREER_KNOWLEDGE" ? "on" : undefined) }), true);
});

Deno.test("wiring: off, the system prompt is byte for byte what it was; on, it carries the pack and the playbooks", async () => {
  const off = modelSpy(), none = modelSpy(), on = modelSpy();
  const a = await agentTurn({ ...base({}), model: off.model } as any);
  await agentTurn({ ...base({ knowledge: false }), model: none.model } as any);
  const c = await agentTurn({ ...base({ knowledge: true }), model: on.model } as any);
  eq(off.seen[0], none.seen[0]);
  ok(!off.seen[0].includes("PERSON CONTEXT PACK") && !off.seen[0].includes("### Playbook"));
  ok(on.seen[0].startsWith(off.seen[0].slice(0, 400)));
  ok(on.seen[0].includes("PERSON CONTEXT PACK") && on.seen[0].includes("### Playbook: stage-freshman") && on.seen[0].includes("### Playbook: core"));
  eq((a as any).knowledge, undefined);
  ok((c as any).knowledge.playbooks.includes("emp-small-firms-startups-approach"));
  eq((c as any).knowledge.stage, "freshman");
  ok(c.reply.length > 0);
});

// ---------------------------------------------------------------------------------------------------------- the eval
Deno.test("eval fixture: 100+ situations, 21 deep, the freshman small-firm case first, every referenced playbook exists", () => {
  ok(SITS.length >= 100, `${SITS.length}`);
  eq(SITS.filter((s) => s.deep).length, 21);
  ok(/freshman/i.test(SITS[0].message) && /small/i.test(SITS[0].message));
  eq(new Set(SITS.map((s) => s.id)).size, SITS.length);
  eq(new Set(SITS.map((s) => s.message)).size, SITS.length, "no duplicate prompts");
  const ids = new Set(PLAYBOOKS.map((p) => p.id));
  for (const s of SITS) for (const id of [...s.expect_playbooks, ...s.none_of]) ok(ids.has(id), `${s.id}: ${id}`);
  for (const s of SITS.filter((x) => x.deep)) ok(s.must_use.length >= 1 && s.must_cover.length >= 2, `${s.id} deep checks`);
  ok(new Set(SITS.flatMap((s) => s.expect_playbooks)).size >= 35, "the set exercises most of the library");
});

Deno.test("eval: retrieval picks the expected playbooks for every situation", () => {
  const bad = SITS.map((s) => ({ s, r: retrievalCheck(s) })).filter((x) => !x.r.ok).map((x) => `${x.s.id} missing ${x.r.missing} unwanted ${x.r.unwanted}`);
  eq(bad, []);
});

const S1 = SITS[0];
Deno.test("eval: a generic reply fails; a specific, honest one passes", () => {
  const generic = "Great question! Internships are competitive, so you should reach out to your network and leverage your skills. Keep your head up and best of luck!";
  const r = score(checkReply(S1, generic));
  ok(!r.clean && (r.dims.specific ?? 5) < 3 && (r.dims.natural ?? 5) < 5);
  const good = "As a freshman in economics, your best shot is small firms, startups and local businesses, not big recruiting programs.\n1. This week, list 15 small organizations in Columbus that do work an econ major could help with.\n2. Build one small analysis of a public data set and put it on a single page.\n3. Email the founder or manager with one specific line about their work and a 15 minute ask, then follow up once.\nAsk your career center and a professor for help-wanted notes too. What kind of work interests you?";
  const g = score(checkReply(S1, good));
  eq(g.failed.map((f) => f.why), []);
});

Deno.test("eval: invented companies, pay, dates, claims and two questions are caught as trust breaks", () => {
  const bad = "As a freshman in economics you could join Goldman Sachs, which pays $85,000 and opens applications on September 12th. I've sent your email to them. First do this. Do you like finance? Where do you live?";
  const res = checkReply(S1, bad);
  const failed = res.filter((r) => !r.ok).map((r) => r.why);
  ok(failed.some((w) => /company or program/.test(w)), failed.join("|"));
  ok(failed.some((w) => /pay or percent/.test(w)));
  ok(failed.some((w) => /specific date/.test(w)));
  ok(failed.some((w) => /sent or applied/.test(w)));
  ok(failed.some((w) => /at most one question/.test(w)));
  ok(score(res).dims.truthful! <= 2, "a hard failure caps the dimension at 2");
  eq(unsupportedProperNouns("You could try working at Acmeco this week.", "freshman"), ["Acmeco"]);
  eq(unsupportedProperNouns("Ask the career center about Handshake and LinkedIn.", "freshman"), []);
});

Deno.test("eval: asking for what the person already told us is a hard question failure", () => {
  const res = checkReply(S1, "Sure. Are you a freshman or a student? Tell me more about yourself. First, list firms this week.");
  ok(res.some((r) => !r.ok && r.d === "question" && r.hard));
});
