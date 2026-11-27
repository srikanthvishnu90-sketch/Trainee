// Brutal task-and-context eval. Deterministic: no model judge, no network, no key. Scores a brain on
// evals/career/task-context-brutal.json (30 scripted multi-turn scenarios over seeded SYNTHETIC people) against the 0-5 rubric in
// evals/career/task-context-brutal.md. Every check is a pure function of (the reply, the earlier replies, the person's world state).
//
//   deno run -A evals/career/task-context-brutal.ts --brain router [--label L] [--only T01,T02]    offline, no key (the scripted router)
//   deno run -A evals/career/task-context-brutal.ts --brain agent  [--label L]                      the model brain; needs OPENAI_API_KEY (the model is the spend, there is no judge)
//   deno run -A evals/career/task-context-brutal.ts --replay transcripts.json [--label L]           score recorded live replies: { "T01": { "replies": [..], "state": [..optional, one per turn..] } }
//   deno run -A evals/career/task-context-brutal.ts --http https://bot.example/chat [--header Authorization=Bearer-x]
//        POST { scenario, turn, thread_id, message } -> { reply, state? }; one fresh person per scenario is the endpoint's business.
//
// A check whose evidence the run cannot supply (a state check on a replay without state) is "unmeasured": it is listed, it is not
// scored as a pass, and it is excluded from the dimension mean, so a thin transcript cannot flatter the bot.
// Results: evals/career/results/task-context-brutal.<label>.json. Exit code 1 when any dimension is below 5.
export type Dim = "context" | "completion" | "params" | "question" | "factlock" | "natural" | "memory" | "effects";
export const DIMS: Dim[] = ["context", "completion", "params", "question", "factlock", "natural", "memory", "effects"];
export const TASK_DIMS: Dim[] = ["completion", "params", "question", "effects"];
export const CONTEXT_DIMS: Dim[] = ["context", "memory", "factlock"];

export interface StatePred { path: string; op: "eq" | "includes" | "absent" | "present" | "len_gte" | "len_eq" | "not_includes"; value?: unknown }
export interface Check {
  d: Dim; t: "has_any" | "has_all" | "forbid_any" | "re" | "forbid_re" | "questions_max" | "no_ask_about" | "canned" | "grammar" | "jargon" | "urls_known" | "money_known" | "state" | "no_claim" | "not_repeat";
  why: string;
  v?: string[]; re?: string; n?: number; allow?: string[];
  state?: StatePred; unless?: StatePred;
  hard?: boolean; // a hard failure caps the dimension at 2.0
}
export interface Turn { user: string; thread?: string; checks: Check[] }
export interface Scenario { id: string; title: string; world: string; person: string; turns: Turn[] }
export interface Run { id: string; replies: string[]; state: (unknown | null)[] }
export interface CheckResult { scenario: string; turn: number; d: Dim; t: string; why: string; ok: boolean | null; detail: string; hard: boolean; reply: string; user: string }

// ------------------------------------------------------------------------------------------------ text helpers
const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ");
export const sentences = (s: string) => s.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
const ASK = /\?\s*$|\b(tell me|let me know|please (share|provide|send|give|confirm)|can you (share|send|tell|confirm)|what is your|what's your|which (one|role|city|company)|do you want|would you like|want me to)\b/i;
// Bulleted lines are content (sample interview questions, list items), not questions put to the person.
export const asks = (reply: string) => sentences(reply).filter((s) => !/^[\u00b7\-*\u2022]|^\d+[.)]\s/.test(s) && ASK.test(s));

