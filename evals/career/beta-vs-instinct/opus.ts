// BETA VS INSTINCT, QUALITY ARM (2026-11-04): Trainee against a Claude Opus 5.5 reference answer, judged pairwise.
//
// The primary metric stays the deterministic task-completion score in run.ts (which layer answered, was each requested
// deliverable produced, did the guards hold). This file adds the quality metric the owner asked for: for each of the
// 104 prompts in each account state, a reference reply written by Opus 5.5 given the same person context Trainee has
// (the fictional persona, the seeded account, the earlier turns of the thread, the same posting board), then a pairwise
// judge that compares Trainee's reply with the reference on five dimensions.
//
// BILLING: every model call goes through the `claude` CLI on the owner's subscription, never an API key:
//   claude -p --model <opus|haiku> --output-format json --tools "" --strict-mcp-config   (prompt on stdin)
// with ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN removed from a cleared child environment (score.ts cliEnv). Before
// the first call the run checks once with `--output-format stream-json --verbose` that the init event reports
// apiKeySource "none", and stops if it does not.
//
// CACHE: references are cached in opus-refs.json (keyed by the hash of the item prompt, which depends only on the case,
// the state and the static context, so the cache survives code changes) and pairwise verdicts in pairwise-cache.json
// (keyed by the hash of the item, which includes Trainee's reply, so a changed reply is re-judged). Both are committed:
// a rerun on an unchanged reply costs nothing. Fictional persona only; no secrets.
//
// CAPS: items are batched (--batch, default 8 refs / 6 judgements per call), calls are capped (--max-calls, default 60)
// and run with bounded concurrency (--concurrency, default 3). A rate-limit or failed call stops new calls; the report
// then says PARTIAL and counts what is missing. Nothing is ever retried in a loop.
//
// SCRIPTED BRAIN: a record the staged brain answered carries the scripted marker text (run.ts), not a real reply, so it
// is NOT compared (reported "not comparable"); comparing it would only measure the stand-in. Live-model quality of
// those turns needs a live run (S3), which this benchmark never makes.
//
//   deno run -A --no-check evals/career/beta-vs-instinct/opus.ts --results evals/career/beta-vs-instinct/results/<label>.json
//     [--refs-only] [--max-calls 60] [--batch 8] [--judge-batch 6] [--concurrency 3] [--judge-model haiku] [--dry]
import { type Case, CLI_ARGS, cliEnv, type Rec, subscriptionGate } from "./score.ts";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = new URL("../../..", import.meta.url).pathname;
const args = Deno.args;
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const num = (k: string, d: number) => { const v = arg(k); return v ? Number(v) : d; };

export const REF_MODEL = "opus";
export const DIMENSIONS = [
  ["ask", "understood the real ask, including its constraints and negations (\"do not apply\", \"for review only\", \"without starting one\")"],
  ["delivered", "delivered every item the person asked for (links, counts, a File or its content, a draft, a direct answer)"],
  ["correct", "correct, with no invented facts about the person, employers, sources or what happened"],
  ["texting", "brief and fit for a text message (no internal jargon, no wall of text, no filler)"],
  ["next", "ends with one clear, useful next step or question"],
] as const;

