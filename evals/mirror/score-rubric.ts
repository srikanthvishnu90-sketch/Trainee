// MIRROR WA-1, the 10/10 rubric grader (architect, 2026-11-16). Grades one transcript against
// evals/mirror/instinct-wa-batch1/rubric.json, element by element; Instinct is 6/10 on every turn (owner's ruling).
//   deno run -A --no-check evals/mirror/score-rubric.ts --transcript <trainee.jsonl> [--judge none|subscription]
//     [--model claude-sonnet-5-5] [--rubric <rubric.json>] [--json out.json] [--hand <{id: score}.json>] [--only C1,C2]
//
// The transcript is run-conversation.ts's output (reply, actions and the tool trace per turn); instinct.jsonl ({id, messages})
// is read too, with no trace. An element is yes only with proof:
//   code    its `check` is mechanical (a tool ran with the required inputs and no error, a File or posting link was delivered, the
//           prose is under N characters, a date is present, "not sent" is stated, nothing was queued or sent, no claim of an
//           action the trace does not prove). Where the check is the whole element, code decides it.
//   judge   for everything else (and after a `check` marked `judge: true` passes), the judge answers yes or no per element and
//           must quote the turn's delivered text (the reply, its File pages, its documents). A yes whose quote is not found
//           there is a no. With --judge none, those elements are "unjudged" and count as no.
// The judge runs only on the owner's Claude subscription through evals/subscription/claude_cli.ts (D-089; it strips
// ANTHROPIC_API_KEY and refuses unless the CLI reports apiKeySource "none"). It is a parameter, so tests pass a stub at $0.
// Score per turn = 10 x MUST met / MUST total (one decimal), capped at 8 unless at least half the NICEs are met.
import { internalWords } from "../../supabase/functions/_shared/reply_rubric.ts";
import { textOf, TRAINEE_RESTATED } from "./score-conversation.ts";

export const RUBRIC_PATH = new URL("./instinct-wa-batch1/rubric.json", import.meta.url);
export const INSTINCT_SCORE = 6;

export type Check = {
  tool?: string[]; tool_ok?: string[]; tool_all?: string[]; no_tool?: string[]; no_error?: string[]; args?: string;
  file?: boolean; doc?: string; doc_has?: string; doc_lacks?: string; link?: boolean; max?: number; date?: boolean;
  has?: string; lacks?: string; not_sent?: boolean; no_action?: boolean; no_claim?: boolean; no_host?: string;
  ends_ask?: boolean; clean?: boolean; judge?: boolean;
};
export type Element = { id: string; group: string; text: string; level: "MUST" | "NICE"; check?: Check; needs_capability?: string };
export type Scenario = { id: string; prompt: string; task: string; elements: Element[] };
export type Rubric = { scenarios: Scenario[] };
export type Turn = {
  id: string; reply?: string; messages?: string[]; setup?: boolean; route?: string; actions?: { type: string; hosts?: string[] }[];
  trace?: {
    called?: string[]; router_intent?: string | null; call_errors?: { name: string; error: string }[]; args?: { name: string; args: unknown }[]; artifact?: boolean;
    files?: { link?: string; status?: number; text?: string }[]; documents?: { filename?: string; mime?: string; status?: string; text?: string }[];
  };
};
export type JudgeAsk = { scenario: { id: string; prompt: string; task: string }; elements: { id: string; text: string }[]; reply: string; delivered: string; trace: string };
export type Verdict = { id: string; yes: boolean; quote: string; why?: string };
export type Judge = (ask: JudgeAsk) => Promise<Verdict[]>;
export type ElementResult = { id: string; level: string; group: string; yes: boolean; by: "code" | "judge" | "unjudged"; evidence: string };
export type TurnResult = { id: string; score: number; capped: boolean; must: { met: number; total: number }; nice: { met: number; total: number }; ran: boolean; elements: ElementResult[] };

