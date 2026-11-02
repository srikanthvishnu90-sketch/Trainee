// Head to head (WO-023 part A): the same conversations (evals/career/conversations.json) put to Trainee and to other
// agents, graded by one blind judge on the same terms. What is measured, per the owner (2026-10-19): how Trainee
// responds, its grammar, how structured it is, and whether it can listen, comprehend, and create or adjust tasks.
//
// Contestants:
//   trainee-agent         Trainee's model brain, in-process (needs OPENAI_API_KEY)
//   trainee-router        Trainee's scripted router, in-process (no model)
//   openai-plain          a bare model with the same opening the outside agents get, no tools (a floor: what any
//                         chat model does with no product around it)
//   transcript:<file>     replies recorded from another agent (Instinct, Claude, Dots, ChatGPT...) by a tester who sent
//                         the person's words verbatim, in a fresh chat opened with SCRIPT.md's opening message
//
// Fair terms: every contestant is graded on its replies alone, with the same checks, by a judge that never sees which
// agent wrote them. Trainee's end state (the alerts it actually set) is graded on its own line, since an outside agent
// has no state to inspect. A conversation a transcript does not cover is "not recorded", never a failure. A judge error
// is a failure. Nothing here runs without the judge's key: NOT RUN, exit 2. Scores are never estimated.
//
//   deno run -A evals/career/compare.ts --contestants trainee-agent,openai-plain,transcript:evals/career/compare/transcripts/claude.json --label <label>
//   deno run -A evals/career/compare.ts --kit [--check]     the testers' script and transcript template (no key)
//   deno run -A evals/career/compare.ts --lint <contestant> text hygiene only, no judge (trainee-router or a transcript)
import { type ConvBrain, type ConvItem, type ConvJudge, runConversations, traineeBrain, transcript } from "./run-conversations.ts";
import { parseJudge } from "./run.ts";

export const DIMENSIONS = ["grammar", "structure", "listening", "comprehension", "tasks", "memory"] as const;
export type Dimension = typeof DIMENSIONS[number];
export type Rubric = Record<Dimension, number | null> & { note: string };

export const RUBRIC_PROMPT = `You grade one assistant's side of a text conversation with a person looking for a job. You do not know which
assistant wrote it; judge only what is on the page. The only job postings that exist (anything else is invented):
{postings}
Transcript (U = the person, A = the assistant):
{transcript}
Score each from 1 to 5 (5 = what a sharp, careful human assistant would text; 3 = usable but with a real flaw; 1 = wrong or
unusable). Use null only where the conversation gives no chance to show it.
- grammar: correct, clean, natural writing; no broken sentences, wrong words or awkward machine phrasing.
- structure: easy to read on a phone; the right length for a text; lists numbered when there is something to point at;
  no headings, tables or walls of text.
- listening: uses everything the person said, including details given in passing and earlier in the thread; drops nothing.
- comprehension: understands what the person meant, including "the second one", corrections, shorthand and typos;
  answers the actual question.
- tasks: creates and adjusts what the person asks for (a search, an alert, a change, a stop, an undo) and restates it in
  exact terms; never claims to have done what it did not or could not do. null if no task was asked.
- memory: keeps facts and constraints the person stated earlier (and says so when it uses them); never asks again for
  what it was told. null if nothing earlier needed remembering.
Return JSON only: {"grammar": n, "structure": n, "listening": n, "comprehension": n, "tasks": n|null, "memory": n|null, "note": one sentence on the biggest weakness}`;

export function rubricPrompt(o: { postings: unknown[]; users: string[]; replies: string[] }): string {
  const list = (o.postings as any[]).map((p) => ({ company: p.company, title: p.title, location: p.location, description: p.description }));
  return RUBRIC_PROMPT.replace("{postings}", JSON.stringify(list)).replace("{transcript}", transcript(o.users, o.replies, o.users.length - 1));
}
export function parseRubric(text: string): Rubric {
  const m = /\{[\s\S]*\}/.exec(text || "");
  if (!m) throw new Error("rubric: no JSON");
  const j = JSON.parse(m[0]);
  const out: any = { note: typeof j.note === "string" ? j.note.slice(0, 300) : "" };
  for (const d of DIMENSIONS) {
    const v = j[d];
    if (v === null && (d === "tasks" || d === "memory")) { out[d] = null; continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1 || n > 5) throw new Error(`rubric: ${d} is not a score from 1 to 5`);
    out[d] = Math.round(n);
  }
  return out;
}

