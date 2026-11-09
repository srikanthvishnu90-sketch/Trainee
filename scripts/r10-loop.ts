// R10 INTERNAL LOOP (owner order 2026-11-09, "fix everything ... and internal loop test"; architect, WO-I). One command that says,
// for every row of docs/architect/specs/R10-COVERAGE.md, whether that criterion holds right now:
//   1. the coverage check (scripts/r10-coverage-check.ts): every spec id has a row;
//   2. the gate (bash scripts/gate.sh), unless --no-gate: rows that name `gate:<test>` pass only when the gate passed;
//   3. the R10 acceptance suite, conformance included: every r10-*.test.ts under tests/architect/pending/r10-app-layer/ and
//      tests/architect/, evidence to artifacts/r10-loop/<run>/; a row's `file::name prefix` checks must all have PASSed;
//   4. with --live --sha <deployed sha>, after a deploy: the live replay (scripts/launch/r10-live-replay.ts) against production,
//      which keeps its own $1 guard and FAILs on any model call that is not claude-sonnet-5-5; a row's `live:<turn>` steps must
//      all have PASSed. It uses only the secrets r10-live-replay.ts names (SUPABASE_PROJECT_REF, SUPABASE_ACCESS_TOKEN,
//      SUPABASE_DB_URL, TELEGRAM_BOT_TOKEN); run it only where those are set and the owner or architect means to.
// Then one line per row: PASS, FAIL (with why), BLOCKED (the row's named reason: not a failure), PENDING_LIVE (a live-only row,
// or a row's live step, without --live) or PENDING_REVIEW (R-3, until replies-verdict.md says PASS or FAIL). A GAP row is a FAIL:
// nothing checks it. R-6 (the integrated pre-release run) is PASS only on the trunk tip, with the gate, when every other row is
// PASS or BLOCKED. Every run writes replies.md (every reply it produced) for the R-3 review. Exit 0 only when every row is PASS
// or BLOCKED.
// The loop: run it, fix each FAIL, run it again.
//   deno run -A scripts/r10-loop.ts [--no-gate] [--live --sha <sha>] [--only <id,id>]
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const args = Deno.args;
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const LIVE = args.includes("--live"), NO_GATE = args.includes("--no-gate"), SHA = opt("--sha") ?? "";
const ONLY = (opt("--only") ?? "").split(",").filter(Boolean);
const RUN = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = `${ROOT}/artifacts/r10-loop/${RUN}`;
await Deno.mkdir(OUT, { recursive: true });
if (LIVE && !/^[0-9a-f]{7,40}$/.test(SHA)) { console.log("--live needs --sha <the deployed commit>"); Deno.exit(2); }

async function sh(label: string, cmd: string[], env: Record<string, string> = {}): Promise<number> {
  console.log(`== ${label}: ${cmd.join(" ")}`);
  const p = await new Deno.Command(cmd[0], { args: cmd.slice(1), cwd: ROOT, env, stdout: "piped", stderr: "piped" }).output();
  const log = `${OUT}/${label.replace(/\W+/g, "-")}.log`;
  await Deno.writeFile(log, new Uint8Array([...p.stdout, ...p.stderr]));
  console.log(`   exit ${p.code} (log: ${log})`);
  return p.code;
}

// 1. coverage
const coverage = await sh("coverage check", [Deno.execPath(), "run", "-A", "scripts/r10-coverage-check.ts"]);
// 2. gate
const gate: "PASS" | "FAIL" | "NOT_RUN" = NO_GATE ? "NOT_RUN" : (await sh("gate", ["bash", "scripts/gate.sh"])) === 0 ? "PASS" : "FAIL";
// 3. the R10 suite (conformance included)
const files: string[] = [];
for (const dir of ["tests/architect/pending/r10-app-layer", "tests/architect/r10-app-layer", "tests/architect"]) {
  try { for await (const e of Deno.readDir(`${ROOT}/${dir}`)) if (e.isFile && /^r10-.*\.test\.ts$/.test(e.name)) files.push(`${dir}/${e.name}`); } catch { /* not there */ }
}
const evidenceDir = `${OUT}/evidence`;
const suite = files.length ? await sh("R10 acceptance suite", [Deno.execPath(), "test", "-A", "--no-check", "--import-map=tests/flow/supabase-npm.json", ...files.sort()], { R10_EVIDENCE_DIR: evidenceDir }) : -1;
interface Rec { item: number; test: string; file: string; outcome: string; why?: string; reply?: string; scenario?: string }
const recs: Rec[] = await Deno.readTextFile(`${evidenceDir}/evidence.jsonl`).then((t) => t.split("\n").filter(Boolean).map((l) => JSON.parse(l)), () => []);
// 4. live
interface LiveCheck { item: number; turn: string; check: string; status: string; detail: string }
let live: { outcome: string; checks: LiveCheck[]; transcript?: { turn: string; text: string; reply: string }[] } | null = null;
if (LIVE) {
  const script = `${ROOT}/scripts/launch/r10-live-replay.ts`;
  const exists = await Deno.stat(script).then(() => true, () => false);
  if (exists) {
    await sh("live replay", [Deno.execPath(), "run", "-A", "--import-map=tests/flow/supabase-npm.json", "scripts/launch/r10-live-replay.ts", "--sha", SHA, "--out", `${OUT}/live`, "--cleanup-stale"]);
    live = await Deno.readTextFile(`${OUT}/live/r10-live-replay.json`).then((t) => JSON.parse(t), () => null);
  } else console.log("   the live replay script is not on this commit yet: every live step is FAIL");
}

