// 1v1 (2026-11-01): Trainee against the architect's gold replies on the 120 scenarios (scenarios.ts), scored by script
// (score.ts). No model and no judge: free, deterministic, runs in CI.
//
// Trainee's side runs the live path in-process: each scenario's account state is seeded (world.ts openWorld, the handler's
// order over in-memory stores: the situation read, the chat input, the apply card, the open questions, outreach, then the
// router), its prior turns run first in the same thread, and the graded reply goes through the channel's own adapter render
// (channel_registry.ts adaptersFromEnv, the one the outbox and the webhooks use), with CAREER_TEXTING_NATIVE off (the
// default) and on. Web gets the reply as the app shows it.
//
// The staged brain (CAREER_BRAIN=staged) is measured two ways without a paid model: which scenarios it would take
// (career_staged.ts stagedDecision on the scenario's real state), and whether the brain's path keeps a good reply good: a
// fake model that answers with the gold text, through agentTurn and the same render. Whether the system prompt carries the
// texting rules for the channel is reported too.
//
//   deno run -A --no-check evals/career/one-v-one/run.ts --label <label> [--only V001,V009]
//   deno run -A --no-check evals/career/one-v-one/run.ts --report <before-label> <after-label>   writes docs/architect/ONE-V-ONE-2026-11-01.md
import { ctxOf, SCENARIOS, type Scenario, type State } from "./scenarios.ts";
import { CHECKS, CHECK_WHAT, type Channel, type Check, grade, type Graded } from "./score.ts";
import { EXTRA_POSTINGS } from "./postings.ts";
import { FIX, STYLE_CHECKS, styleOf, type StyleRow, TARGETS } from "./style.ts";
import { judgePrompt, judgeReply, type JudgeResult, type ModelCall } from "./judge.ts";

const here = new URL(".", import.meta.url);
const WORLD = JSON.parse(Deno.readTextFileSync(new URL("../worlds/in-flight.json", here)));
const POSTINGS = [...WORLD.postings, ...EXTRA_POSTINGS];

export function seed(state: State) {
  const base = { now: WORLD.now, postings: POSTINGS };
  if (state === "new") return base;
  if (state === "profile") return { ...base, facts: WORLD.facts, standing: WORLD.standing, tracked: WORLD.tracked };
  return { ...WORLD, postings: POSTINGS };
}

export async function renderers(native: boolean) {
  const { adaptersFromEnv } = await import("../../../supabase/functions/_shared/channel_registry.ts");
  const refuse = (async () => { throw new TypeError("no network in the 1v1 run"); }) as unknown as typeof fetch;
  // Both arms set the flag explicitly: once the voice ships on by default (#390, D-036), an unset flag would mean on.
  const env: Record<string, string> = { LOOPMESSAGE_API_KEY: "k", TELEGRAM_BOT_TOKEN: "t", WHATSAPP_TOKEN: "w", WHATSAPP_PHONE_NUMBER_ID: "1", CAREER_TEXTING_NATIVE: native ? "on" : "off" };
  const a = adaptersFromEnv({ get: (k: string) => env[k] }, { fetch: refuse, clock: () => 0, sleep: async () => {} });
  return (ch: Channel, reply: string): string[] => ch === "web" ? [reply] : a[ch === "sms" ? "imessage" : ch]!.render(reply);
}

export interface Row {
  id: string; feature: string; channel: Channel; state: State; msg: string; gold: string[];
  handler: string; reply: string; off: { bubbles: string[]; g: Graded }; on: { bubbles: string[]; g: Graded };
  style: { gold: StyleRow; off: StyleRow; on: StyleRow };
  staged: { brain: boolean; reason: string; intent: string | null }; brainEcho: { bubbles: string[]; g: Graded } | null; promptRules: boolean | null;
  judge?: JudgeResult; final?: boolean; // final: the regex rubric (voice on) AND the judge
}