// ------------------------------------------------------------------------------------------------ the shared context
// What Trainee has for this person, written once. The board is the benchmark's synthetic pool (run.ts market): the
// support and healthcare rows a correct answer would use, with their real board URLs, so the reference can give links
// exactly as Trainee could.
export function board(): string {
  const rows: string[] = [];
  let i = 0;
  const add = (company: string, title: string, location: string) => {
    i++; const b = company.toLowerCase().replace(/[^a-z0-9]+/g, "");
    rows.push(`- ${title} at ${company}, ${location}: https://boards.greenhouse.io/${b}/jobs/${1000 + i}`);
  };
  for (const c of ["Lakeview Telecom", "Harbor Freight Lines", "Northwind Health", "Prairie Bank", "Loop Software", "Wicker Supply", "Midway Travel", "Fulton Foods", "Union Station Retail", "Pilsen Logistics", "Ravenswood Insurance", "Bridgeport Utilities", "Hyde Park Learning", "Lincoln Park Pets"]) add(`${c} (TEST)`, "Customer Support Specialist (Entry Level)", "Chicago, IL");
  for (const c of ["Cloudnine Apps", "Remotely Inc", "Async Works", "Homebase Help", "Anywhere Desk", "Distant Co"]) add(`${c} (TEST)`, "Remote Customer Support Associate", "Remote (US)");
  for (const [t, c] of [["Patient Access Representative", "Lakeshore Clinic"], ["Medical Receptionist", "Southside Health"], ["Unit Coordinator", "Mercy Lake Hospital"], ["Medical Records Clerk", "Northshore Medical"], ["Billing Specialist (Healthcare)", "Riverside Physicians"], ["Pharmacy Technician Trainee", "Elm Pharmacy"]]) add(`${c} (TEST)`, t, "Chicago, IL");
  return rows.join("\n") + "\n- (and about 570 other postings in other families and cities: data analyst, software intern, marketing, sales, retail, warehouse, accounting, nursing, barista)";
}
export const SEEDED = (resume: string) => `THE ACCOUNT (seeded): earlier in this thread the person
1. pasted this resume and confirmed it with "yes, that's my resume":
${resume.trim()}
2. said "I got an offer from Northwind Health for $24/hour as a Customer Support Specialist in Chicago";
3. asked "draft a counter email asking for $27/hour" (a counter draft at $27/hour is held for their review; nothing sent);
4. asked "find 3 customer support jobs in Chicago" and was shown a list of Chicago customer support roles from the board below (Lakeview Telecom, Harbor Freight Lines, Northwind Health first).
No application has been prepared, approved or submitted. No job alert exists. No contacts have been imported.`;
export const EMPTY = `THE ACCOUNT (empty): a brand-new person. No resume, no confirmed facts, no list shown, no offer, no draft, no alerts, no applications, no contacts.`;
export const PRODUCT = `THE PRODUCT you are acting as: a career agent the person texts on Telegram (also WhatsApp; iMessage is waitlisted). It finds roles from the board, tailors resumes from confirmed facts only, prepares applications (cloud browser; no extension needed), drafts emails and networking outreach, makes interview prep, tracks applications, runs job alerts and a weekly digest, and can make a private File page (a link) for documents. Rules: nothing is submitted, sent or messaged without the person's approval of that exact item; a change after approval needs a new approval; the person signs in to portals and enters codes themselves, no password or code through chat; no CAPTCHA solving; never invent facts about the person or employers; say plainly what did not happen. In THIS turn you can only reply with text: you cannot browse, send, apply or contact anyone. If a File is asked for, write its content in the reply under a line "FILE:".`;

// ------------------------------------------------------------------------------------------------ the CLI
export async function sha(s: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join(""); }
export function jsonOf(text: string): any {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error(`no JSON object in the model output: ${text.slice(0, 120)}`);
  return JSON.parse(text.slice(a, b + 1));
}
async function cli(model: string, prompt: string, extra: string[] = []): Promise<{ ok: boolean; text: string; raw: string }> {
  const scratch = Deno.env.get("BVI_CLI_CWD") ?? Deno.makeTempDirSync({ prefix: "bvi-cli-" });
  const a = extra.length ? ["-p", "--model", model, ...extra, "--tools", "", "--strict-mcp-config"] : CLI_ARGS(model);
  const p = new Deno.Command("claude", { args: a, stdin: "piped", stdout: "piped", stderr: "piped", env: cliEnv(Deno.env.toObject()), clearEnv: true, cwd: scratch }).spawn();
  const w = p.stdin.getWriter(); await w.write(new TextEncoder().encode(prompt)); await w.close();
  const o = await p.output();
  const raw = new TextDecoder().decode(o.stdout);
  if (extra.length) return { ok: o.code === 0, text: raw, raw };
  try {
    const j = JSON.parse(raw);
    return { ok: o.code === 0 && !j.is_error, text: String(j.result ?? ""), raw: raw.slice(0, 400) };
  } catch { return { ok: false, text: "", raw: (raw + new TextDecoder().decode(o.stderr)).slice(0, 400) }; }
}
export async function verifySubscription(): Promise<string> {
  const r = await cli("haiku", "Reply with the single word OK.", ["--output-format", "stream-json", "--verbose"]);
  for (const line of r.text.split("\n")) {
    try { const j = JSON.parse(line); if (j.type === "system" && j.subtype === "init") return String(j.apiKeySource); } catch { /* not JSON */ }
  }
  return "unknown";
}