const URL_RX = /https?:\/\/[^\s)\]>"']+/g;
const FILE_PLACEHOLDER = /\[[^\]]*\bfile\b[^\]]*link[^\]]*\]/i;
const DATE_RX = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}\b|\b\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/i;
// A claim of an external act in the first person ("I sent", "I've applied"); "I haven't sent" does not match.
const ACT_CLAIM = /\b(?:I|we)(?:'ve| have)? (?:just |already )?(?:sent|submitted|applied|emailed|messaged|contacted)\b/i;
// A claim of a live check ("I checked it live", "verified just now") needs a check that ran without error.
const CHECK_CLAIM = /\b(?:I|we)(?:'ve| have)? (?:just )?(?:checked|verified|confirmed)\b[^.?!]{0,60}\b(?:live|just now|right now|still open|is open)\b/i;
const LIVE_CHECKS = ["check_posting_open", "inspect_apply_flow"];
// A router turn runs its act in code, not as a model tool call; the trace names the router's intent instead.
const ROUTER_ACTS: Record<string, string[]> = { career_internship_discovery: ["search_jobs"], career_discovery: ["search_jobs"] };

export const replyOf = (t: Turn): string => t.reply ?? (t.messages ?? []).join("\n");
export const norm = (s: string): string =>
  s.normalize("NFKC").replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
    .replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

function fileLinks(t: Turn): Set<string> {
  return new Set((t.trace?.files ?? []).map((f) => String(f.link ?? "")).filter(Boolean));
}
/** What the turn delivered beyond the reply: the File pages it opened and the documents it attached. */
export function deliveredText(t: Turn): string {
  return [...(t.trace?.files ?? []).map((f) => f.text ?? ""), ...(t.trace?.documents ?? []).map((d) => d.text ?? "")].filter(Boolean).join("\n");
}

/** One deterministic check: null when it holds, else why it failed. */
export function runCheck(c: Check, t: Turn): string | null {
  const reply = replyOf(t), prose = textOf([reply]);
  const called = [...(t.trace?.called ?? []), ...(t.route === "router" ? ROUTER_ACTS[t.trace?.router_intent ?? ""] ?? [] : [])], errs = t.trace?.call_errors ?? [];
  const okRan = (n: string) => called.includes(n) && called.filter((x) => x === n).length > errs.filter((e) => e.name === n).length;
  const actions = t.actions ?? [];
  const rx = (s: string) => new RegExp(s, "i");
  if (c.tool && !c.tool.some((n) => called.includes(n))) return `none of ${c.tool.join(", ")} ran`;
  if (c.tool_all) { const miss = c.tool_all.filter((n) => !called.includes(n)); if (miss.length) return `${miss.join(", ")} did not run`; }
  if (c.tool_ok && !c.tool_ok.some(okRan)) return `${c.tool_ok.join(" / ")} did not run without error${errs.some((e) => c.tool_ok!.includes(e.name)) ? ` (${errs.filter((e) => c.tool_ok!.includes(e.name)).map((e) => `${e.name}: ${e.error}`).join("; ")})` : ""}`;
  if (c.no_tool) { const ran = c.no_tool.filter((n) => called.includes(n)); if (ran.length) return `${ran.join(", ")} ran`; }
  if (c.no_error) { const bad = errs.filter((e) => c.no_error!.includes(e.name)); if (bad.length) return `call error: ${bad.map((e) => `${e.name}: ${e.error}`).join("; ")}`; }
  if (c.args) {
    const names = c.tool ?? c.tool_ok ?? c.tool_all;
    const got = (t.trace?.args ?? []).filter((a) => !names || names.includes(a.name));
    if (!got.some((a) => rx(c.args!).test(JSON.stringify(a.args)))) return `no recorded input matches /${c.args}/ (${got.length ? JSON.stringify(got).slice(0, 200) : "no inputs recorded"})`;
  }
  if (c.file && !(t.trace?.artifact === true || (t.trace?.files ?? []).some((f) => f.status === 200) || FILE_PLACEHOLDER.test(reply))) return "no File link delivered";
  if (c.doc) {
    const docs = (t.trace?.documents ?? []).filter((d) => d.status === "read" && rx(c.doc!).test(`${d.filename ?? ""} ${d.mime ?? ""}`));
    if (!docs.length) return `no ${c.doc} document attached and read`;
    if (c.doc_has && !docs.some((d) => rx(c.doc_has!).test(d.text ?? ""))) return `the document does not contain /${c.doc_has}/`;
    if (c.doc_lacks && docs.some((d) => rx(c.doc_lacks!).test(d.text ?? ""))) return `the document contains /${c.doc_lacks}/`;
  }
  if (c.link) {
    const files = fileLinks(t);
    if (!(reply.match(URL_RX) ?? []).some((u) => !files.has(u.replace(/[.,;:]+$/, "")) && !u.includes("["))) return "no posting or source link in the reply";
  }
  if (c.max !== undefined && prose.length > c.max) return `${prose.length} characters of prose, over ${c.max}`;
  if (c.date && !DATE_RX.test(reply)) return "no date in the reply";
  if (c.has && !rx(c.has).test(reply)) return `the reply does not match /${c.has}/`;
  if (c.lacks) { const m = reply.match(rx(c.lacks)); if (m) return `the reply says "${m[0]}"`; }
  if (c.not_sent && !TRAINEE_RESTATED.test(prose)) return "the boundary (not sent / not submitted) is not stated";
  if (c.no_action) { const a = actions.filter((x) => x.type !== "external"); if (a.length) return `actions taken: ${a.map((x) => x.type).join(", ")}`; }
  if (c.no_claim) {
    const act = reply.match(ACT_CLAIM);
    if (act && !actions.some((x) => x.type === "send" || x.type === "submit")) return `claims "${act[0]}" with no send or submit recorded`;
    const chk = reply.match(CHECK_CLAIM);
    if (chk && !LIVE_CHECKS.some(okRan)) return `claims "${chk[0]}" but no live check ran without error`;
  }
  if (c.no_host) { const h = actions.flatMap((x) => x.hosts ?? []).filter((x) => rx(c.no_host!).test(x)); if (h.length) return `requests to ${h.join(", ")}`; }
  if (c.ends_ask && !/\?["')\]]*$/.test(prose)) return "does not end with a question";
  if (c.clean) { const v = internalWords({ reply } as any); if (v.length) return `internal words: ${v.map((x: any) => x.quote).join(", ")}`; }
  return null;
}

/** The quote rule: a yes stands only when its quote (at least 4 characters) is found in what the turn delivered. */
export function quoteFound(quote: string, t: Turn): boolean {
  const q = norm(quote ?? "").replace(/^\.\.\.|\.\.\.$/g, "").trim();
  return q.length >= 4 && norm(`${replyOf(t)}\n${deliveredText(t)}`).includes(q);
}

export function scoreOf(els: { level: string; yes: boolean }[]): { score: number; capped: boolean; must: { met: number; total: number }; nice: { met: number; total: number } } {
  const must = els.filter((e) => e.level === "MUST"), nice = els.filter((e) => e.level === "NICE");
  const m = { met: must.filter((e) => e.yes).length, total: must.length }, n = { met: nice.filter((e) => e.yes).length, total: nice.length };
  const raw = m.total ? (10 * m.met) / m.total : 10;
  const capped = raw > 8 && n.met * 2 < n.total;
  return { score: Math.round((capped ? 8 : raw) * 10) / 10, capped, must: m, nice: n };
}

function traceSummary(t: Turn): string {
  const tr = t.trace ?? {};
  return JSON.stringify({ called: tr.called ?? [], call_errors: tr.call_errors ?? [], inputs: tr.args ?? [], actions: t.actions ?? [], file: tr.artifact ?? false });
}

export async function gradeTurn(s: Scenario, t: Turn | undefined, judge: Judge | null): Promise<TurnResult> {
  if (!t) {
    const elements = s.elements.map((e) => ({ id: e.id, level: e.level, group: e.group, yes: false, by: "code" as const, evidence: "the turn was not run" }));
    return { id: s.id, ...scoreOf(elements), ran: false, elements };
  }
  const out = new Map<string, ElementResult>(), ask: Element[] = [];
  for (const e of s.elements) {
    const why = e.check ? runCheck(e.check, t) : null;
    if (e.check && why) out.set(e.id, { id: e.id, level: e.level, group: e.group, yes: false, by: "code", evidence: why });
    else if (e.check && !e.check.judge) out.set(e.id, { id: e.id, level: e.level, group: e.group, yes: true, by: "code", evidence: "check passed" });
    else ask.push(e);
  }
  let verdicts: Verdict[] = [];
  if (ask.length && judge) {
    try {
      verdicts = await judge({ scenario: { id: s.id, prompt: s.prompt, task: s.task }, elements: ask.map((e) => ({ id: e.id, text: e.text })), reply: replyOf(t), delivered: deliveredText(t).slice(0, 12000), trace: traceSummary(t) });
    } catch (err) { verdicts = ask.map((e) => ({ id: e.id, yes: false, quote: "", why: `judge failed: ${(err as Error).message}`.slice(0, 200) })); }
  }
  for (const e of ask) {
    const v = verdicts.find((x) => x.id === e.id);
    const pre = e.check ? "check passed; " : "";
    if (!judge || !v) { out.set(e.id, { id: e.id, level: e.level, group: e.group, yes: false, by: "unjudged", evidence: `${pre}${judge ? "the judge gave no verdict" : "not judged (--judge none)"}` }); continue; }
    const found = v.yes && quoteFound(v.quote, t);
    const evidence = v.yes ? (found ? `"${v.quote}"` : `the judge said yes but its quote is not in the reply: "${String(v.quote).slice(0, 120)}"`) : (v.why || "the judge said no");
    out.set(e.id, { id: e.id, level: e.level, group: e.group, yes: found, by: "judge", evidence: pre + evidence });
  }
  const elements = s.elements.map((e) => out.get(e.id)!);
  return { id: s.id, ...scoreOf(elements), ran: true, elements };
}

export async function gradeTranscript(rubric: Rubric, turns: Turn[], judge: Judge | null, only?: string[]): Promise<TurnResult[]> {
  const byId = new Map(turns.filter((t) => !t.setup).map((t) => [t.id, t]));
  const res: TurnResult[] = [];
  for (const s of rubric.scenarios) if (!only || only.includes(s.id)) res.push(await gradeTurn(s, byId.get(s.id), judge));
  return res;
}

export function summaryTable(rows: TurnResult[], hand?: Record<string, number>): string {
  const head = `| turn | score | Instinct | vs Instinct | MUST met | NICE met |${hand ? " hand |" : ""}\n|---|---|---|---|---|---|${hand ? "---|" : ""}`;
  const fmt = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  const lines = rows.map((r) => `| ${r.id} | ${r.score}${r.capped ? " (capped)" : ""}${r.ran ? "" : " (not run)"} | ${INSTINCT_SCORE} | ${fmt(Math.round((r.score - INSTINCT_SCORE) * 10) / 10)} | ${r.must.met}/${r.must.total} | ${r.nice.met}/${r.nice.total} |${hand ? ` ${hand[r.id] ?? "-"} |` : ""}`);
  const mean = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)) * 100) / 100;
  const hs = rows.map((r) => hand?.[r.id]).filter((x): x is number => typeof x === "number");
  const foot = `| mean | ${mean(rows.map((r) => r.score))} | ${INSTINCT_SCORE} | ${fmt(Math.round((mean(rows.map((r) => r.score)) - INSTINCT_SCORE) * 100) / 100)} | | |${hand ? ` ${mean(hs)} |` : ""}`;
  return [head, ...lines, foot].join("\n");
}

const VERDICTS_SCHEMA = {
  type: "object",
  properties: { verdicts: { type: "array", items: { type: "object", properties: { id: { type: "string" }, yes: { type: "boolean" }, quote: { type: "string" }, why: { type: "string" } }, required: ["id", "yes", "quote"] } } },
  required: ["verdicts"],
};
const JUDGE_SYSTEM = [
  "You grade one turn of a career agent's chat against a rubric. For each element, answer yes only if the turn clearly meets it.",
  "For a yes, quote word for word the shortest passage of the reply (or of its delivered File or document text) that proves it;",
  "a yes without an exact quote counts as no. For a no, give the reason in a few words and an empty quote. Judge what was",
  "delivered, not what was intended. The tool trace shows what ran; never accept a claim the trace contradicts.",
].join(" ");

/** The judge on the owner's subscription (evals/subscription/claude_cli.ts, PR #853). One call per turn, one verdict per element. */
export async function subscriptionJudge(model = "claude-sonnet-5-5"): Promise<Judge> {
  if (Deno.env.get("ANTHROPIC_API_KEY") || Deno.env.get("ANTHROPIC_AUTH_TOKEN")) throw new Error("refusing: unset ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN (env -u ...); the judge runs on the subscription only");
  const bridge = "../subscription/claude_cli.ts";
  const cli = await import(bridge).catch(() => { throw new Error(`the subscription bridge ${bridge} is not here (PR #853)`); });
  await cli.preflight(model);
  return async (a) => {
    const content = [`Scenario ${a.scenario.id}. The person asked: ${a.scenario.prompt}`, `The task: ${a.scenario.task}`, `Tool trace: ${a.trace}`,
      `<reply>\n${a.reply}\n</reply>`, a.delivered ? `<delivered>\n${a.delivered}\n</delivered>` : "<delivered>none</delivered>",
      "Elements:", ...a.elements.map((e) => `- ${e.id}: ${e.text}`)].join("\n\n");
    const r = await cli.messages({ model, max_tokens: 4000, system: JUDGE_SYSTEM, messages: [{ role: "user", content }], output_config: { format: { type: "json_schema", schema: VERDICTS_SCHEMA } } });
    return (JSON.parse(r.content?.[0]?.text ?? "{}").verdicts ?? []) as Verdict[];
  };
}

if (import.meta.main) {
  const arg = (k: string) => { const i = Deno.args.indexOf(`--${k}`); return i >= 0 ? Deno.args[i + 1] : undefined; };
  const path = arg("transcript");
  if (!path) { console.error("usage: score-rubric.ts --transcript <jsonl> [--judge none|subscription] [--model m] [--rubric p] [--json out] [--hand h.json] [--only C1,C2]"); Deno.exit(2); }
  const rubric: Rubric = JSON.parse(await Deno.readTextFile(arg("rubric") ?? RUBRIC_PATH));
  const turns: Turn[] = (await Deno.readTextFile(path)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const mode = arg("judge") ?? "none";
  if (mode !== "none" && mode !== "subscription") { console.error(`--judge ${mode}: only none or subscription (never the API)`); Deno.exit(2); }
  const judge = mode === "subscription" ? await subscriptionJudge(arg("model")) : null;
  const rows = await gradeTranscript(rubric, turns, judge, arg("only")?.split(","));
  const hand = arg("hand") ? JSON.parse(await Deno.readTextFile(arg("hand")!)) : undefined;
  for (const r of rows) {
    console.log(`\n${r.id}  ${r.score}/10${r.capped ? " (capped at 8: under half the NICEs)" : ""}  MUST ${r.must.met}/${r.must.total}  NICE ${r.nice.met}/${r.nice.total}`);
    for (const e of r.elements) console.log(`  ${e.yes ? "yes" : "no "} ${e.id} [${e.level}] (${e.by}) ${e.evidence.slice(0, 160)}`);
  }
  console.log(`\n${summaryTable(rows, hand)}`);
  if (arg("json")) await Deno.writeTextFile(arg("json")!, JSON.stringify({ judge: mode, rows }, null, 1) + "\n");
}