// o.brainModel: the REAL staged brain (CAREER_BRAIN=staged): the turns the staged decision gives the brain are answered by
// this model through agentTurn; the rest by code and the router, as live. Without it the brain's side is only the fake-model
// echo below, which measures the delivery path, NOT the brain. o.judgeCall: the OpenAI judge (judge.ts). o.stop: the budget.
export async function runAll(list: Scenario[], o: { brainModel?: ModelCall | null; judgeCall?: ModelCall | null; stop?: () => string | null } = {}): Promise<Row[] & { stopped?: string }> {
  const { openWorld, worldTurn, USER } = await import("../world.ts");
  const { stagedDecision } = await import("../../../supabase/functions/agent-chat/career_staged.ts");
  const off = await renderers(false), on = await renderers(true);
  const rows: Row[] = [];
  for (const s of list) {
    const w = await openWorld(seed(s.state));
    let now = w.now;
    for (const p of s.prior ?? []) { await worldTurn(w, { brain: "router", threadId: "A", message: p, now, production: true }); now += 90000; }
    // The staged decision on the real state, before the graded turn (the probe works on a copy).
    const t = w.th("A");
    const ctx: any = w.H.createTurnCtx({ userId: USER, threadId: "A", now, accountPersistence: true, snapshot: t.snapshot, account: w.account, postings: w.kb });
    const d = stagedDecision({ env: { get: (k: string) => ({ CAREER_BRAIN: "staged" } as Record<string, string>)[k] }, message: s.msg, ctx, host: w.H, structured: false });
    const stop = o.stop?.();
    if (stop) { (rows as any).stopped = stop; break; }
    const real = !!(o.brainModel && d.brain);
    const r = await worldTurn(w, { brain: real ? "agent" : "router", threadId: "A", message: s.msg, now, production: true, ...(real ? { model: o.brainModel, channel: s.channel } : {}) } as any);
    // A code turn answers first in production (CODE_TURN_ORDER); the brain is reached only when none did.
    const taken = d.brain && !r.handler.startsWith("code:");
    // The brain's path with a model that answers with the gold text: does the reply survive the path and the render?
    // FAKE MODEL: this does NOT measure the brain. A model that answers with the gold text shows only whether a good reply
    // survives the brain's delivery path and the render. The brain's real score is --brain staged-real (OpenAI, paid).
    let brainEcho: Row["brainEcho"] = null, promptRules: boolean | null = null;
    if (taken) {
      const w2 = await openWorld(seed(s.state));
      let n2 = w2.now;
      for (const p of s.prior ?? []) { await worldTurn(w2, { brain: "router", threadId: "A", message: p, now: n2, production: true }); n2 += 90000; }
      let system = "";
      const model = async (p: any) => { system ||= p.system; return { content: [{ type: "text", text: s.gold.join("\n\n") }], stop_reason: "end_turn" }; };
      const r2 = await worldTurn(w2, { brain: "agent", threadId: "A", message: s.msg, now: n2, model, channel: s.channel, production: true } as any);
      const b = on(s.channel, r2.reply);
      brainEcho = { bubbles: b, g: grade(b, s.channel, s.r, ctxOf(s)) };
      promptRules = /alone on its own line/i.test(system) && /no markdown|never markdown|plain text/i.test(system);
    }
    const bOff = off(s.channel, r.reply), bOn = on(s.channel, r.reply);
    rows.push({ id: s.id, feature: s.feature, channel: s.channel, state: s.state, msg: s.msg, gold: s.gold, handler: r.handler, reply: r.reply,
      off: { bubbles: bOff, g: grade(bOff, s.channel, s.r, ctxOf(s)) }, on: { bubbles: bOn, g: grade(bOn, s.channel, s.r, ctxOf(s)) },
      style: { gold: styleOf(s.gold, s.channel), off: styleOf(bOff, s.channel), on: styleOf(bOn, s.channel) },
      staged: { brain: taken, reason: taken || !d.brain ? d.reason : "code_turn", intent: d.intent }, brainEcho, promptRules });
    if (o.judgeCall) {
      const row = rows[rows.length - 1];
      row.judge = await judgeReply(o.judgeCall, judgePrompt(s, bOn, POSTINGS));
      row.final = row.on.g.pass && row.judge.pass;
    }
  }
  return rows as Row[] & { stopped?: string };
}

export function goldGrades(list: Scenario[]) { return list.map((s) => ({ id: s.id, g: grade(s.gold, s.channel, s.r, ctxOf(s)) })); }