// ------------------------------------------------------------------------------------------------ prompts
type RefItem = { id: string; key: string; caseId: string; state: string; prompt: string };
export function refItemPrompt(cs: Case, state: string, history: { user: string; assistant: string }[]): string {
  const hist = history.length ? `\nEARLIER IN THIS THREAD (your own replies):\n${history.map((h) => `PERSON: ${h.user}\nYOU: ${h.assistant}`).join("\n")}\n` : "";
  return `STATE: ${state}${hist}\nTHE PERSON NOW TEXTS: ${cs.input}`;
}
export const REF_HEADER = (ctx: string) => `You are writing reference replies for a benchmark of a career-agent product. For each item below, write the reply the best possible career agent would text back, as that product, to that exact message, using only the context given. Be accurate and honest: no invented facts, no invented postings (use the board's postings and URLs when roles are asked for), and say plainly when something does not exist yet. Keep it as brief as the ask allows.

${PRODUCT}

THE BOARD (the postings the product can read):
${board()}

${ctx}

Return ONLY JSON: {"replies":[{"id":"<item id>","reply":"<the reply text>"}]} with one entry per item, in order.`;

type JudgeItem = { id: string; key: string; rec: Rec; ref: string; traineeFirst: boolean };
// The judge sees the same product rules and board as the reference writer, and each item's full account context, so a
// posting from the board is not mistaken for an invented one.
export const JUDGE_HEADER = `You are judging two replies from a career agent texting a person. For each item, compare Reply A and Reply B on each dimension and say which is better: "A", "B" or "tie". Judge only what is in the replies; a reply that invents facts, ignores a "do not" in the message, or answers a different question loses on that dimension. Postings from THE BOARD below are real and may be cited with their URLs; facts in an item's CONTEXT are on record. Then give an overall winner.

${PRODUCT.replace("If a File is asked for, write its content in the reply under a line \"FILE:\".", "A File may be given as a link or as its content inline.")}

THE BOARD:
${board()}

DIMENSIONS:
${DIMENSIONS.map(([k, d]) => `- ${k}: ${d}`).join("\n")}
Return ONLY JSON: {"verdicts":[{"id":"<item id>","ask":"A|B|tie","delivered":"A|B|tie","correct":"A|B|tie","texting":"A|B|tie","next":"A|B|tie","overall":"A|B|tie","why":"<one short sentence>"}]}`;
export function judgeItemText(it: JudgeItem, ctx: string): string {
  const a = it.traineeFirst ? it.rec.reply : it.ref, b = it.traineeFirst ? it.ref : it.rec.reply;
  return `ITEM ${it.id}\nCONTEXT: ${ctx}\nTHE PERSON TEXTED: ${it.rec.input}\nREPLY A:\n${a}\nREPLY B:\n${b}`;
}
// Convert a verdict from A/B to Trainee-relative win/tie/loss.
export function relative(v: string | undefined, traineeFirst: boolean): "win" | "tie" | "loss" | "missing" {
  if (v === "tie") return "tie";
  if (v !== "A" && v !== "B") return "missing";
  return (v === "A") === traineeFirst ? "win" : "loss";
}

