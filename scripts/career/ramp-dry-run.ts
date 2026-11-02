// The architect's dry run on a real Ashby posting before the owner's live run (first: Ramp, Software Engineering Intern,
// Frontend, https://jobs.ashbyhq.com/ramp/a13ae586-f4cb-4385-8822-c42b9b54ed74). It drives the production engine
// (scripts/apply.ts, the same dry run the preparation sandbox runs, through approve-first.ts prepare) in a headless
// browser: it reads the live form, fills every field it has a confirmed answer for, reads every field back, stops at the
// final review and NEVER submits. Missing answers are asked the way the product asks them (ask-once.ts questionsToStore,
// one row per question) and answered from the persona file, or listed as what Trainee would ask the owner.
//
//   deno run -A scripts/career/ramp-dry-run.ts --persona <file OUTSIDE the repo> --out <new folder> [--url <posting>]
//
// Persona file (tests/fixtures/ramp/persona-test.json is the synthetic shape): { "user_id": "<his Trainee user id>",
// "file": { "name": "...pdf", "b64": "<resume bytes>" } or "file_path": "<resume.pdf>", "answers": [{ "match": "<regex on
// the question>", "value": "<his exact answer>" }] }. Writes to --out: field-map.json (every field the page showed, the
// planned answer per field with its source, the destination the Submit would be bound to, the hashes), card.txt (the card
// lines exactly as the person would read them), questions.json (each question Trainee asked and whether the persona
// answered it), before-review.png (the filled form at the final review) and evidence.json (the engine's own record).
// No --submit exists here: the engine is never given one, and the run refuses any argument naming it.
import { prepare, type RunEngine } from "../../workers/career-browser/approve-first.ts";
import { engineFacts } from "../../workers/career-browser/approve-first.ts";
import { questionsToStore, type TextAnswer } from "../../workers/career-browser/ask-once.ts";
import { scriptSubmitFamily } from "../apply.ts";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { hostAllowed } = require("../../packages/domain/150-career-portal-browser.js");
export const RAMP_POSTING = "https://jobs.ashbyhq.com/ramp/a13ae586-f4cb-4385-8822-c42b9b54ed74";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

export type Persona = { user_id?: string; company?: string; answers: { match: string; value: string }[] };
export type DryRun = {
  status: "ready" | "needs_answers" | "stopped";
  reason?: string;
  rounds: number;
  questions: { key: string; label: string; type: string; answered: boolean }[];
  card?: string[];
  payload?: any;
  evidence?: any;
  evidenceDir?: string;
};

// The engine as the preparation runs it, but the evidence folder is ours (for the screenshot) and a submit can never be
// asked for. `extra`: the stand-in's --script-submit on a local page; for a real Ashby page the same flag names its family.
export function dryEngine(o: { root?: string; extra?: string[]; evidenceRoot: string; env?: Record<string, string> }): RunEngine & { dirs: string[] } {
  const dirs: string[] = [];
  const run = (async (args: string[]) => {
    if ([...args, ...(o.extra ?? [])].some((a) => /submit$|^--approved$|cloud-authorize/.test(a) && a !== "--script-submit")) {
      throw Error("DRY_RUN_ONLY: this runner never submits");
    }
    const dir = `${o.evidenceRoot}/round-${dirs.length + 1}`;
    dirs.push(dir);
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", `${o.root ?? ROOT}/scripts/apply.ts`, ...args, ...(o.extra ?? []), "--evidence-dir", dir],
      stdin: "null", stdout: "piped", stderr: "piped", ...(o.env ? { env: o.env } : {}),
    }).spawn();
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.status]);
    const line = out.split("\n").filter((l) => l.startsWith("RESULT ")).at(-1);
    if (!line) {
      const msg = (err.trim().split("\n").at(-1) || "no result").slice(0, 300);
      return { result: { state: "not_submitted", reason: /^error: Uncaught \(in promise\) Error: (\S+)/.exec(msg)?.[1] ?? msg }, evidence: null };
    }
    let evidence = null;
    try { evidence = JSON.parse(await Deno.readTextFile(`${dir}/evidence.json`)); } catch { /* refused before evidence */ }
    return { result: JSON.parse(line.slice(7)), evidence };
  }) as RunEngine & { dirs: string[] };
  run.dirs = dirs;
  return run;
}

// Prepare, ask what is missing, answer from the persona, prepare again: at most `rounds` times. Never submits.
export async function dryRunLoop(o: { url: string; userId: string; company: string; persona: Persona; resumePath: string; work: string;
  runEngine: RunEngine; rounds?: number; now?: number }): Promise<DryRun> {
  const rows: TextAnswer[] = [], asked = new Map<string, DryRun["questions"][number]>();
  let n = 0;
  for (; n < (o.rounds ?? 4); n++) {
    const factsPath = `${o.work}/facts-${n + 1}.json`;
    const file = { user_id: o.userId, answers: {}, saved: {}, posting: { company: o.company } };
    await Deno.writeTextFile(factsPath, JSON.stringify(engineFacts(file, rows)), { mode: 0o600 });
    const r = await prepare({ url: o.url, factsPath, resumePath: o.resumePath, account: { epoch: 0, version: 0 }, now: o.now ?? Date.now(), runEngine: o.runEngine });
    if (r.ready) return { status: "ready", rounds: n + 1, questions: [...asked.values()], card: r.card, payload: r.payload };
    const result: any = r.result;
    if (result.reason !== "needs_answers") return { status: "stopped", reason: String(result.reason ?? result.state), rounds: n + 1, questions: [...asked.values()] };
    const ask = questionsToStore({ ...result, company: o.company }, { facts: {}, answered: new Set(rows.map((x) => x.key)) });
    let added = 0;
    for (const q of ask.questions as any[]) {
      const hit = o.persona.answers.find((a) => new RegExp(a.match, "i").test(String(q.label)));
      const seen = asked.get(q.key);
      asked.set(q.key, { key: q.key, label: String(q.label), type: String(q.type), answered: !!hit });
      if (hit && !seen && !rows.some((x) => x.key === q.key)) {
        rows.push({ id: String(rows.length + 1), key: q.key, kind: String(q.kind), answer: hit.value });
        added++;
      }
    }
    if (!added) return { status: "needs_answers", rounds: n + 1, questions: [...asked.values()] };
  }
  return { status: "needs_answers", rounds: n, questions: [...asked.values()] };
}

