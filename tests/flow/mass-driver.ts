// The person's own computer as a separate process, for tests/architect/mass-submit-pg.test.ts: approve-first.ts runLoop
// signed in as the person (their own queue over the test's throwaway Postgres, reached by its socket and port), the real
// engine (scripts/apply.ts) on the test's employer pages, and the durable journal. The test kills this process mid-batch
// (SIGKILL) and starts the loop again from the same journal. Every engine start is printed as "START <url>" before it
// runs ("START <ms> <url>", then "END <ms> <url>"), and every outcome as "DONE <id> <state>".
//   MASS_PG="<socket dir>:<port>:<pgbin>" MASS_PERSON=<uuid> MASS_JOURNAL=<dir> MASS_PACING=<json> MASS_RESUME=<pdf>
//   MASS_ROOT=<repo> MASS_WORK=<dir>  deno run -A tests/flow/mass-driver.ts
import { attachPg } from "./pg.ts";
import { engineRunner, type Job, ownQueue, type RunEngine, runLoop } from "../../workers/career-browser/approve-first.ts";

const env = (k: string) => Deno.env.get(k) ?? "";
const [host, port, bin] = env("MASS_PG").split(":");
const pg = attachPg(host, Number(port), bin);
const work = env("MASS_WORK"), root = env("MASS_ROOT");
const resume = env("MASS_RESUME");
const bytes = await Deno.readFile(resume);
const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const engine = localEngine(root, work);
const mr = await import("../../workers/career-browser/mass-run.ts").catch(() => null);
const journal = mr ? mr.fileJournal<Job>(env("MASS_JOURNAL")) : undefined;
const own = ownQueue(pg.asPerson(env("MASS_PERSON")));
let sawEmpty = false;
const ran = await runLoop({
  queue: { ...own, claim: async (n?: number) => { const r = await (own.claim as any)(n ?? 1); if (!r.length) sawEmpty = true; return r; } } as typeof own,
  resume: { path: resume, sha256 },
  writeFacts: async (job: Job, facts: unknown) => {
    const f = `${work}/facts-${job.id}.json`;
    await Deno.writeTextFile(f, JSON.stringify(facts), { mode: 0o600 });
    return f;
  },
  runEngine: async (args: string[], e?: Record<string, string>, c?: any) => {
    const url = args[args.indexOf("--url") + 1];
    console.log(`START ${Date.now()} ${url}`);
    try { return await engine(args, e, c); } finally { console.log(`END ${Date.now()} ${url}`); }
  },
  // The scheduler drains on its own; the serial loop before it (the fail-first base) stops when the queue is empty.
  stop: () => (mr ? false : sawEmpty),
  sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
  idleMs: 50,
  log: (l: string) => console.log(`LOG ${l}`),
  drain: true,
  journal,
  pacing: JSON.parse(env("MASS_PACING")),
} as any);
for (const r of ran) console.log(`DONE ${r.id} ${r.state}`);
console.log("DRAINED");

// The engine for local test pages: each run its own state folder (the engine's own once-per-company record would
// otherwise hold back a second posting on one test host, which stands for one employer).
export function localEngine(root: string, work: string): RunEngine {
  return async (args, e, c) => {
    const dir = await Deno.makeTempDir({ dir: work, prefix: "engine-state-" });
    return await engineRunner({ root, extra: ["--state-dir", dir] })(args, e, c);
  };
}