export function tally(rows: Row[], key: "off" | "on") {
  const by: Record<string, number> = Object.fromEntries(CHECKS.map((c) => [c, 0]));
  const checksPassed = rows.reduce((n, r) => n + (CHECKS.length - r[key].g.failed.length), 0);
  for (const r of rows) for (const c of r[key].g.failed) by[c]++;
  return { pass: rows.filter((r) => r[key].g.pass).length, total: rows.length, checksPassed, checks: rows.length * CHECKS.length, by };
}

export function styleTally(rows: Row[], key: "gold" | "off" | "on") {
  const st = rows.map((r) => r.style[key]);
  const med = (a: number[]) => { const x = [...a].sort((p, q) => p - q), m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };
  const by: Record<string, number> = Object.fromEntries(STYLE_CHECKS.map((c) => [c, 0]));
  for (const x of st) for (const c of x.failed) by[c]++;
  return { meets: st.filter((x) => !x.failed.length).length, total: st.length, by,
    median: { sentencesPerBubble: med(st.map((x) => x.sentencesPerBubble)), wordsPerSentence: med(st.map((x) => x.wordsPerSentenceMedian)), wordsPerSentenceMax: med(st.map((x) => x.wordsPerSentenceMax)), wordsPerBubble: med(st.map((x) => x.wordsPerBubble)), grade: med(st.map((x) => x.grade)), bubbles: med(st.map((x) => x.bubbles)) } };
}

// ---------------------------------------------------------------------------------------------------------- report
const pct = (a: number, b: number) => b ? `${(100 * a / b).toFixed(1)}%` : "n/a";
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ⏎ ");
function sideBySide(r: Row, key: "off" | "on"): string {
  const g = r[key].g;
  const marks = CHECKS.map((c) => g.failed.includes(c) ? `✗${c}` : null).filter(Boolean).join(" ") || "all pass";
  return `| ${r.id} | ${r.feature} | ${r.channel} | ${r.state} | ${cell(r.msg)} | ${cell(r.gold.join(" ‖ "))} | ${cell(r[key].bubbles.join(" ‖ ").slice(0, 400))} | ${r.handler} | ${marks} |`;
}