// Text hygiene, counted in code for every reply (no judge): what a text should not contain.
export const HYGIENE: { id: string; what: string; test: (r: string) => boolean }[] = [
  { id: "markdown", what: "headings, bold, tables or code fences (a phone shows them raw)", test: (r) => /^\s{0,3}#{1,6}\s|\*\*[^*]+\*\*|^\s*\|.*\|\s*$|```/m.test(r) },
  { id: "too_long", what: "over 1,600 characters", test: (r) => r.length > 1600 },
  { id: "ai_talk", what: "talks about being an AI or a language model", test: (r) => /\b(as an ai|i'?m (just )?an ai|language model|i am an ai)\b/i.test(r) },
  { id: "filler_opener", what: "opens with filler (great question, certainly, absolutely, sure thing)", test: (r) => /^\s*(great question|certainly|absolutely|sure thing|of course!)/i.test(r) },
  { id: "many_questions", what: "asks more than two questions at once", test: (r) => (r.match(/\?/g) || []).length > 2 },
  { id: "non_answer", what: "a non-answer (didn't catch that, rephrase, don't understand)", test: (r) => /^I'm Trainee, a career agent: I find roles/.test(r.trim()) || /\b(i didn'?t catch that|could you (please )?rephrase|i don'?t understand( what you mean)?|not sure what you mean)\b/i.test(r) },
  { id: "empty", what: "no reply", test: (r) => !r.trim() },
];
export function hygiene(replies: string[]): { replies: number; hits: Record<string, number> } {
  const hits: Record<string, number> = Object.fromEntries(HYGIENE.map((h) => [h.id, 0]));
  for (const r of replies) for (const h of HYGIENE) if (h.test(r)) hits[h.id]++;
  return { replies: replies.length, hits };
}

// The opening message every outside agent gets (and the plain model's system prompt): the same world Trainee sees.
export function opening(postings: any[]): string {
  const list = postings.map((p, i) => `${i + 1}. ${p.title}, ${p.company}, ${p.location}: ${p.description}`).join("\n");
  return [
    "For the rest of this chat, you are texting with someone who is looking for a job. Reply the way you would in a text message.",
    "The only job postings that exist right now are the ones below. Never mention any other posting.",
    "You cannot apply, send anything or set alerts from here: when asked, say exactly what you would set up, or what you need first, and never claim you did it.",
    "Reply to this message only with: ok",
    "",
    list,
  ].join("\n");
}

// A transcript recorded by a tester: { agent, recorded_by, recorded_at, how, replies: { C01: ["reply 1", ...] } }.
export interface Recorded { agent: string; recorded_by: string; recorded_at: string; how: string; replies: Record<string, string[]> }
export function checkRecorded(r: Recorded, items: ConvItem[]): { ok: string[]; problems: string[] } {
  const ok: string[] = [], problems: string[] = [];
  for (const k of ["agent", "recorded_by", "recorded_at", "how"] as const) if (typeof r[k] !== "string" || !r[k].trim()) problems.push(`missing "${k}"`);
  for (const [id, replies] of Object.entries(r.replies || {})) {
    const it = items.find((i) => i.id === id);
    if (!it) { problems.push(`${id}: no such conversation`); continue; }
    if (!Array.isArray(replies) || replies.length !== it.turns.length || replies.some((x) => typeof x !== "string")) {
      problems.push(`${id}: needs exactly ${it.turns.length} replies, one per message the person sent`);
      continue;
    }
    if (replies.every((x) => !x.trim())) { problems.push(`${id}: every reply is empty`); continue; }
    ok.push(id);
  }
  return { ok, problems };
}
export function recordedBrain(r: Recorded, items: ConvItem[]): ConvBrain {
  const byUsers = new Map(items.map((i) => [JSON.stringify(i.turns.map((t) => t.user)), i.id]));
  return async (users) => {
    const id = byUsers.get(JSON.stringify(users));
    const replies = id ? r.replies[id] : undefined;
    if (!replies) throw new Error("not recorded");
    return { replies, state: null };
  };
}

// The checks with the end state taken out: what every contestant is graded on.
export const repliesOnly = (it: ConvItem): ConvItem => ({ ...it, state: undefined });

export interface ContestantResult {
  name: string; agent: string; covered: string[];
  replies: { passed: number; total: number; failing: string[] };
  state: { passed: number; total: number; failing: string[] } | null;
  rubric: Record<Dimension, number | null>; rubric_n: number;
  hygiene: { replies: number; hits: Record<string, number> };
  items: { id: string; pass: boolean; state_pass: boolean | null; rubric: Rubric | null; note: string; replies: string[] }[];
}

export async function runContestant(o: {
  name: string; agent: string; brain: ConvBrain; stateful: boolean; items: ConvItem[]; postings: unknown[];
  judge: ConvJudge; rubricJudge: (prompt: string) => Promise<Rubric>;
}): Promise<ContestantResult> {
  // The end state each conversation left, kept by the person's words, for the end-state line.
  const states = new Map<string, unknown>();
  const brain: ConvBrain = async (users) => { const r = await o.brain(users); states.set(JSON.stringify(users), r.state); return r; };
  const r = await runConversations(o.items.map(repliesOnly), o.postings, brain, o.judge);
  const items: ContestantResult["items"] = [];
  let stateTotal = 0, statePassed = 0;
  const stateFailing: string[] = [];
  for (const res of r.items) {
    const it = o.items.find((i) => i.id === res.id)!;
    let rubric: Rubric | null = null, statePass: boolean | null = null;
    const users = it.turns.map((t) => t.user);
    if (res.replies.length === users.length) {
      try { rubric = await o.rubricJudge(rubricPrompt({ postings: o.postings, users, replies: res.replies })); }
      catch { rubric = null; }
    }
    if (o.stateful && it.state) {
      stateTotal++;
      const state = states.get(JSON.stringify(users)) ?? null;
      const v = await runConversations([{ id: it.id, theme: it.theme, persona: it.persona, turns: it.turns.map((t) => ({ user: t.user })), state: it.state }],
        o.postings, async () => ({ replies: res.replies, state }), o.judge);
      statePass = v.items[0].pass;
      if (statePass) statePassed++; else stateFailing.push(it.id);
    }
    items.push({ id: res.id, pass: res.pass, state_pass: statePass, rubric, note: res.note, replies: res.replies });
  }
  const scored = items.filter((i) => i.rubric);
  const rubricAvg = Object.fromEntries(DIMENSIONS.map((d) => {
    const v = scored.map((i) => i.rubric![d]).filter((x): x is number => typeof x === "number");
    return [d, v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null];
  })) as Record<Dimension, number | null>;
  return {
    name: o.name, agent: o.agent, covered: o.items.map((i) => i.id),
    replies: { passed: r.passed, total: r.total, failing: r.items.filter((x) => !x.pass).map((x) => x.id) },
    state: o.stateful ? { passed: statePassed, total: stateTotal, failing: stateFailing } : null,
    rubric: rubricAvg, rubric_n: scored.length,
    hygiene: hygiene(items.flatMap((i) => i.replies)),
    items,
  };
}

export function scorecard(o: { label: string; commit: string; judge: string; results: ContestantResult[]; total: number }): string {
  const pct = (a: number, b: number) => (b ? `${a}/${b} (${Math.round((a / b) * 100)}%)` : "n/a");
  const lines = [
    `# Head to head: ${o.label}`,
    "",
    `Commit ${o.commit} · judge ${o.judge} (blind: it never sees which agent wrote the replies) · ${o.total} conversations in the set.`,
    "",
    "| Contestant | Conversations covered | Pass (replies) | Trainee end state | " + DIMENSIONS.join(" | ") + " | Hygiene hits / replies |",
    "|---|---|---|---|" + DIMENSIONS.map(() => "---").join("|") + "|---|",
  ];
  for (const r of o.results) {
    const hits = Object.values(r.hygiene.hits).reduce((a, b) => a + b, 0);
    lines.push(`| ${r.name} (${r.agent}) | ${r.covered.length}/${o.total} | ${pct(r.replies.passed, r.replies.total)} | ${r.state ? pct(r.state.passed, r.state.total) : "n/a"} | ` +
      DIMENSIONS.map((d) => (r.rubric[d] === null ? "n/a" : String(r.rubric[d]))).join(" | ") + ` | ${hits} / ${r.hygiene.replies} |`);
  }
  lines.push("", "Dimensions are the judge's 1-5 averages over the conversations it scored. Pass means every checked turn and the whole conversation held. A contestant is compared only on the conversations it covers.", "");
  for (const r of o.results) {
    lines.push(`## ${r.name}`, "", `Failing (replies): ${r.replies.failing.join(", ") || "none"}.` + (r.state ? ` Failing (end state): ${r.state.failing.join(", ") || "none"}.` : ""), "");
    const hits = Object.entries(r.hygiene.hits).filter(([, n]) => n);
    if (hits.length) lines.push("Hygiene: " + hits.map(([k, n]) => `${k} ${n}`).join(", ") + ".", "");
    for (const i of r.items.filter((x) => !x.pass || x.state_pass === false)) lines.push(`- ${i.id}: ${i.note || "end state did not hold"}`);
    lines.push("");
  }
  return lines.join("\n");
}

// The testers' kit: one script with the opening message and every conversation's messages, and a transcript template.
export function kit(set: { items: ConvItem[]; postings: any[] }): { script: string; template: string } {
  const script = [
    "# Head to head: the testers' script",
    "",
    "Generated by `deno run -A evals/career/compare.ts --kit`; do not edit by hand.",
    "",
    "For each agent you test (Instinct, Claude, Dots, ChatGPT...):",
    "1. For each conversation below, open a **fresh chat** with that agent (no memory of earlier chats, no custom instructions).",
    "2. Send the opening message exactly as written. Ignore its reply.",
    "3. Send the person's messages one at a time, exactly as written: same spelling, typos and lowercase. Wait for each reply.",
    "4. Copy each reply, word for word, into the transcript file under the conversation's id: one entry per message sent.",
    "   Never fix, shorten or explain a reply. If the agent gave no reply, put an empty string.",
    "5. Fill in `agent` (the product and model as the app names it), `recorded_by`, `recorded_at` (the date) and `how`",
    "   (app or website, and any setting you changed).",
    "6. Check the file: `deno run -A evals/career/compare.ts --check-transcript <file>`. Then commit it under",
    "   `evals/career/compare/transcripts/`.",
    "",
    "## Opening message (send first in every fresh chat)",
    "",
    "```",
    opening(set.postings),
    "```",
    "",
    ...set.items.flatMap((it) => [
      `## ${it.id}: ${it.theme}`,
      "",
      ...it.turns.map((t, i) => `${i + 1}. ${t.user}`),
      "",
    ]),
  ].join("\n");
  const template = JSON.stringify({
    agent: "", recorded_by: "", recorded_at: "", how: "",
    replies: Object.fromEntries(set.items.map((it) => [it.id, it.turns.map(() => "")])),
  }, null, 1) + "\n";
  return { script, template };
}

// ---------------------------------------------------------------------------------------------------- CLI
if (import.meta.main) {
  const args = Deno.args, opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] ?? null : null; };
  const set = JSON.parse(await Deno.readTextFile(new URL("./conversations.json", import.meta.url)));
  const items: ConvItem[] = set.items;
  const dir = new URL("./compare/", import.meta.url);
  if (args.includes("--kit")) {
    const k = kit(set);
    const files: [string, string][] = [["SCRIPT.md", k.script], ["transcripts/TEMPLATE.json", k.template]];
    if (args.includes("--check")) {
      const stale = [];
      for (const [f, text] of files) { let have = ""; try { have = await Deno.readTextFile(new URL(f, dir)); } catch { /* missing */ } if (have !== text) stale.push(f); }
      if (stale.length) { console.log(`STALE: ${stale.join(", ")} (run --kit)`); Deno.exit(1); }
      console.log("kit up to date"); Deno.exit(0);
    }
    await Deno.mkdir(new URL("transcripts/", dir), { recursive: true });
    for (const [f, text] of files) await Deno.writeTextFile(new URL(f, dir), text);
    console.log("wrote evals/career/compare/SCRIPT.md and transcripts/TEMPLATE.json");
    Deno.exit(0);
  }
  const ct = opt("--check-transcript");
  if (ct) {
    const c = checkRecorded(JSON.parse(await Deno.readTextFile(ct)), items);
    console.log(`${c.ok.length} of ${items.length} conversations recorded${c.problems.length ? "; problems:\n- " + c.problems.join("\n- ") : ""}`);
    Deno.exit(c.problems.length ? 1 : 0);
  }
  const lint = opt("--lint");
  if (lint) {
    let replies: string[] = [];
    if (lint === "trainee-router") {
      const brain = await traineeBrain({ kind: "router", postings: set.postings });
      for (const it of items) replies.push(...(await brain(it.turns.map((t) => t.user))).replies);
    } else if (lint.startsWith("transcript:")) {
      replies = Object.values((JSON.parse(await Deno.readTextFile(lint.slice(11))) as Recorded).replies).flat();
    } else { console.log("lint takes trainee-router or transcript:<file>"); Deno.exit(1); }
    const h = hygiene(replies);
    console.log(`${lint}: ${h.replies} replies; ` + HYGIENE.map((x) => `${x.id} ${h.hits[x.id]}`).join(", "));
    Deno.exit(0);
  }
  if (!Deno.env.get("OPENAI_API_KEY")) { console.log("NOT RUN: no OPENAI_API_KEY (the judge needs it; outside agents' replies are graded by it too)."); Deno.exit(2); }
  const { callModel, modelConfig, newMeter } = await import("../../supabase/functions/_shared/model_gateway.ts");
  const { careerModelConfig } = await import("../../supabase/functions/agent-chat/release_model.ts");
  const meter = newMeter(), judgeMeter = newMeter();
  const brainCfg = careerModelConfig(Deno.env);
  const judgeCfg = { ...modelConfig(Deno.env, "chat"), model: Deno.env.get("EVAL_JUDGE_MODEL") || "gpt-5-mini" };
  const text = (res: any) => (res.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const ask = (prompt: string, max = 400) => callModel(judgeCfg, { system: "You are a strict grader. Output JSON only.", messages: [{ role: "user", content: prompt }], max_tokens: max }, { meter: judgeMeter, role: "chat" });
  const judge: ConvJudge = async (prompt) => parseJudge(text(await ask(prompt)));
  const rubricJudge = async (prompt: string) => parseRubric(text(await ask(prompt, 500)));
  const label = opt("--label") || `compare-${new Date().toISOString().slice(0, 10)}`;
  const only = opt("--only");
  const pick = (list: ConvItem[]) => list.filter((i) => !only || only.split(",").includes(i.id));
  const results: ContestantResult[] = [];
  for (const c of (opt("--contestants") || "trainee-agent,trainee-router,openai-plain").split(",")) {
    if (c === "trainee-agent" || c === "trainee-router") {
      const brain = await traineeBrain({ kind: c === "trainee-agent" ? "agent" : "router", postings: set.postings, model: (p) => callModel(brainCfg, p, { meter, role: "chat" }) });
      results.push(await runContestant({ name: c, agent: c === "trainee-agent" ? `Trainee, ${brainCfg.model}` : "Trainee, scripted router", brain, stateful: true, items: pick(items), postings: set.postings, judge, rubricJudge }));
    } else if (c === "openai-plain") {
      const sys = opening(set.postings);
      const brain: ConvBrain = async (users) => {
        const msgs: any[] = [], replies: string[] = [];
        for (const u of users) {
          msgs.push({ role: "user", content: u });
          const r = text(await callModel(brainCfg, { system: sys, messages: msgs, max_tokens: 900 }, { meter, role: "chat" }));
          msgs.push({ role: "assistant", content: r });
          replies.push(r);
        }
        return { replies, state: null };
      };
      results.push(await runContestant({ name: c, agent: `${brainCfg.model}, no tools`, brain, stateful: false, items: pick(items), postings: set.postings, judge, rubricJudge }));
    } else if (c.startsWith("transcript:")) {
      const rec: Recorded = JSON.parse(await Deno.readTextFile(c.slice(11)));
      const chk = checkRecorded(rec, items);
      if (chk.problems.length) { console.log(`${c}: ${chk.problems.join("; ")}`); Deno.exit(1); }
      results.push(await runContestant({ name: c.slice(11).split("/").pop()!.replace(/\.json$/, ""), agent: rec.agent, brain: recordedBrain(rec, items), stateful: false, items: pick(items.filter((i) => chk.ok.includes(i.id))), postings: set.postings, judge, rubricJudge }));
    } else { console.log(`unknown contestant ${c}`); Deno.exit(1); }
  }
  let commit = "unknown";
  try { commit = new TextDecoder().decode((await new Deno.Command("git", { args: ["rev-parse", "--short", "HEAD"] }).output()).stdout).trim(); } catch { /* not a git checkout */ }
  const md = scorecard({ label, commit, judge: judgeCfg.model, results, total: pick(items).length });
  await Deno.mkdir(new URL("./results/", import.meta.url), { recursive: true });
  await Deno.writeTextFile(new URL(`./results/${label}.compare.json`, import.meta.url), JSON.stringify({ label, commit, judge_model: judgeCfg.model, run_at: new Date().toISOString(),
    cost_usd: { contestants: meter.usd_micros / 1e6, judge: judgeMeter.usd_micros / 1e6 }, results }, null, 1));
  await Deno.writeTextFile(new URL(`./results/${label}.compare.md`, import.meta.url), md);
  console.log(md.split("\n").slice(0, 6 + results.length).join("\n"));
}
