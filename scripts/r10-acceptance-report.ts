// R10 (owner order 2026-11-09), WO-I: the per-item acceptance report for the fifteen application-layer fixes
// (docs/architect/specs/APP-LAYER-15-FIXES.md E.10). It runs the R10 acceptance suite (tests/architect/pending/r10-app-layer/,
// and every r10 test that has already moved to tests/architect/), reads the evidence each check recorded, and prints, for each
// of the fifteen items, PASS or FAIL with the evidence: the test names, the files it opened, the screenshots it took, and an
// excerpt of the reply. It counts interactions honestly: the observed baseline is 2 scenarios and 5 user turns (spec A.1);
// every turn this suite sends is in-process with a $0 fake model, never a live interaction, and is reported as such.
//
// Item 15 ("prove fixes with end-to-end acceptance, then verify deployment") is PASS only when the in-process replay passes
// AND a post-deploy live replay report (scripts/launch/r10-live-replay.ts, --live <report.json>) says PASS. Without that report
// it is PENDING_LIVE, never PASS.
//
// Usage:
//   deno run -A scripts/r10-acceptance-report.ts                  run the suite, then report (needs Postgres 16; CI=true as root)
//   deno run -A scripts/r10-acceptance-report.ts --no-run         report from the evidence already in --evidence
//   options: --evidence <dir> (default artifacts/r10-acceptance)  --live <live-replay report.json>  --json <out.json>
//            --only <file substring> (run only matching test files)
// Exit: 0 when every item 1-15 is PASS; 1 when any is FAIL, NOT_RUN or PENDING_LIVE; 2 when the suite could not be found.
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ITEMS: Record<number, string> = {
  1: "Keep the requested target through the whole task",
  2: "Make corrections repair the current task",
  3: "Use supplied resume facts without inventing or repeatedly asking",
  4: "Deliver real, inspectable files and honest file claims",
  5: "Turn job searches into usable results",
  6: "Verify openings and separate fit from eligibility",
  7: "Handle limits without abandoning or misrepresenting work",
  8: "Make replies useful, direct and evidence-based",
  9: "Build a coherent visual system for every File family",
  10: "Fix entry/recovery layout and verify real sign-in",
  11: "Make account connections explicit and recoverable",
  12: "Make application review an exact, usable approval artifact",
  13: "Make application execution and proof match reality",
  14: "Make research and follow-up drafts concrete and sourced",
  15: "Prove fixes with end-to-end acceptance, then verify deployment",
};
const BASELINE = { scenarios: 2, turns: 5 };
// Acceptance criteria this suite (PR1: the harness and the two replays) does not check, said plainly so no reader takes them as
// covered. Spec E numbers.
const NOT_COVERED = [
  "E.4 37, 39-41 (destination kept after follow-ups, clarification is not payload approval, versions by human labels, no guessed address): not checked here; 36 and 38 are (r10-fix-04: 'Send this one.' and 'The PDF to me.')",
  "E.6 51 (no cap raised, no credits bought): not checked here; r10-fix-07 checks only that no model call is made at the limit",
  "Items 9-14 (File families, entry and sign-in, connections, application review, execution and proof, research and drafts): their tests come in the next PR",
];

const args = Deno.args;
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const evidenceDir = opt("--evidence") ?? `${ROOT}/artifacts/r10-acceptance`;
const livePath = opt("--live");
const jsonOut = opt("--json");
const only = opt("--only");

interface Rec { item: number; test: string; file: string; outcome: "PASS" | "FAIL" | "NOT_RUN"; why?: string; files?: string[]; screenshots?: string[]; reply?: string; turns?: number; model_calls?: number; scenario?: string; target?: string; brain?: string }
// The owner's post-reset audit (spec F) is a HISTORICAL BASELINE, reported apart from post-fix acceptance (architect, 2026-11-09).
const BASE_F = { scenarios: 3, turns: 10 };
const isBaseline = (r: Rec) => r.scenario === "post-reset";

// The suite's files: still pending, or already moved into tests/architect/ when their order landed.
async function suiteFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const dir of [`${ROOT}/tests/architect/pending/r10-app-layer`, `${ROOT}/tests/architect/r10-app-layer`, `${ROOT}/tests/architect`]) {
    try {
      for await (const e of Deno.readDir(dir)) if (e.isFile && /^r10-.*\.test\.ts$/.test(e.name)) out.push(`${dir}/${e.name}`);
    } catch { /* not there */ }
  }
  return out.filter((f) => !only || f.includes(only)).sort();
}