// R-3: every reply this run produced, in one transcript for an independent writing-quality review (spec D, E.6 52, A.5). The review's
// verdict goes in replies-verdict.md in this run's directory (first line "VERDICT: PASS" or "VERDICT: FAIL"); --verdict <path> names
// one elsewhere. Without it the row is PENDING_REVIEW.
const replyLines: string[] = [`# R10 replies, loop run ${RUN}`, "", "In-process replies (fake model, $0), then live replies when --live ran. Review against spec D and the reply-quality criteria (A.5, E.6 52).", ""];
for (const r of recs.filter((x) => x.reply && x.item !== 0)) replyLines.push(`## ${r.file} :: ${r.test}${r.scenario ? ` [${r.scenario}]` : ""}`, "", "```", String(r.reply).trim(), "```", "");
for (const t of live?.transcript ?? []) replyLines.push(`## LIVE ${t.turn}: ${t.text.slice(0, 160)}`, "", "```", String(t.reply).trim(), "```", "");
await Deno.writeTextFile(`${OUT}/replies.md`, replyLines.join("\n"));
const verdictPath = opt("--verdict") ?? `${OUT}/replies-verdict.md`;
const reviewVerdict = await Deno.readTextFile(verdictPath).then((t) => (/^\s*VERDICT:\s*(PASS|FAIL)/i.exec(t)?.[1] ?? "").toUpperCase(), () => "");
// R-6: is this run the integrated one (the trunk tip, with the gate)?
const git = async (...a: string[]) => new TextDecoder().decode((await new Deno.Command("git", { args: a, cwd: ROOT, stdout: "piped", stderr: "null" }).output()).stdout).trim();
const head = await git("rev-parse", "HEAD"), trunkTip = await git("rev-parse", "origin/trunk").catch(() => "");
const onTrunk = !!head && head === trunkTip;

