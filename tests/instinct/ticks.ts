// Instinct harness: the work that happens between a person's messages, run the way production runs it.
//   prepare    the host with the engine (workers/career-browser/prepare-ahead.ts prepareAhead: the engine's dry run in a real
//              Chromium against the employer's page), as `deno run -A workers/career-browser/prepare-ahead.ts` does, with
//              its own defaults, pass after pass until a pass changes nothing
//   drive      the person's computer (approve-first.ts runApproved over career_apply_claim_own as that person), claiming
//              until their queue is empty: the engine submits in a real Chromium, once per approved application
//   scheduled  the deployed career-proactive function (alerts, cards, questions, outreach sends and replies, ...) and
//              trainee-deliver, called with their secrets as pg_cron calls them
// The only seams are the ones every flow test has: the employers' public URLs are mapped to their 127.0.0.1 pages
// (urlFor), and the resume store is in memory (the files the engine uploads, byte for byte).
// deno-lint-ignore-file no-explicit-any
import { engineRunner, ownQueue, runApproved } from "../../workers/career-browser/approve-first.ts";
import { prepareAhead, storedProfile, tailoredResume } from "../../workers/career-browser/prepare-ahead.ts";
import { edgeRenderer, memoryResumeStore, type ResumeStore } from "../../supabase/functions/_shared/career_tailor.ts";
import { ROOT, SECRETS, type World } from "./world.ts";

export function workers(w: World) {
  const work = Deno.makeTempDirSync({ prefix: "instinct-work-" });
  const memory = memoryResumeStore();
  const resumes: ResumeStore = {
    put: async (path, pdf) => { await memory.put(path, pdf); await w.pg.sql(`insert into storage.objects (bucket_id, name) values ('career-resumes', ${w.q(path)}) on conflict (bucket_id, name) do nothing`); },
    signedUrl: (path, seconds) => memory.signedUrl(path, seconds),
    removeAll: (u) => memory.removeAll(u),
  };
  // The engine drives a real Chromium outside this process's network router, so it is fenced here: it runs only against
  // a loopback page. Any other URL is refused (recorded in world.unexpected, and the run returns no result), so no real
  // employer can ever be opened by a scenario.
  const engine = engineRunner({ root: ROOT, extra: ["--state-dir", `${work}/engine-state`] });
  const engineLog: { args: string[]; state: string | null; reason: string | null }[] = [];
  const runEngine: typeof engine = async (args, env, controls) => {
    const urls = args.filter((a) => /^https?:\/\//i.test(a));
    const outside = urls.filter((u) => { try { return !/^(127\.\d+\.\d+\.\d+|localhost)$/.test(new URL(u).hostname); } catch { return true; } });
    if (outside.length) {
      w.unexpected.push(...outside.map((u) => `ENGINE ${u}`));
      engineLog.push({ args, state: null, reason: `refused: not a loopback page (${outside[0]})` });
      return null;
    }
    const r = await engine(args, env, controls);
    engineLog.push({ args, state: r?.result?.state ?? null, reason: r?.result?.reason ?? null });
    return r;
  };
  const svc = w.pg.asService();
  const deps = {
    db: svc, runEngine, profileFor: storedProfile(svc),
    urlFor: (c: { job_id: string }) => w.site.pageFor(c.job_id) ?? "http://127.0.0.1:9/not-an-instinct-posting",
    resumeFor: tailoredResume({ render: edgeRenderer(), resumes }),
  };
  const engineRuns = { prepare: 0, drive: 0 };

  // Passes until one changes nothing (or `maxPasses`). Returns every outcome, in order.
  async function prepare(o: { maxPasses?: number; only?: { user_id: string; job_ids: string[] } } = {}) {
    const all: any[] = [];
    let last = "";
    for (let i = 0; i < (o.maxPasses ?? 40); i++) {
      const out = await prepareAhead(deps as any, o.only ? { only: o.only } : {});
      engineRuns.prepare += out.length;
      all.push(...out);
      const sig = JSON.stringify(out.map((x: any) => [x.user_id, x.job_id, x.outcome]).sort());
      if (!out.length || sig === last || !out.some((x: any) => x.outcome === "ready")) break;
      last = sig;
    }
    return all;
  }

  // The person's computer, online: it claims their approved applications and submits each, until none is left.
  // `engine`: another engine for this computer (the scale scenario's HTTP-only stand-in); default the real one.
  async function drive(userId: string, o: { maxRounds?: number; engine?: typeof runEngine; claimSize?: number } = {}) {
    const queue = ownQueue(w.pg.asPerson(userId));
    const done: any[] = [];
    for (let i = 0; i < (o.maxRounds ?? 200); i++) {
      let claimed = 0;
      const r = await runApproved({
        claim: async () => { const jobs = await queue.claim(o.claimSize ?? 1000); claimed = jobs.length; return jobs; },
        finish: (id, lease, state, evidence) => queue.finish(id, lease, state, evidence),
        resumeFor: async (job: any) => {
          const sha = String(job.payload?.resume_sha256 ?? "");
          const bytes = memory.files.get(`career-resumes/${userId}/${sha}.pdf`);
          if (!bytes) throw new Error(`no stored resume ${sha.slice(0, 12)} for this person`);
          const path = `${work}/resume-${sha.slice(0, 12)}.pdf`;
          await Deno.writeFile(path, bytes);
          return { path, sha256: sha };
        },
        writeFacts: async (job: any, facts: unknown) => { const p = `${work}/facts-${job.id}.json`; await Deno.writeTextFile(p, JSON.stringify(facts)); return p; },
        runEngine: o.engine ?? runEngine,
      } as any);
      if (!o.engine) engineRuns.drive += claimed;
      done.push(...(Array.isArray(r) ? r : []));
      if (!claimed) break;
    }
    return done;
  }

  // The scheduled run, as pg_cron calls it. The clock it runs at is the process clock (see clock.ts).
  async function scheduled() {
    const r = await w.call("career-proactive", { method: "POST", headers: { "x-trainee-proactive-secret": SECRETS.proactive, "content-type": "application/json" }, body: "{}" });
    const d = await w.call("trainee-deliver", { method: "POST", headers: { "x-trainee-deliver-secret": SECRETS.deliver, "content-type": "application/json" }, body: "{}" });
    return { proactive: r, deliver: d };
  }

  return { prepare, drive, scheduled, engineRuns, engineLog, memory, work };
}
export type Workers = ReturnType<typeof workers>;

// The process clock, moved forward for "a few days later" (follow-ups): Date.now and new Date() read it. The database's
// own now() is not moved; the product's code passes its time to the database where it matters (claims take p_now).
const RealDate = Date;
let offsetMs = 0;
export function advanceClock(ms: number) {
  offsetMs += ms;
  const Base = RealDate;
  // deno-lint-ignore no-explicit-any
  const Shifted: any = function (this: any, ...a: any[]) {
    if (!(this instanceof Shifted)) return new Base(Base.now() + offsetMs).toString();
    return a.length ? new (Base as any)(...a) : new Base(Base.now() + offsetMs);
  };
  Shifted.prototype = Base.prototype;
  Shifted.now = () => Base.now() + offsetMs;
  Shifted.UTC = Base.UTC;
  Shifted.parse = Base.parse;
  (globalThis as any).Date = Shifted;
}
export const clockOffsetMs = () => offsetMs;