// ------------------------------------------------------------------------------------------------ main
if (import.meta.main) {
  const RESULTS = arg("--results");
  if (!RESULTS) { console.error("--results <results/<label>.json> is required (run run.ts first)"); Deno.exit(2); }
  const MAX = num("--max-calls", 60), BATCH = num("--batch", 8), JBATCH = num("--judge-batch", 6), CONC = num("--concurrency", 3);
  const JMODEL = arg("--judge-model") ?? "haiku";
  const DRY = args.includes("--dry"), REFS_ONLY = args.includes("--refs-only");
  const SPEC = JSON.parse(await Deno.readTextFile(`${HERE}cases.json`));
  const CASES: Case[] = SPEC.cases;
  const byId = new Map(CASES.map((c) => [c.id, c]));
  const { summary, records } = JSON.parse(await Deno.readTextFile(RESULTS)) as { summary: any; records: Rec[] };
  const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
  const ctxOf = (state: string) => state === "seeded" ? SEEDED(RESUME) : EMPTY;
  const refPath = `${HERE}opus-refs.json`, pairPath = `${HERE}pairwise-cache.json`;
  const load = async (p: string) => { try { return JSON.parse(await Deno.readTextFile(p)); } catch { return {}; } };
  const refs: Record<string, { case: string; state: string; reply: string; model: string; at: string }> = await load(refPath);
  const pairs: Record<string, any> = await load(pairPath);
  let calls = 0, stopped: string | null = null;
  const errors: string[] = [];

  const need = (n: number) => !DRY && !stopped && calls + n <= MAX;
  let verified = false;
  const guard = async () => {
    if (verified) return;
    try { await subscriptionGate(async () => { const src = await verifySubscription(); console.error(`subscription check: apiKeySource=${src}`); return src; }); }
    catch (e) { console.error((e as Error).message); Deno.exit(3); }
    verified = true;
  };
  async function pool<T>(items: T[], fn: (t: T) => Promise<void>) {
    const q = [...items];
    await Promise.all(Array.from({ length: Math.max(1, CONC) }, async () => { while (q.length) await fn(q.shift()!); }));
  }

  // References, level by level: a case whose thread starts with earlier cases (cases.json "after") is asked once those
  // earlier references exist, with them as its history.
  const states: string[] = summary.states;
  const want = new Set(records.map((r) => `${r.case}|${r.state}`));
  const refKeyOf = new Map<string, string>();
  for (let level = 0; level < 4; level++) {
    const items: RefItem[] = [];
    for (const state of states) for (const cs of CASES) {
      if (!want.has(`${cs.id}|${state}`) || refKeyOf.has(`${cs.id}|${state}`)) continue;
      const hist: { user: string; assistant: string }[] = [];
      let ready = true;
      for (const a of cs.after ?? []) { const k = refKeyOf.get(`${a}|${state}`); if (!k || !refs[k]) { ready = false; break; } hist.push({ user: byId.get(a)!.input, assistant: refs[k].reply }); }
      if (!ready) continue;
      const prompt = refItemPrompt(cs, state, hist);
      const key = await sha(`${REF_MODEL}\n${REF_HEADER(ctxOf(state))}\n${prompt}`);
      if (refs[key]) { refKeyOf.set(`${cs.id}|${state}`, key); continue; }
      items.push({ id: `${cs.id}/${state}`, key, caseId: cs.id, state, prompt });
    }
    if (!items.length) continue;
    const batches: RefItem[][] = [];
    for (const state of states) { const s = items.filter((i) => i.state === state); for (let i = 0; i < s.length; i += BATCH) batches.push(s.slice(i, i + BATCH)); }
    await pool(batches, async (b) => {
      if (!need(1)) { if (!stopped && !DRY) stopped = `call cap ${MAX} reached`; return; }
      await guard();
      calls++;
      const prompt = `${REF_HEADER(ctxOf(b[0].state))}\n\nITEMS:\n${b.map((i) => `ITEM ${i.id}\n${i.prompt}`).join("\n\n")}`;
      const r = await cli(REF_MODEL, prompt);
      if (!r.ok) { errors.push(`refs ${b.map((i) => i.id).join(",")}: ${r.raw}`); if (/rate|limit|usage|overloaded|429/i.test(r.raw)) stopped = `rate limited: ${r.raw.slice(0, 160)}`; return; }
      try {
        const got = jsonOf(r.text).replies ?? [];
        for (const it of b) {
          const g = got.find((x: any) => x.id === it.id);
          if (g?.reply) { refs[it.key] = { case: it.caseId, state: it.state, reply: String(g.reply), model: "claude-opus-5-5 (claude CLI, subscription)", at: new Date().toISOString() }; refKeyOf.set(`${it.caseId}|${it.state}`, it.key); }
          else errors.push(`refs ${it.id}: missing in the batch output`);
        }
      } catch (e) { errors.push(`refs ${b.map((i) => i.id).join(",")}: ${(e as Error).message}`); }
      await Deno.writeTextFile(refPath, JSON.stringify(refs, null, 1) + "\n");
    });
  }

  // Pairwise judgements.
  type Row = { case: string; state: string; feature: string; layer: string; status: string; dims?: Record<string, string>; overall?: string; why?: string };
  const rows: Row[] = [];
  const jitems: JudgeItem[] = [];
  for (const r of records) {
    const feature = byId.get(r.case)?.feature ?? "?";
    const k = refKeyOf.get(`${r.case}|${r.state}`);
    if (r.layer === "staged_brain") { rows.push({ case: r.case, state: r.state, feature, layer: r.layer, status: "not comparable (scripted brain)" }); continue; }
    if (!k || !refs[k]) { rows.push({ case: r.case, state: r.state, feature, layer: r.layer, status: "no reference (partial run)" }); continue; }
    const key = await sha(`${JMODEL}\n${JUDGE_HEADER}\n${r.case}|${r.state}\n${r.input}\n${r.reply}\n${refs[k].reply}`);
    const traineeFirst = parseInt(key.slice(0, 2), 16) % 2 === 0; // position fixed per item, balanced across items
    jitems.push({ id: `${r.case}/${r.state}`, key, rec: r, ref: refs[k].reply, traineeFirst });
  }
  if (!REFS_ONLY) {
    const todo = jitems.filter((j) => !pairs[j.key]);
    const batches: JudgeItem[][] = [];
    for (let i = 0; i < todo.length; i += JBATCH) batches.push(todo.slice(i, i + JBATCH));
    await pool(batches, async (b) => {
      if (!need(1)) { if (!stopped && !DRY) stopped = `call cap ${MAX} reached`; return; }
      await guard();
      calls++;
      const prompt = `${JUDGE_HEADER}\n\n${b.map((j) => judgeItemText(j, `${j.rec.state === "seeded" ? SEEDED(RESUME) : EMPTY}${(byId.get(j.rec.case)?.after ?? []).length ? `\nEarlier in this thread the person texted: ${(byId.get(j.rec.case)!.after ?? []).map((a) => `"${byId.get(a)!.input}"`).join(", ")}` : ""}`)).join("\n\n")}`;
      const r = await cli(JMODEL, prompt);
      if (!r.ok) { errors.push(`judge ${b.map((j) => j.id).join(",")}: ${r.raw}`); if (/rate|limit|usage|overloaded|429/i.test(r.raw)) stopped = `rate limited: ${r.raw.slice(0, 160)}`; return; }
      try {
        const got = jsonOf(r.text).verdicts ?? [];
        for (const j of b) { const g = got.find((x: any) => x.id === j.id); if (g) pairs[j.key] = { ...g, traineeFirst: j.traineeFirst, model: JMODEL }; else errors.push(`judge ${j.id}: missing in the batch output`); }
      } catch (e) { errors.push(`judge ${b.map((j) => j.id).join(",")}: ${(e as Error).message}`); }
      await Deno.writeTextFile(pairPath, JSON.stringify(pairs, null, 1) + "\n");
    });
  }
  for (const j of jitems) {
    const v = pairs[j.key];
    const feature = byId.get(j.rec.case)?.feature ?? "?";
    if (!v) { rows.push({ case: j.rec.case, state: j.rec.state, feature, layer: j.rec.layer, status: REFS_ONLY ? "not judged (--refs-only)" : "not judged (partial run)" }); continue; }
    const dims: Record<string, string> = {};
    for (const [d] of DIMENSIONS) dims[d] = relative(v[d], j.traineeFirst);
    rows.push({ case: j.rec.case, state: j.rec.state, feature, layer: j.rec.layer, status: "judged", dims, overall: relative(v.overall, j.traineeFirst), why: v.why });
  }

  // Report.
  const tallyOf = (rs: Row[]) => { const t = { win: 0, tie: 0, loss: 0, judged: 0 }; for (const r of rs) if (r.status === "judged") { t.judged++; (t as any)[r.overall!] = ((t as any)[r.overall!] ?? 0) + 1; } return t; };
  const label = String(summary.label);
  const outBase = RESULTS.replace(/\.json$/, "");
  const refCount = [...want].filter((w) => { const k = refKeyOf.get(w); return k && refs[k]; }).length;
  const partial = stopped !== null || refCount < want.size || rows.some((r) => /partial/.test(r.status));
  const report = { label, sha: summary.sha, at: new Date().toISOString(), ref_model: "claude-opus-5-5 via claude CLI (subscription)", judge_model: `${JMODEL} via claude CLI (subscription)`, calls_this_run: calls, call_cap: MAX, stopped, partial, errors,
    references: { have: refCount, of: want.size }, overall: Object.fromEntries(states.map((s) => [s, tallyOf(rows.filter((r) => r.state === s))])),
    dims: Object.fromEntries(DIMENSIONS.map(([d]) => [d, Object.fromEntries(["win", "tie", "loss"].map((x) => [x, rows.filter((r) => r.dims?.[d] === x).length]))])),
    not_comparable: rows.filter((r) => r.status.startsWith("not comparable")).length, rows };
  await Deno.writeTextFile(`${outBase}.opus.json`, JSON.stringify(report, null, 1) + "\n");
  const md: string[] = [`# Trainee vs Opus 5.5 reference: ${label}`, "", `SHA \`${summary.sha}\` · references ${refCount}/${want.size} · judge ${JMODEL} (claude CLI, subscription) · ${calls} CLI calls this run (cap ${MAX})${partial ? " · **PARTIAL**" : ""}${stopped ? ` · stopped: ${stopped}` : ""}`, "",
    "> Quality metric. Win = Trainee's reply judged better than the Opus 5.5 reference overall; loss = worse. Only turns answered by code (router or code-first) are compared: a staged-brain turn carries the benchmark's scripted text, so it is \"not comparable\" here.", "",
    "## Overall", "", "| state | judged | win | tie | loss | not comparable (scripted brain) |", "|---|---|---|---|---|---|"];
  for (const s of states) { const t = tallyOf(rows.filter((r) => r.state === s)); md.push(`| ${s} | ${t.judged} | ${t.win} | ${t.tie} | ${t.loss} | ${rows.filter((r) => r.state === s && r.status.startsWith("not comparable")).length} |`); }
  md.push("", "## By dimension (all judged records)", "", "| dimension | win | tie | loss |", "|---|---|---|---|");
  for (const [d, desc] of DIMENSIONS) md.push(`| ${d}: ${desc} | ${report.dims[d].win} | ${report.dims[d].tie} | ${report.dims[d].loss} |`);
  md.push("", "## By feature", "", "| feature | win | tie | loss | not comparable |", "|---|---|---|---|---|");
  for (const f of Object.keys(SPEC.features)) { const rs = rows.filter((r) => r.feature === f); if (!rs.length) continue; const t = tallyOf(rs); md.push(`| ${f} ${SPEC.features[f]} | ${t.win} | ${t.tie} | ${t.loss} | ${rs.filter((r) => r.status.startsWith("not comparable")).length} |`); }
  md.push("", "## Records", "", "| case | state | layer | overall | ask | delivered | correct | texting | next | why |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows.sort((a, b) => a.case.localeCompare(b.case, undefined, { numeric: true }) || a.state.localeCompare(b.state))) md.push(`| ${r.case} | ${r.state} | ${r.layer} | ${r.overall ?? r.status} | ${DIMENSIONS.map(([d]) => r.dims?.[d] ?? "-").join(" | ")} | ${(r.why ?? "").replaceAll("|", "/").slice(0, 160)} |`);
  if (errors.length) md.push("", "## Errors (recorded, not retried)", "", ...errors.map((e) => `- ${e.replaceAll("\n", " ").slice(0, 240)}`));
  await Deno.writeTextFile(`${outBase}.opus.md`, md.join("\n") + "\n");
  console.log(`wrote ${outBase}.opus.json and .md: refs ${refCount}/${want.size}; ${states.map((s) => { const t = report.overall[s]; return `${s} ${t.win}W/${t.tie}T/${t.loss}L of ${t.judged}`; }).join("; ")}; ${calls} calls${partial ? "; PARTIAL" : ""}${stopped ? ` (${stopped})` : ""}`);
}