// Router and bot boilerplate that says nothing about this person. Static list; `canned` also flags any 40+ character sentence that
// appears word for word in replies to three or more different scenarios (computed over the whole run).
export const CANNED_STATIC = [
  "i did not catch what to do with that one", "here is what i can do:", "i'm trainee, your career agent", "tell me what you'd like to do next",
  "nothing is on your record yet", "the record holds only what you state", "tell me one to tailor your resume for, and i will do that next",
  "here is what that means, plainly", "what i will not do is fill the gap", "do you want the general picture", "always held for your approval",
  "review the artifact", "ranked by fit with your profile", "closest fit on your profile, with the gaps named in the caveat",
];
export const JARGON = ["adapter", "payload", "hash", "tool call", "snapshot", "backend", "pipeline", "board_not_wired", "artifact", "ats family", "parse check", "router", "intent", "handler", "schema", "eligibility verdict", "knock-out", "posting's family", "dossier"];
const LEAK = /\b[A-Z]{2,}(?:_[A-Z]{2,})+\b|\bundefined\b|\bNaN\b|\[object|\bcareer_[a-z_]+|\{\w+\}|\bnull\b/;

export function grammarIssues(reply: string): string[] {
  const out: string[] = [];
  if (!reply.trim()) return ["empty reply"];
  if (/[^\n] {2,}\S/.test(reply)) out.push("double space");
  if (/\b(\w{2,})\s+\1\b/i.test(reply.replace(/\b(had|that)\s+\1\b/gi, ""))) out.push("repeated word");
  if (LEAK.test(reply)) out.push(`internal token leaked: ${LEAK.exec(reply)![0]}`);
  if (/\b1 [a-z]+(?: [a-z]+)? (jobs|roles|applications|results)\b/i.test(reply)) out.push("plural after 1");
  if (/\(\s*[^()]*\([^()]*\)[^()]*\)/.test(reply)) out.push("nested parentheses");
  if ((reply.match(/—/g) || []).length > 2) out.push("more than two em dashes");
  for (const s of sentences(reply)) {
    if (s.split(/\s+/).length > 45) { out.push(`run-on sentence of ${s.split(/\s+/).length} words`); break; }
  }
  for (const line of reply.split("\n")) {
    const t = line.trim();
    if (t.length > 60 && !/[.!?:)"'”]$/.test(t) && !/^[-*\d]/.test(t) && !/https?:\/\/\S+$/.test(t)) { out.push("line ends without punctuation"); break; }
  }
  // two sentences glued without a stop: "... (stopped) Tell me what ..."
  if (/[a-z0-9)]\s(Tell me|Want me|Which|What|Do you|Is that|Here is)\b/.test(reply.replace(/\n/g, " ").replace(/[.!?]\s+(Tell|Want|Which|What|Do|Is|Here)/g, "")) ) out.push("two sentences joined without a stop");
  return out;
}

// ------------------------------------------------------------------------------------------------ state predicates
function at(obj: unknown, path: string): unknown {
  return path.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), obj);
}
export function holds(p: StatePred, state: unknown): boolean | null {
  if (state == null) return null;
  const v = at(state, p.path);
  const arr = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  switch (p.op) {
    case "eq": return JSON.stringify(v) === JSON.stringify(p.value);
    case "includes": return arr.some((x) => norm(String(typeof x === "string" ? x : JSON.stringify(x))).includes(norm(String(p.value))));
    case "not_includes": return !arr.some((x) => norm(String(typeof x === "string" ? x : JSON.stringify(x))).includes(norm(String(p.value))));
    case "absent": return v == null || (Array.isArray(v) && v.length === 0);
    case "present": return !(v == null || (Array.isArray(v) && v.length === 0));
    case "len_gte": return Array.isArray(v) && v.length >= Number(p.value);
    case "len_eq": return (Array.isArray(v) ? v.length : v == null ? 0 : -1) === Number(p.value);
  }
}