async function run(files: string[]): Promise<number> {
  // A run starts from an empty evidence directory, so it deletes the old one: only ever under this repository's artifacts/.
  const real = await Deno.realPath(evidenceDir).catch(() => new URL(evidenceDir, `file://${Deno.cwd()}/`).pathname);
  if (!real.startsWith(`${ROOT}/artifacts/`) || real.includes("/../")) { console.log(`refusing to delete --evidence ${evidenceDir}: a run clears its evidence directory, which must be under ${ROOT}/artifacts/ (use --no-run to only read one elsewhere)`); Deno.exit(2); }
  await Deno.remove(evidenceDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(evidenceDir, { recursive: true });
  console.log(`running ${files.length} R10 acceptance file(s); evidence -> ${evidenceDir}`);
  const p = new Deno.Command(Deno.execPath(), {
    args: ["test", "-A", "--no-check", `--import-map=${ROOT}/tests/flow/supabase-npm.json`, ...files],
    cwd: ROOT, env: { R10_EVIDENCE_DIR: evidenceDir }, stdout: "piped", stderr: "piped",
  });
  const r = await p.output();
  await Deno.writeFile(`${evidenceDir}/deno-test.log`, new Uint8Array([...r.stdout, ...r.stderr]));
  console.log(`deno test exited ${r.code} (full log: ${evidenceDir}/deno-test.log)`);
  return r.code;
}

async function readEvidence(): Promise<Rec[]> {
  try {
    return (await Deno.readTextFile(`${evidenceDir}/evidence.jsonl`)).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

interface Live { outcome: "PASS" | "FAIL"; sha?: string; at?: string; turns?: number; usd?: number; items?: Record<string, string>; report?: string }
async function readLive(): Promise<Live | null> {
  if (!livePath) return null;
  try { return JSON.parse(await Deno.readTextFile(livePath)); } catch (e) { console.log(`live report ${livePath} unreadable: ${(e as Error).message}`); return null; }
}

const clip = (s: string | undefined, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

if (import.meta.main) {
  const files = await suiteFiles();
  if (!files.length) { console.log("no R10 acceptance files found"); Deno.exit(2); }
  const testExit = args.includes("--no-run") ? null : await run(files);
  const all = await readEvidence();
  const recs = all.filter((r) => !isBaseline(r));
  const baseline = all.filter(isBaseline);
  const live = await readLive();
  const summary: Record<number, { status: string; checks: Rec[] }> = {};
  const lines: string[] = [];
  const say = (s = "") => { lines.push(s); console.log(s); };
  say("");
  say("R10 APPLICATION-LAYER ACCEPTANCE: fifteen items (spec E.10), PASS/FAIL with evidence");
  say("=".repeat(100));
  for (let item = 1; item <= 15; item++) {
    const checks = recs.filter((r) => r.item === item);
    const fails = checks.filter((r) => r.outcome === "FAIL"), passes = checks.filter((r) => r.outcome === "PASS");
    let status = !checks.length || (!passes.length && !fails.length) ? "NOT_RUN" : fails.length ? "FAIL" : "PASS";
    if (item === 15 && status === "PASS") status = live?.outcome === "PASS" ? "PASS" : live ? "FAIL" : "PENDING_LIVE";
    summary[item] = { status, checks };
    say(`\n[${status}] ${item}. ${ITEMS[item]}   (${passes.length} passed, ${fails.length} failed, ${checks.length - passes.length - fails.length} not run)`);
    for (const c of checks) {
      say(`  - ${c.outcome.padEnd(7)} ${c.test}   (${c.file}${c.brain && c.brain !== "stub" ? `; ${c.brain}` : ""})`);
      if (c.why) say(`      why: ${clip(c.why, 400)}`);
      for (const f of c.files ?? []) say(`      file opened: ${f}`);
      for (const s of c.screenshots ?? []) say(`      screenshot (390 px, dsf 2): ${s}`);
      if (c.target) say(`      target page (owner's design): ${c.target}`);
      if (c.reply) say(`      reply: "${clip(c.reply, 220)}"`);
    }
    if (item === 15) {
      say(live ? `  - live replay (post-deploy): ${live.outcome} at ${live.sha ?? "?"} ${live.at ?? ""}; ${live.turns ?? "?"} live turns; $${live.usd ?? "?"} (${livePath})` : "  - live replay (post-deploy): NOT RUN here. The architect dispatches .github/workflows/r10-live-replay.yml after deploy and passes its report with --live.");
      if (live?.items) for (const [k, v] of Object.entries(live.items)) say(`      live ${k}: ${v}`);
    }
  }
  say("\n" + "=".repeat(100));
  say(`HISTORICAL BASELINE, kept apart (spec F, owner's post-reset audit; with spec A: ${BASE_F.scenarios} scenarios, ${BASE_F.turns} user turns)`);
  if (!baseline.length) say("  (not run)");
  for (const c of baseline) {
    say(`  - ${c.outcome.padEnd(7)} [item ${c.item}] ${c.test}`);
    if (c.why) say(`      why: ${clip(c.why, 300)}`);
    if (c.reply) say(`      reply: "${clip(c.reply, 200)}"`);
  }
  say("\n" + "=".repeat(100));
  say("NOT COVERED by this suite (not to be read as passing):");
  for (const n of NOT_COVERED) say(`  - ${n}`);
  const meta = all.filter((r) => r.item === 0);
  const turns = meta.reduce((n, r) => n + (r.turns ?? 0), 0), calls = meta.reduce((n, r) => n + (r.model_calls ?? 0), 0);
  say("\n" + "=".repeat(100));
  say(`Interactions, counted honestly: the observed baseline is ${BASELINE.scenarios} scenarios and ${BASELINE.turns} user turns (spec A.1), and with the post-reset audit (spec F) ${BASE_F.scenarios} scenarios and ${BASE_F.turns} user turns; not a 1,000-example audit.`);
  say(`This run replayed those ${BASELINE.turns} turns once (r10-observed-replay) and sent ${turns} messages in all across ${meta.length} test file(s), setup included,`);
  say(`all in-process against a $0 fake model (${calls} fake model calls). None of them is a live interaction${live ? `; the live replay sent ${live.turns ?? "?"} turns to the deployed agent-chat` : ""}.`);
  const counts = Object.values(summary).reduce((m, s) => ({ ...m, [s.status]: (m[s.status] ?? 0) + 1 }), {} as Record<string, number>);
  say(`Items: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}${testExit === null ? "" : `; deno test exit ${testExit}`}`);
  await Deno.writeTextFile(`${evidenceDir}/report.txt`, lines.join("\n") + "\n").catch(() => {});
  // Visual conformance, side by side: each File family's 390 px screenshot beside the owner's target pages, with its gaps.
  const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const rel = (p: string) => p.startsWith("/") ? `file://${p}` : `file://${ROOT}/${p}`;
  const visual = recs.filter((r) => r.target);
  const html = `<!doctype html><meta charset="utf-8"><title>R10 visual conformance</title><style>body{font:14px system-ui;margin:16px}section{border-top:1px solid #ccc;padding:12px 0}.row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}img{width:300px;border:1px solid #ddd}.FAIL{color:#a00}.PASS{color:#070}</style>
<h1>R10 visual conformance: rendered File beside the owner's target page</h1>${visual.length ? "" : "<p>No family rendered yet (none registered or all failed before rendering).</p>"}
${visual.map((r) => `<section><h2 class="${r.outcome}">${r.outcome} ${esc(r.test)}</h2>${r.why ? `<p>${esc(r.why)}</p>` : ""}<div class="row">${(r.screenshots ?? []).map((s) => `<figure><img src="${esc(rel(s))}"><figcaption>rendered: ${esc(s)}</figcaption></figure>`).join("")}${String(r.target).split(" ").map((t) => `<figure><img src="${esc(rel(t))}"><figcaption>target: ${esc(t)}</figcaption></figure>`).join("")}</div></section>`).join("\n")}`;
  await Deno.writeTextFile(`${evidenceDir}/visual-conformance.html`, html).catch(() => {});
  say(`Visual conformance page (screenshot beside target): ${evidenceDir}/visual-conformance.html (${visual.length} famil${visual.length === 1 ? "y" : "ies"} checked, ${visual.filter((r) => (r.screenshots ?? []).length).length} rendered)`);
  if (jsonOut) await Deno.writeTextFile(jsonOut, JSON.stringify({ not_covered: NOT_COVERED, baseline: BASELINE, baseline_all: BASE_F, historical: baseline, turns, fake_model_calls: calls, live, items: Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, { title: ITEMS[Number(k)], status: v.status, checks: v.checks }])) }, null, 2));
  Deno.exit(Object.values(summary).every((s) => s.status === "PASS") ? 0 : 1);
}