// Rows.
const matrix = await Deno.readTextFile(`${ROOT}/docs/architect/specs/R10-COVERAGE.md`);
const rows = matrix.split("\n").filter((l) => /^\| [A-Z]/.test(l) && !/^\| id \|/.test(l)).map((l) => l.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|")));
type Verdict = { v: "PASS" | "FAIL" | "NOT_RUN" | "PENDING_LIVE"; why: string };
function testRef(ref: string): Verdict {
  if (ref.startsWith("gate:")) return gate === "PASS" ? { v: "PASS", why: "" } : { v: gate === "FAIL" ? "FAIL" : "NOT_RUN", why: `gate ${gate} (${ref.slice(5)})` };
  const [file, prefix = ""] = ref.split("::");
  const hits = recs.filter((r) => r.file === file && r.item !== 0 && (r.test.startsWith(prefix) || r.test.startsWith(`[post-reset baseline] ${prefix}`)));
  if (!hits.length) return { v: "NOT_RUN", why: `no evidence for ${ref}${files.some((f) => f.endsWith(file)) ? "" : " (file not on this commit)"}` };
  const bad = hits.filter((r) => r.outcome !== "PASS");
  return bad.length ? { v: "FAIL", why: `${ref}: ${bad[0].outcome} ${(bad[0].why ?? "").slice(0, 160)}` } : { v: "PASS", why: "" };
}
function liveRef(ref: string): Verdict {
  if (!LIVE) return { v: "PENDING_LIVE", why: `${ref} (run with --live after deploy)` };
  if (!live) return { v: "FAIL", why: `${ref}: no live report` };
  const turn = ref.slice(5);
  const hits = turn === "all" ? live.checks : live.checks.filter((c) => c.turn === turn);
  if (!hits.length) return { v: "FAIL", why: `${ref}: the live replay ran no such step` };
  const bad = hits.filter((c) => c.status !== "PASS");
  return bad.length ? { v: "FAIL", why: `${ref}: ${bad[0].status} ${bad[0].check} ${bad[0].detail.slice(0, 120)}` } : { v: "PASS", why: "" };
}
const out: { id: string; verdict: string; why: string }[] = [];
for (const [id, crit, , tests, liveCol, status, note] of rows) {
  if (ONLY.length && !ONLY.includes(id)) continue;
  let verdict: string, why = "";
  if (status === "integrated") { out.push({ id, verdict: "R6", why: "" }); continue; }
  if (status === "review") {
    verdict = reviewVerdict === "PASS" ? "PASS" : reviewVerdict === "FAIL" ? "FAIL" : "PENDING_REVIEW";
    why = verdict === "PENDING_REVIEW" ? `transcript: ${OUT}/replies.md; no verdict at ${verdictPath}` : `review verdict ${verdictPath}`;
  } else if (status === "BLOCKED") { verdict = "BLOCKED"; why = note; }
  else if (status === "GAP") { verdict = "FAIL"; why = `GAP: ${note}`; }
  else {
    const vs = [...tests.split(";").map((s) => s.trim()).filter(Boolean).map(testRef), ...liveCol.split(";").map((s) => s.trim()).filter(Boolean).map(liveRef)];
    const first = (k: string) => vs.find((x) => x.v === k);
    if (status === "live-only" && !LIVE) { verdict = "PENDING_LIVE"; why = liveCol; }
    else if (first("FAIL")) { verdict = "FAIL"; why = first("FAIL")!.why; }
    else if (first("NOT_RUN")) { verdict = "FAIL"; why = first("NOT_RUN")!.why; }
    else if (first("PENDING_LIVE")) { verdict = tests ? "PASS" : "PENDING_LIVE"; why = tests ? `in-process PASS; ${first("PENDING_LIVE")!.why}` : first("PENDING_LIVE")!.why; }
    else { verdict = "PASS"; }
  }
  out.push({ id, verdict, why });
}
// R-6, decided after every other row: the integrated pre-release run is the trunk tip, with the gate, and nothing else open.
for (const o of out.filter((x) => x.verdict === "R6")) {
  const open = out.filter((x) => x.verdict !== "R6" && x.verdict !== "PASS" && x.verdict !== "BLOCKED").map((x) => x.id);
  if (!onTrunk) { o.verdict = "FAIL"; o.why = `not the integrated run: HEAD ${head.slice(0, 8)} is not the trunk tip ${trunkTip.slice(0, 8) || "(origin/trunk unknown)"}`; }
  else if (gate !== "PASS") { o.verdict = "FAIL"; o.why = `the integrated run needs the gate (gate ${gate})`; }
  else if (open.length) { o.verdict = "FAIL"; o.why = `${open.length} row(s) not PASS or BLOCKED: ${open.slice(0, 12).join(", ")}${open.length > 12 ? "…" : ""}`; }
  else { o.verdict = "PASS"; o.why = `integrated: trunk ${head.slice(0, 8)}, gate PASS, every row PASS or BLOCKED`; }
}
const crits = new Map(rows.map((r) => [r[0], r[1]]));
for (const o of out) console.log(`${o.verdict.padEnd(14)} ${o.id.padEnd(8)} ${(crits.get(o.id) ?? "").slice(0, 90)}${o.why ? `\n               ${o.why.slice(0, 220)}` : ""}`);
const count = (v: string) => out.filter((o) => o.verdict === v).length;
console.log(`\nR10 loop ${RUN}: ${out.length} rows: ${count("PASS")} PASS, ${count("FAIL")} FAIL, ${count("BLOCKED")} BLOCKED, ${count("PENDING_LIVE")} PENDING_LIVE, ${count("PENDING_REVIEW")} PENDING_REVIEW`);
console.log(`replies for the R-3 review: ${OUT}/replies.md`);
console.log(`coverage check exit ${coverage}; gate ${gate}; suite exit ${suite} (${files.length} files); live ${LIVE ? live?.outcome ?? "no report" : "not run"}; evidence ${OUT}`);
await Deno.writeTextFile(`${OUT}/loop.json`, JSON.stringify({ run: RUN, sha: SHA || null, gate, coverage, suite, live: live?.outcome ?? null, rows: out }, null, 2));
Deno.exit(coverage === 0 && out.every((o) => o.verdict === "PASS" || o.verdict === "BLOCKED") ? 0 : 1);