export async function report(before: Row[], after: Row[], meta: { before: string; after: string; paid?: any[] }): Promise<string> {
  const tb = tally(before, "off"), tbn = tally(before, "on"), ta = tally(after, "off"), tan = tally(after, "on");
  const gold = goldGrades(SCENARIOS);
  const ranked = (t: ReturnType<typeof tally>) => CHECKS.map((c) => [c, t.by[c]] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const staged = after.filter((r) => r.staged.brain);
  const echoPass = staged.filter((r) => r.brainEcho?.g.pass).length;
  const textingStaged = (rows: Row[]) => rows.filter((r) => r.staged.brain && r.channel !== "web");
  const rulesB = textingStaged(before).filter((r) => r.promptRules).length, rulesA = textingStaged(after).filter((r) => r.promptRules).length;
  const echoFails = staged.filter((r) => r.brainEcho && !r.brainEcho.g.pass).map((r) => r.id);
  const L: string[] = [];
  L.push("# 1v1: Trainee vs the architect's gold replies (2026-11-01, hardened 2026-11-02)", "");
  L.push("Owner request, 2026-11-01: compare the architect and Trainee one on one, and get Trainee to reply the same way, with links given the way Instinct gives them.", "");
  L.push("120 first-week scenarios (`evals/career/one-v-one/scenarios.ts`) across every feature, each with a channel (iMessage, SMS, WhatsApp, Telegram, web) and an account state (new, profile on file, tasks in flight). The gold reply for each was written by hand by the architect (Claude, in session; no model call, no Anthropic API spend). Every scenario carries a rubric a script checks (`score.ts`): bubble count and length, markdown, links present / alone on their own line after the line that says what they are / only real links, question count, numbered options, required facts, forbidden claims, and voice (filler, banned phrases, emoji, internal jargon). The link and formatting rules follow the owner's requirement docs Q73-Q95, Q581-Q587 and Q632-Q633 (cited by number only).", "");
  L.push("Trainee's side: trunk's live path in-process (`run.ts`): the scenario's state seeded, prior turns run, then the turn through the handler's code turns in the handler's own order (`evals/career/world.ts` CODE_TURN_ORDER, checked against handler-career.ts by test; the turns that need a live service are listed with the reason) and the router, rendered by each channel's own adapter (`channel_registry.ts`). `CAREER_TEXTING_NATIVE` off is what ships by default; on is the texting voice the owner can switch on. Free, deterministic: `deno run -A --no-check evals/career/one-v-one/run.ts --label <label>`.", "");
  L.push("## Pass rates (regex rubric only: a floor check, not the score; the score is regex AND judge, below)", "");
  L.push(`Gold passes its own rubric: ${gold.filter((g) => g.g.pass).length}/${gold.length}.`, "");
  L.push("| | scenarios passing every check | checks passing |", "|---|---|---|");
  L.push(`| before (trunk 321708d2e), texting voice off (default) | ${tb.pass}/${tb.total} (${pct(tb.pass, tb.total)}) | ${tb.checksPassed}/${tb.checks} (${pct(tb.checksPassed, tb.checks)}) |`);
  L.push(`| before (trunk 321708d2e), texting voice on | ${tbn.pass}/${tbn.total} (${pct(tbn.pass, tbn.total)}) | ${tbn.checksPassed}/${tbn.checks} (${pct(tbn.checksPassed, tbn.checks)}) |`);
  L.push(`| after (this branch), texting voice off (default) | ${ta.pass}/${ta.total} (${pct(ta.pass, ta.total)}) | ${ta.checksPassed}/${ta.checks} (${pct(ta.checksPassed, ta.checks)}) |`);
  L.push(`| after (this branch), texting voice on | ${tan.pass}/${tan.total} (${pct(tan.pass, tan.total)}) | ${tan.checksPassed}/${tan.checks} (${pct(tan.checksPassed, tan.checks)}) |`, "");
  {
    const { probeCounts } = await import("./probes.ts");
    const pc = probeCounts();
    L.push(`Probes (replies built to game the rubric, regex rubric only; each should pass about 0 of 120): "Ok." ${pc.ok}, empty ${pc.empty}, an echo of the message ${pc.echo}, one fixed generic reply ${pc.fixed} (the asks whose right answer is "what role and city?"), keyword stuffing ${pc.stuffing}, the gold plus an invented pay figure and contact ${pc.invented}, the gold plus an invented link ${pc.link}.`, "");
  }
  L.push("## Judge and real brain (the numbers that count)", "");
  L.push("A scenario counts as passed only when the regex rubric AND an OpenAI judge pass it (`judge.ts`: gpt-4.1-mini, temperature 0, fixed seed, strict JSON schema, judged twice; a parse failure, an error or a disagreement is a FAIL). The real-brain mode (`--brain staged-real`) answers the turns the staged brain takes with the real model (gpt-5-mini) through agentTurn, the rest by code and the router, as live. Estimated spend per run: judge about $0.20, real brain about $0.25; the recorded spend is the meter's, written to `evals/career/results/1v1-<label>.json`, where the brain-eval budget counts it.", "");
  if (meta.paid?.length) for (const p of meta.paid) L.push(`- ${p.label}: ${p.brain}, regex ${p.regex_pass_voice_on}/${p.scenarios}, judge ${p.judge_pass}/${p.scenarios}, both ${p.final_pass}/${p.scenarios}, spend $${(p.cost_usd.brain + p.cost_usd.judge).toFixed(3)}${p.stopped ? ` (STOPPED: ${p.stopped}, not a score)` : ""}`);
  else L.push("NOT RUN in this PR: the architect does not start paid runs from a session. They run in the brain-eval workflow (`.github/workflows/brain-eval.yml`, step \"1v1\"), under its EVAL_BUDGET_USD cap, when the owner dispatches it. Until then the regex numbers above are a floor check, not a score.");
  L.push("");
  L.push(`Staged brain (\`CAREER_BRAIN=staged\`), FAKE MODEL, no spend. This does NOT measure the brain: a model that answers with the gold text shows only whether a good reply survives the brain's delivery path and the render.`, "");
  L.push(`Staged brain (\`CAREER_BRAIN=staged\`, fake model, no spend): it would take ${staged.length}/120 of these turns (the rest stay with code and the router). With a model that answers with the gold text, the delivered reply still passes its rubric in ${echoPass}/${staged.length}. The ${echoFails.length} that do not (${echoFails.join(", ")}) lose a pay figure or a posting the fake model stated without calling a tool: the fact guard dropping an unsourced number, as it should (a real turn calls search_jobs first). On the ${textingStaged(after).length} of those turns that go out on a texting channel, the system prompt carries the texting rules (plain text, each link alone on its own line, short bubbles, one question) in ${rulesB}/${textingStaged(before).length} before and ${rulesA}/${textingStaged(after).length} after.`, "");
  if (before[0]?.style && after[0]?.style) {
    const sg = styleTally(after, "gold"), sb = styleTally(before, "off"), sbn = styleTally(before, "on"), sa = styleTally(after, "off"), san = styleTally(after, "on");
    L.push("## Style: how simply it reads (targets in `style-targets.json`, derived from the owner's brief, observed; numbers only)", "");
    L.push(`Targets per reply: at most ${TARGETS.max_sentences_per_bubble} sentences a bubble, ${TARGETS.max_words_per_sentence} words a sentence, ${TARGETS.max_words_per_bubble} words a bubble, reading grade (Flesch-Kincaid) at most ${TARGETS.max_reading_grade_fk}, ${TARGETS.max_text_bubbles_per_reply} text bubbles, each link alone, no markdown, no internal words, ${TARGETS.max_questions_per_reply} question. Observed median: ${TARGETS.median_words_per_sentence} words a sentence. Acknowledgements are sent separately while a turn runs (ackFor) and are not scored by a single-turn replay.`, "");
    L.push("| | replies meeting every target | median sentences/bubble (max of reply) | median words/sentence | median longest sentence | median words/bubble (max of reply) | median grade | median text bubbles |", "|---|---|---|---|---|---|---|---|");
    for (const [n, t] of [["gold", sg], [`before, voice off`, sb], [`before, voice on`, sbn], [`after, voice off`, sa], [`after, voice on`, san]] as const)
      L.push(`| ${n} | ${t.meets}/${t.total} | ${t.median.sentencesPerBubble} | ${t.median.wordsPerSentence} | ${t.median.wordsPerSentenceMax} | ${t.median.wordsPerBubble} | ${t.median.grade} | ${t.median.bubbles} |`);
    L.push("", "| style check | before, voice off | before, voice on | after, voice off | after, voice on | gold |", "|---|---|---|---|---|---|");
    for (const c of STYLE_CHECKS) L.push(`| ${c} | ${sb.by[c]} | ${sbn.by[c]} | ${sa.by[c]} | ${san.by[c]} | ${sg.by[c]} |`);
    const worst = [...after].sort((a, b) => b.style.on.failed.length - a.style.on.failed.length || b.style.on.wordsPerBubble - a.style.on.wordsPerBubble).slice(0, 15);
    L.push("", "### The 15 replies furthest from the targets (after, voice on), and what to change", "", "| id | handler | words/bubble | longest sentence | grade | bubbles | misses | change |", "|---|---|---|---|---|---|---|---|");
    for (const r of worst) L.push(`| ${r.id} | ${r.handler} | ${r.style.on.wordsPerBubble} | ${r.style.on.wordsPerSentenceMax} | ${r.style.on.grade} | ${r.style.on.bubbles} | ${r.style.on.failed.join(", ")} | ${r.style.on.failed.map((c) => FIX[c]).join("; ")} |`);
    L.push("");
  }
  L.push("## Failure categories, ranked (scenarios failing each check)", "");
  L.push("| check | what it means | before, voice off | before, voice on | after, voice off | after, voice on |", "|---|---|---|---|---|---|");
  for (const [c] of ranked(tb).concat(ranked(tbn).filter(([c]) => !tb.by[c]))) L.push(`| ${c} | ${CHECK_WHAT[c as Check]} | ${tb.by[c]} | ${tbn.by[c]} | ${ta.by[c]} | ${tan.by[c]} |`);
  L.push("");
  L.push("## What this branch changed (each with a fail-first test in `tests/architect/one-v-one-texting.test.ts`)", "");
  L.push("1. Links: a link inside a sentence now goes on its own line right after the sentence that names it (`channel_voice.ts` linksOnOwnLine reads a line sentence by sentence, never splitting open bold, italics or code). Before, the three postings' sentences came first and their three links after, so no link sat under its posting.");
  L.push("2. Numbered roles: the router's search list numbers its roles 1), 2), 3) (`142-career-router.js` roleSentence; \")\" because the composer reads \"1.\" as a sentence end), so the person can answer with a digit.");
  L.push("3. Bubble length: on iMessage and SMS a reply is split between paragraphs, lines and sentences into bubbles of at most 320 characters (a single sentence longer than that stays whole, in the 700-character bubbles as before) (`channel_voice.ts` imessageNativeRender).");
  L.push("4. Dates: texting channels show \"Oct 19, 2026\", never 2026-10-19; links and code untouched (`channel_voice.ts` humanDates).");
  L.push("5. Staged brain: on a texting channel the system prompt carries the texting rules (`prompt.ts` textingRulesFor), and the channel reaches it (`career_brain.ts` channel, one line in `handler-career.ts`, `world.ts`). Web and no-channel prompts are byte-identical to before.");
  L.push("6. Style (owner brief, observed; `style-targets.json`): iMessage/SMS bubbles also carry at most 3 sentences (`channel_voice.ts` sentenceTexts), and the brain's texting rules give the numbers (3 sentences a bubble, 15-20 words a sentence, never over 25, 8th-9th grade words). WhatsApp and Telegram keep their message contract (#301: one answer in at most two messages; tables and headings whole), so there the sentence budget is the brain's rule, not a cut.");
  L.push("");
  L.push("Fixes 1, 3, 4 and 6 are in the texting voice, which ships only with `CAREER_TEXTING_NATIVE=on` (an owner secret; off keeps the delivery tests' \"unchanged\" contract). Fix 5 matters only with `CAREER_BRAIN=staged`. Fix 2 is live on every path. (A crisis-phrase change was taken out on review: #354 owns the shared detector; V120 is left to it.) No reply prose was added to make a check pass; the words stay the router's or the model's.", "");
  const groups: [string, RegExp, string][] = [
    ["router dead ends (career_catchall, unclaimed)", /router:(career_catchall|null)$/, "#350 (router dead ends) owns these; not touched here"],
    ["application status and follow-through (tracking_status, reminders)", /router:(tracking_status|tracking_log|conversation_recall)$/, "#355 (status and reminders by code) owns these"],
    ["outreach list-building replies (outreach_clarification, company_intel people)", /router:(outreach_clarification|company_intel)$/, "#361 (personalized outreach) owns the outreach turns"],
    ["advice the router answers from templates (negotiation, prep, resume guidance, os plan)", /router:(negotiation_\w+|prep_\w+|career_resume_guidance|career_os_plan|career_recommendations)$/, "long template prose with internal words (\"source class\", \"company file\"); existing tests pin that wording, so the cure is the staged brain on these turns (it takes them) with the texting rules above"],
    ["tailoring (career_tailor)", /router:career_tailor$/, "the tailor picks the wrong posting (V039: asked for Stripe, tailored Figma): next work order"],
  ];
  L.push("## Not fixed here, and why (after, voice on: failing scenarios by owner)", "", "| group | failing | why not here |", "|---|---|---|");
  for (const [g, re, why] of groups) L.push(`| ${g} | ${after.filter((r) => !r.on.g.pass && re.test(r.handler)).length} | ${why} |`);
  L.push("", "## Overlap with open PRs", "");
  L.push("- #350 (router dead ends) edits `142-career-router.js` and both bundles; this branch edits 142 only in roleSentence (lines 437-447), outside #350's hunks, plus 125 and 139, which #350 does not touch. The bundles are generated: whichever merges second reruns `python3 scripts/build-router-core.py` and `--career-only`.");
  L.push("- #354, #355, #353, #360, #362, #365 edit `handler-career.ts`; this branch adds one line at the agentTurn call (after `shape:`), outside every one of their hunks.");
  L.push("- #361 (outreach) and the results-page builder (#356): no shared files. #364 changes two bundle lines (rebuild as above).", "");
  const byFeature = new Map<string, { n: number; b: number; a: number }>();
  for (const [i, r] of after.entries()) { const f = byFeature.get(r.feature) ?? { n: 0, b: 0, a: 0 }; f.n++; if (before[i].off.g.pass) f.b++; if (r.on.g.pass) f.a++; byFeature.set(r.feature, f); }
  L.push("## By feature (before voice off → after voice on)", "", "| feature | scenarios | before | after |", "|---|---|---|---|");
  for (const [f, v] of byFeature) L.push(`| ${f} | ${v.n} | ${v.b} | ${v.a} |`);
  L.push("");
  const handlers = new Map<string, number>();
  for (const r of after) if (!r.on.g.pass) handlers.set(r.handler, (handlers.get(r.handler) ?? 0) + 1);
  L.push("## Where the remaining failures come from (after, voice on: failing scenarios by the handler that answered)", "", "| handler | failing |", "|---|---|");
  for (const [h, n] of [...handlers].sort((a, b) => b[1] - a[1])) L.push(`| ${h} | ${n} |`);
  L.push("");
  L.push("## Side by side, before (trunk, voice off as shipped)", "", "Bubbles are separated by ‖ and lines by ⏎. Trainee's reply is cut at 400 characters here; the full text is in the results JSON.", "");
  L.push("| id | feature | channel | state | person | gold | Trainee | handler | checks |", "|---|---|---|---|---|---|---|---|---|");
  for (const r of before) L.push(sideBySide(r, "off"));
  L.push("", "## Side by side, after (this branch, voice on)", "");
  L.push("| id | feature | channel | state | person | gold | Trainee | handler | checks |", "|---|---|---|---|---|---|---|---|---|");
  for (const r of after) L.push(sideBySide(r, "on"));
  L.push("");
  return L.join("\n");
}

if (import.meta.main) {
  const args = Deno.args, opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] ?? null : null; };
  const out = new URL("./results/", here);
  if (args[0] === "--report") {
    const [b, a] = [args[1], args[2]];
    const before = JSON.parse(Deno.readTextFileSync(new URL(`${b}.json`, out))), after = JSON.parse(Deno.readTextFileSync(new URL(`${a}.json`, out)));
    const paid: any[] = [];
    try { for await (const e of Deno.readDir(new URL("../results/", here))) if (e.name.startsWith("1v1-") && e.name.endsWith(".json")) paid.push(JSON.parse(Deno.readTextFileSync(new URL(`../results/${e.name}`, here)))); } catch { /* none */ }
    Deno.writeTextFileSync(new URL("../../../docs/architect/ONE-V-ONE-2026-11-01.md", here), await report(before, after, { before: b, after: a, paid }));
    console.log("wrote docs/architect/ONE-V-ONE-2026-11-01.md");
  } else {
    const label = opt("--label") ?? "run";
    const only = opt("--only")?.split(",");
    // Paid modes (never run by the architect in a session; the brain-eval workflow runs them under its budget):
    //   --judge               the OpenAI judge on every reply (about $0.20 a run)
    //   --brain staged-real   the real staged brain (gpt-5-mini) on the turns it takes (about $0.25 a run), judged too
    const judging = args.includes("--judge"), realBrain = opt("--brain") === "staged-real";
    let brainModel: ModelCall | null = null, judgeCall: ModelCall | null = null, stop: (() => string | null) | undefined, meters: any = null;
    if (judging || realBrain) {
      if (!Deno.env.get("OPENAI_API_KEY")) { console.log("NOT RUN: no OPENAI_API_KEY (the judge and the real brain need it). A score is never estimated."); Deno.exit(2); }
      const { callModel, modelConfig, newMeter, PRICES } = await import("../../../supabase/functions/_shared/model_gateway.ts");
      const { spentUsd, budgetStop } = await import("../run.ts");
      const { JUDGE_MODEL } = await import("./judge.ts");
      const jm = newMeter(), bm = newMeter();
      meters = { jm, bm };
      const jcfg = { ...modelConfig(Deno.env, "chat"), model: Deno.env.get("EVAL_1V1_JUDGE_MODEL") || JUDGE_MODEL };
      const bcfg = { ...modelConfig(Deno.env, "chat"), model: Deno.env.get("CAREER_MODEL") || "gpt-5-mini" };
      const budget = Deno.env.get("EVAL_BUDGET_USD") ? Number(Deno.env.get("EVAL_BUDGET_USD")) : null;
      if (budget === null || !(budget > 0) || !PRICES[jcfg.model] || (realBrain && !PRICES[bcfg.model])) { console.log("NOT RUN: a paid 1v1 run needs EVAL_BUDGET_USD and priced models; an uncapped run is never started."); Deno.exit(2); }
      const prior: any[] = [];
      try { for await (const e of Deno.readDir(new URL("../results/", here))) if (e.name.endsWith(".json")) prior.push(JSON.parse(Deno.readTextFileSync(new URL(`../results/${e.name}`, here)))); } catch { /* none */ }
      const spentBefore = spentUsd(prior, `1v1-${label}`);
      stop = budgetStop(budget, () => spentBefore + (jm.usd_micros + bm.usd_micros) / 1e6, 0.05);
      console.log(`budget $${budget.toFixed(2)} · already spent $${spentBefore.toFixed(3)}`);
      judgeCall = judging ? (p) => callModel(jcfg, p, { meter: jm, role: "chat" }) : null;
      brainModel = realBrain ? (p) => callModel(bcfg, p, { meter: bm, role: "chat" }) : null;
    }
    const rows = await runAll(only ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS, { brainModel, judgeCall, stop });
    Deno.mkdirSync(out, { recursive: true });
    Deno.writeTextFileSync(new URL(`${label}.json`, out), JSON.stringify(rows, null, 1) + "\n");
    const off = tally(rows, "off"), on = tally(rows, "on");
    const gold = goldGrades(SCENARIOS).filter((g) => !g.g.pass);
    console.log(`gold failing its own rubric: ${gold.length}${gold.length ? " " + gold.map((g) => `${g.id}:${g.g.failed.join("+")}`).join(" ") : ""}`);
    console.log(`voice off: ${off.pass}/${off.total} scenarios, ${off.checksPassed}/${off.checks} checks; by check ${JSON.stringify(off.by)}`);
    console.log(`voice on:  ${on.pass}/${on.total} scenarios, ${on.checksPassed}/${on.checks} checks; by check ${JSON.stringify(on.by)}`);
    for (const k of ["gold", "off", "on"] as const) { const t = styleTally(rows, k); console.log(`style ${k}: ${t.meets}/${t.total} meet; medians ${JSON.stringify(t.median)}; by ${JSON.stringify(t.by)}`); }
    const st = rows.filter((r) => r.staged.brain);
    console.log(`staged brain takes ${st.length}; echo passes ${st.filter((r) => r.brainEcho?.g.pass).length}; prompt rules ${st.filter((r) => r.promptRules).length}`);
    const { probeCounts } = await import("./probes.ts");
    console.log(`probes (regex rubric; each should pass about 0 of 120): ${JSON.stringify(probeCounts())}`);
    if (meters) {
      const judged = rows.filter((r) => r.judge);
      const cost = { brain: meters.bm.usd_micros / 1e6, judge: meters.jm.usd_micros / 1e6 };
      const summary = { label: `1v1-${label}`, set: "one-v-one", brain: realBrain ? "staged-real" : "router", judge: judging, run_at: new Date().toISOString(), cost_usd: cost,
        scenarios: rows.length, stopped: (rows as any).stopped ?? null, regex_pass_voice_on: rows.filter((r) => r.on.g.pass).length,
        judge_pass: judged.filter((r) => r.judge!.pass).length, final_pass: judged.filter((r) => r.final).length,
        items: rows.map((r) => ({ id: r.id, handler: r.handler, regex: r.on.g.pass, judge: r.judge?.pass ?? null, why: r.judge?.why ?? "" })) };
      // The ledger the brain-eval budget reads (evals/career/results/*.json cost_usd): this run's spend is counted there.
      Deno.mkdirSync(new URL("../results/", here), { recursive: true });
      Deno.writeTextFileSync(new URL(`../results/1v1-${label}.json`, here), JSON.stringify(summary, null, 1) + "\n");
      console.log(`1v1 ${summary.brain}: regex ${summary.regex_pass_voice_on}/${rows.length}, judge ${summary.judge_pass}/${judged.length}, both ${summary.final_pass}/${judged.length} · spend brain $${cost.brain.toFixed(3)} judge $${cost.judge.toFixed(3)}${summary.stopped ? ` · STOPPED (${summary.stopped}): not a score` : ""}`);
      if (summary.stopped) Deno.exit(3);
    }
  }
}