// A claim in the negative ("nothing was sent", "I have not applied", "hasn't been sent") is the honest sentence, not the false one.
const NEG = /\b(nothing|not|never|no|none|neither|nor|yet to|isn't|wasn't|hasn't|haven't|didn't|don't|won't|can't|cannot|without|until|before|once|after|if|unless)\b|n't\b/i;
// The words of a draft the agent shows for approval (the lines from "Subject:" to the closing ask, and anything in double quotes)
// are the draft's, not the agent's claims: "I applied for the role" inside an email body is not "I applied".
export function narration(reply: string): string {
  const out: string[] = [];
  let inDraft = false;
  for (const line of reply.split("\n")) {
    if (/^\s*(subject|body)\s*:/i.test(line)) { inDraft = true; continue; }
    if (inDraft && /^\s*(reply|say|tell me|want me|should i|is that|does that|ok to|approve)\b/i.test(line)) inDraft = false;
    if (!inDraft && !/^\s*to\s*:/i.test(line)) out.push(line);
  }
  return out.join("\n").replace(/"[^"]{3,}"/g, "").replace(/ {2,}/g, " ");
}
export function firstAffirmed(re: string, reply: string): RegExpExecArray | null {
  for (const s of sentences(narration(reply))) {
    const g = new RegExp(re, "ig");
    let m: RegExpExecArray | null;
    while ((m = g.exec(s))) if (!NEG.test(s.slice(Math.max(0, m.index - 40), m.index + m[0].length + 12))) return m;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ one check
export interface Ctx { reply: string; user: string; prior: string[]; users: string[]; state: unknown; knownUrls: Set<string>; worldText: string; frequent: Set<string> }
export function evalCheck(c: Check, x: Ctx): { ok: boolean | null; detail: string } {
  const r = norm(x.reply);
  const ok = (b: boolean, detail = "") => ({ ok: b, detail: b ? "" : detail });
  switch (c.t) {
    case "has_any": return ok((c.v || []).some((w) => r.includes(norm(w))), `none of [${(c.v || []).join(" | ")}] in the reply`);
    case "has_all": { const miss = (c.v || []).filter((w) => !r.includes(norm(w))); return ok(!miss.length, `missing [${miss.join(" | ")}]`); }
    case "forbid_any": { const hit = (c.v || []).filter((w) => r.includes(norm(w))); return ok(!hit.length, `contains forbidden [${hit.join(" | ")}]`); }
    case "re": return ok(new RegExp(c.re!, "i").test(x.reply), `no match for /${c.re}/`);
    case "forbid_re": { const m = new RegExp(c.re!, "i").exec(x.reply); return ok(!m, `matches /${c.re}/ at "${m?.[0]}"`); }
    case "questions_max": { const a = asks(x.reply); return ok(a.length <= (c.n ?? 1), `${a.length} asks: ${a.map((s) => `"${s}"`).join(" ")}`); }
    case "no_ask_about": {
      const bad = asks(x.reply).filter((s) => (c.v || []).some((p) => new RegExp(p, "i").test(s)));
      return ok(!bad.length, `asks for what is already known: ${bad.map((s) => `"${s}"`).join(" ")}`);
    }
    case "canned": {
      const hits = sentences(x.reply).filter((s) => CANNED_STATIC.some((k) => norm(s).includes(k)) || x.frequent.has(norm(s)));
      return ok(!hits.length, `canned filler: ${hits.map((s) => `"${s.slice(0, 90)}"`).join(" ")}`);
    }
    case "grammar": { const g = grammarIssues(narration(x.reply)); return ok(!g.length, g.join("; ")); }
    case "jargon": { const hit = [...JARGON, ...(c.v || [])].filter((w) => r.includes(w)); return ok(!hit.length, `jargon [${hit.join(", ")}]`); }
    case "urls_known": {
      const bad = (x.reply.match(/https?:\/\/[^\s)>\]"']+/g) || []).map((u) => u.replace(/[.,;]+$/, "")).filter((u) => !x.knownUrls.has(u));
      return ok(!bad.length, `unknown link [${bad.join(" ")}]`);
    }
    case "money_known": {
      const seen = norm(`${x.worldText} ${x.users.join(" ")} ${(c.allow || []).join(" ")}`).replace(/,/g, "");
      const amounts = (x.reply.replace(/,/g, "").match(/\$\s?\d+(?:\.\d+)?\s?[km]?\b|\b\d{2,3}\s?k\b/gi) || []).map((m) => norm(m).replace(/\s/g, "").replace("$", ""));
      const bad = amounts.filter((a) => !seen.replace(/\s/g, "").includes(a));
      return ok(!bad.length, `amount not in the person's facts or the postings: [${bad.join(", ")}]`);
    }
    case "state": { const h = holds(c.state!, x.state); return h === null ? { ok: null, detail: "no state supplied" } : ok(h, `state ${c.state!.path} ${c.state!.op} ${JSON.stringify(c.state!.value ?? "")} does not hold (got ${JSON.stringify(at(x.state, c.state!.path))?.slice(0, 160)})`); }
    case "no_claim": {
      const m = firstAffirmed(c.re!, x.reply);
      if (!m) return { ok: true, detail: "" };
      if (!c.unless) return ok(false, `claims "${m[0]}"`);
      const h = holds(c.unless, x.state);
      return h === null ? { ok: null, detail: `claims "${m[0]}" and no state to back it` } : ok(h, `claims "${m[0]}" but ${c.unless.path} ${c.unless.op} ${JSON.stringify(c.unless.value ?? "")} is false`);
    }
    case "not_repeat": return ok(!x.prior.some((p) => norm(p) === r), "same reply as an earlier turn");
  }
}

// ------------------------------------------------------------------------------------------------ scoring
export interface Score { dims: Record<Dim, { score: number | null; passed: number; failed: number; unmeasured: number; hard_failures: number }>; task: number | null; context: number | null; overall: number | null; scenarios: { passed: number; total: number } }

export function frequentSentences(runs: Run[]): Set<string> {
  const seen = new Map<string, Set<string>>();
  for (const run of runs) for (const rep of run.replies) for (const s of sentences(rep)) {
    const k = norm(s);
    if (k.length < 40) continue;
    if (!seen.has(k)) seen.set(k, new Set());
    seen.get(k)!.add(run.id);
  }
  return new Set([...seen].filter(([, ids]) => ids.size >= 3).map(([k]) => k));
}

export function scoreAll(scenarios: Scenario[], runs: Run[], worlds: Record<string, { urls: string[]; text: string }>): { results: CheckResult[]; score: Score } {
  const frequent = frequentSentences(runs);
  const results: CheckResult[] = [];
  for (const sc of scenarios) {
    const run = runs.find((r) => r.id === sc.id);
    if (!run) continue;
    const w = worlds[sc.world] ?? { urls: [], text: "" };
    sc.turns.forEach((t, i) => {
      const reply = run.replies[i] ?? "";
      for (const c of t.checks) {
        const res = evalCheck(c, { reply, user: t.user, prior: run.replies.slice(0, i), users: sc.turns.slice(0, i + 1).map((q) => q.user), state: run.state[i] ?? null, knownUrls: new Set(w.urls), worldText: w.text, frequent });
        results.push({ scenario: sc.id, turn: i + 1, d: c.d, t: c.t, why: c.why, ok: res.ok, detail: res.detail, hard: !!c.hard, reply, user: t.user });
      }
    });
  }
  const dims = {} as Score["dims"];
  for (const d of DIMS) {
    const rs = results.filter((r) => r.d === d);
    const passed = rs.filter((r) => r.ok === true).length, failed = rs.filter((r) => r.ok === false).length, unmeasured = rs.filter((r) => r.ok === null).length;
    const hard = rs.filter((r) => r.ok === false && r.hard).length;
    let s: number | null = passed + failed ? Math.round((50 * passed) / (passed + failed)) / 10 : null;
    if (s !== null && hard) s = Math.min(s, 2);
    dims[d] = { score: s, passed, failed, unmeasured, hard_failures: hard };
  }
  const mean = (ds: Dim[]) => { const v = ds.map((d) => dims[d].score); return v.some((x) => x === null) ? null : Math.round((v as number[]).reduce((a, b) => a + b, 0) * 10 / v.length) / 10; };
  const failedScn = new Set(results.filter((r) => r.ok === false).map((r) => r.scenario));
  return { results, score: { dims, task: mean(TASK_DIMS), context: mean(CONTEXT_DIMS), overall: mean(DIMS), scenarios: { passed: scenarios.filter((s) => runs.some((r) => r.id === s.id) && !failedScn.has(s.id)).length, total: runs.length } } };
}

// Worst failures first: hard before soft, then the dimensions that matter most to the owner's two 5/5 bars, then earlier turns.
const WEIGHT: Record<Dim, number> = { factlock: 8, effects: 8, context: 6, completion: 6, params: 5, memory: 5, question: 4, natural: 2 };
export function worst(results: CheckResult[], n = 10): CheckResult[] {
  const bad = results.filter((r) => r.ok === false);
  // one entry per (scenario, turn): its heaviest failed check, so ten rows are ten different replies
  const best = new Map<string, CheckResult>();
  const rank = (r: CheckResult) => (r.hard ? 100 : 0) + WEIGHT[r.d];
  for (const r of bad) { const k = `${r.scenario}:${r.turn}`; if (!best.has(k) || rank(r) > rank(best.get(k)!)) best.set(k, r); }
  return [...best.values()].sort((a, b) => rank(b) - rank(a) || a.scenario.localeCompare(b.scenario)).slice(0, n);
}

// ------------------------------------------------------------------------------------------------ world facts the checks lean on
export function worldIndex(world: any): { urls: string[]; text: string } {
  const urls = new Set<string>();
  for (const p of world.postings ?? []) urls.add(p.url);
  for (const j of world.apply_jobs ?? []) urls.add(j.url);
  for (const p of world.prepared ?? []) urls.add(p.url);
  for (const w of world.wanted ?? []) urls.add(w.url);
  const text = JSON.stringify([world.postings, world.facts, world.standing, world.apply_jobs, world.outreach, world.questions, world.alerts, world.tracked, world.prepared]);
  return { urls: [...urls], text };
}

export async function worldState(w: any, userId: string): Promise<unknown> {
  const row = await w.alerts.get(userId);
  const wants = await w.wants.list(userId);
  const drafts = w.outreach.dump().drafts.filter((d: any) => d.user_id === userId);
  return {
    alert: row ? row.prefs : null,
    alert_keywords: row ? row.prefs.keywords : [],
    alert_locations: row ? row.prefs.locations : [],
    drafts: drafts.map((d: any) => ({ firm: d.recipient?.firm, status: d.status, sent_at: d.sent_at, approved_hash: d.approved_hash })),
    sent_drafts: drafts.filter((d: any) => d.sent_at || d.status === "sent").map((d: any) => d.recipient?.firm),
    jobs: w.jobs.map((j: any) => ({ company: j.company, state: j.state })),
    submitted_jobs: w.jobs.filter((j: any) => ["submitted", "confirmed"].includes(j.state)).map((j: any) => j.company),
    wanted: wants.map((x: any) => x.company),
    prepared: w.prepared.map((p: any) => ({ company: p.company, state: p.state })),
  };
}

// ------------------------------------------------------------------------------------------------ brains
export type Brain = (sc: Scenario) => Promise<Run>;
export async function routerBrain(worldFor: (name: string) => Promise<any>, kind: "router" | "agent", model?: (p: any) => Promise<any>): Promise<Brain> {
  const { openWorld, worldTurn, USER } = await import("./world.ts");
  const { standingTurn, supabaseStanding } = await import("../../supabase/functions/_shared/career_standing.ts");
  return async (sc) => {
    const w = await openWorld(await worldFor(sc.world), {});
    let now = w.now;
    const replies: string[] = [], state: unknown[] = [];
    for (const t of sc.turns) {
      // handler-career.ts answers the status, inbox and follow-up asks from code before any brain (WO-107); world.ts does not.
      const st = await standingTurn({ message: t.user, userId: USER, now, read: supabaseStanding(w.admin) }).catch(() => null);
      const r = st ? { reply: st.reply } : await worldTurn(w, { brain: kind, threadId: t.thread ?? "A", message: t.user, now, model });
      replies.push(r.reply); state.push(await worldState(w, USER));
      now += 90000;
    }
    return { id: sc.id, replies, state };
  };
}

// ------------------------------------------------------------------------------------------------ CLI
if (import.meta.main) {
  const args = Deno.args, opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] ?? null : null; };
  const fix = JSON.parse(await Deno.readTextFile(new URL("./task-context-brutal.json", import.meta.url)));
  const only = opt("--only");
  const scenarios: Scenario[] = fix.scenarios.filter((s: Scenario) => !only || only.split(",").includes(s.id));
  const loadWorld = async (name: string) => JSON.parse(await Deno.readTextFile(new URL(`./${fix.worlds[name]}`, import.meta.url)));
  const worlds: Record<string, { urls: string[]; text: string }> = {};
  for (const n of Object.keys(fix.worlds)) worlds[n] = worldIndex(await loadWorld(n));
  const replay = opt("--replay"), http = opt("--http"), brainName = replay ? "replay" : http ? "http" : opt("--brain") || "router";
  const label = opt("--label") || `${brainName}-${new Date().toISOString().slice(0, 10)}`;
  let brain: Brain;
  if (replay) {
    const rec = JSON.parse(await Deno.readTextFile(replay));
    brain = async (sc) => { const r = rec[sc.id]; if (!r) throw new Error("no recorded replies"); return { id: sc.id, replies: r.replies, state: sc.turns.map((_, i) => r.state?.[i] ?? null) }; };
  } else if (http) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    args.forEach((a, i) => { if (a === "--header") { const [k, ...v] = (args[i + 1] || "").split("="); headers[k] = v.join("=").replace(/-/g, " ").replace(/^Bearer (.*)$/, "Bearer $1"); } });
    brain = async (sc) => {
      const replies: string[] = [], state: unknown[] = [];
      for (const [i, t] of sc.turns.entries()) {
        const res = await fetch(http, { method: "POST", headers, body: JSON.stringify({ scenario: sc.id, turn: i + 1, thread_id: t.thread ?? "A", message: t.user }) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json(); replies.push(String(j.reply ?? "")); state.push(j.state ?? null);
      }
      return { id: sc.id, replies, state };
    };
  } else if (brainName === "agent") {
    if (!Deno.env.get("OPENAI_API_KEY")) { console.log("NOT RUN: no OPENAI_API_KEY (the agent brain calls the model)."); Deno.exit(2); }
    const { callModel, modelConfig, newMeter } = await import("../../supabase/functions/_shared/model_gateway.ts");
    const meter = newMeter(), cfg = { ...modelConfig(Deno.env, "chat"), model: Deno.env.get("CAREER_MODEL") || "gpt-5-mini" };
    brain = await routerBrain(loadWorld, "agent", (p: any) => callModel(cfg, p, { meter, role: "chat" }));
  } else if (brainName === "router") brain = await routerBrain(loadWorld, "router");
  else { console.log(`NOT RUN: --brain must be router or agent (got ${brainName}).`); Deno.exit(2); }

  const runs: Run[] = [], errors: Record<string, string> = {};
  for (const sc of scenarios) {
    try { runs.push(await brain(sc)); } catch (e) { errors[sc.id] = e instanceof Error ? e.message : String(e); }
  }
  const { results, score } = scoreAll(scenarios, runs, worlds);
  const w10 = worst(results, 10);
  let commit = "unknown";
  try { commit = new TextDecoder().decode((await new Deno.Command("git", { args: ["rev-parse", "--short", "HEAD"] }).output()).stdout).trim(); } catch { /* not a checkout */ }
  const out = { label, brain: brainName, commit, run_at: new Date().toISOString(), score, errors, worst: w10, unmeasured: results.filter((r) => r.ok === null).map((r) => `${r.scenario}.${r.turn} ${r.t}: ${r.why}`), runs, results };
  await Deno.mkdir(new URL("./results/", import.meta.url), { recursive: true });
  await Deno.writeTextFile(new URL(`./results/task-context-brutal.${label}.json`, import.meta.url), JSON.stringify(out, null, 1));
  console.log(`${label} (${brainName}): scenarios clean ${score.scenarios.passed}/${score.scenarios.total}; checks ${results.filter((r) => r.ok === true).length} pass, ${results.filter((r) => r.ok === false).length} fail, ${results.filter((r) => r.ok === null).length} unmeasured`);
  for (const d of DIMS) { const s = score.dims[d]; console.log(`  ${d.padEnd(10)} ${s.score === null ? "n/a" : s.score.toFixed(1)}/5  (${s.passed} pass, ${s.failed} fail${s.unmeasured ? `, ${s.unmeasured} unmeasured` : ""}${s.hard_failures ? `, ${s.hard_failures} hard` : ""})`); }
  console.log(`  TASK ORIENTATION ${score.task ?? "n/a"}/5 · INDIVIDUAL CONTEXT ${score.context ?? "n/a"}/5 · overall ${score.overall ?? "n/a"}/5`);
  if (Object.keys(errors).length) console.log(`errors: ${JSON.stringify(errors)}`);
  console.log("\nworst:");
  for (const r of w10) console.log(`  ${r.scenario}.${r.turn} [${r.d}${r.hard ? ",hard" : ""}] ${r.why}\n    U: ${r.user}\n    A: ${r.reply.replace(/\n/g, " / ").slice(0, 400)}\n    -> ${r.detail}`);
  Deno.exit(DIMS.every((d) => score.dims[d].score === 5) ? 0 : 1);
}