function arg(args: string[], k: string) {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
}

if (import.meta.main) {
  const args = Deno.args;
  if (args.some((a) => /submit|approved/i.test(a))) {
    console.error("DRY_RUN_ONLY: ramp-dry-run never submits; the owner approves the card in Telegram.");
    Deno.exit(2);
  }
  const personaPath = arg(args, "--persona"), out = arg(args, "--out"), url = arg(args, "--url") ?? RAMP_POSTING;
  if (!personaPath || !out) {
    console.error("usage: deno run -A scripts/career/ramp-dry-run.ts --persona <file outside the repo> --out <new folder> [--url <posting>]");
    Deno.exit(2);
  }
  const abs = await Deno.realPath(personaPath);
  if (abs.startsWith(ROOT + "/") && !abs.startsWith(ROOT + "/tests/fixtures/")) {
    console.error("PERSONA_INSIDE_REPO: keep the owner's persona outside the repository");
    Deno.exit(2);
  }
  const persona = JSON.parse(await Deno.readTextFile(abs));
  const g = hostAllowed(url);
  const family = g.atsFamily;
  const local = g.kind === "local_test";
  if (!local && family !== "ashby") {
    console.error(`NOT_ASHBY: ${url} is ${family ?? "no known portal"}`);
    Deno.exit(2);
  }
  // A real Ashby form has no <form> post: the dry run binds where its scripted Submit would go (it never presses it), exactly
  // as a host with UPMORE_SCRIPT_SUBMIT_LIVE=1 does.
  const bound = scriptSubmitFamily({ local, flag: "ashby", live: false, family: local ? "ashby" : family, personSubmits: false });
  if (bound !== "ashby") { console.error("SCRIPT_SUBMIT_UNBOUND"); Deno.exit(2); }
  await Deno.mkdir(out, { recursive: true, mode: 0o700 });
  if ([...Deno.readDirSync(out)].length) { console.error("OUT_NOT_EMPTY"); Deno.exit(2); }
  const work = await Deno.makeTempDir({ prefix: "ramp-dry-" });
  const resumePath = `${work}/${String(persona.file?.name ?? "resume.pdf").replace(/[\/\\]/g, "_")}`;
  if (persona.file_path) await Deno.copyFile(persona.file_path, resumePath);
  else if (persona.file?.b64) await Deno.writeFile(resumePath, Uint8Array.from(atob(persona.file.b64), (c) => c.charCodeAt(0)));
  else await Deno.writeTextFile(resumePath, String(persona.file?.text ?? ""));
  const engine = dryEngine({ extra: ["--script-submit", "ashby", "--state-dir", `${work}/state`].slice(0, local ? 4 : 2), evidenceRoot: `${work}/evidence` });
  const userId = String(persona.user_id ?? (local ? "TEST-dry-run" : ""));
  if (!userId) { console.error("PERSONA_USER_ID_REQUIRED: his Trainee user id (a TEST id runs only on a local page)"); Deno.exit(2); }
  const r = await dryRunLoop({ url, userId, company: String(persona.company ?? "Ramp"), persona, resumePath, work, runEngine: engine });
  const last = engine.dirs.at(-1);
  let ev: any = null;
  try { ev = JSON.parse(await Deno.readTextFile(`${last}/evidence.json`)); } catch { /* none */ }
  await Deno.writeTextFile(`${out}/questions.json`, JSON.stringify(r.questions, null, 2) + "\n", { mode: 0o600 });
  if (ev) await Deno.writeTextFile(`${out}/evidence.json`, JSON.stringify(ev, null, 2) + "\n", { mode: 0o600 });
  try { await Deno.copyFile(`${last}/before-review.png`, `${out}/before-review.png`); } catch { /* the run stopped before the review */ }
  if (r.status === "ready") {
    await Deno.writeTextFile(`${out}/card.txt`, r.card!.join("\n") + "\n", { mode: 0o600 });
    await Deno.writeTextFile(`${out}/field-map.json`, JSON.stringify({
      url, posting: r.payload.job_id, destination: r.payload.destination, resume_sha256: r.payload.resume_sha256,
      engine_approval: r.payload.engine_approval, schema: ev?.schema ?? null, readback: ev?.readback ?? null,
      fields: r.payload.fields.map((f: any) => ({ name: f.name, label: f.label, value: f.value, source: f.factId })),
      page_field_names: r.payload.page_field_names, verification: ev?.payload?.verification ?? [],
      left_empty: (ev?.schema ?? []).filter((s: any) => !r.payload.fields.some((f: any) => f.name === s.name)).map((s: any) => ({ name: s.name, label: s.label, required: s.required })),
    }, null, 2) + "\n", { mode: 0o600 });
  }
  await Deno.remove(work, { recursive: true }).catch(() => {});
  console.log(JSON.stringify({ status: r.status, reason: r.reason ?? null, rounds: r.rounds, asked: r.questions.length,
    unanswered: r.questions.filter((q) => !q.answered).map((q) => q.label), out, submitted: false }));
  Deno.exit(r.status === "ready" ? 0 : 1);
}
