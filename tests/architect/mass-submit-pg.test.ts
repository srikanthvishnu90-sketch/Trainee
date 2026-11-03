// Mass submission (owner D-MS-2, 2026-10-27), end to end on a real Postgres 16 (the career schema, CI's migration order)
// and the real engine (scripts/apply.ts, headless Chromium) against employer pages on 127.0.0.1. Nothing reaches a real
// site. The person's own computer (approve-first.ts runLoop, signed in as them: career_apply_claim_own /
// career_apply_finish_own) runs in its own process (tests/flow/mass-driver.ts) with the durable journal.
//   setup   42 postings on 7 local hosts (ports): 40 on five ordinary employers (8 each, each posting its own company),
//           one whose Submit raises a verification check, one that turns into a sign-in wall after it was prepared.
//           Each prepared by the engine's dry run (approve-first prepare), stored (career_apply_prepare_own), shown on
//           cards of 8 (career_apply_card_open_own) and approved by the person's own tap (career_apply_card_answer_own).
//   run 1   the worker claims in batches and runs several at once across hosts, each host paced; it is killed (SIGKILL,
//           the whole process group: worker, engines, browsers) after MASS_KILL_AFTER engine starts.
//   run 2   the worker starts again from the same journal and drains the queue.
// Checked: every application ends in a recorded state; every engine started at most once per application; every
// employer page received at most one POST per posting, and exactly one for each one recorded as sent; an application
// running at the kill is recorded unknown_outcome and never driven again; the verification check and the sign-in wall
// end needs_user (never retried, nothing posted); at no moment more than hostMax engines on one host, nor more than
// `concurrency` in all, and within a run two starts on one host never closer than its spacing; more than one engine ran
// at once (the base ran one at a time).
// Fail-first: on the base (trunk bdd51e9) the worker claims one at a time and runs them in series, keeps no journal (the
// application running at the kill stays `driving` until the 15-minute sweep), and records a check as not_submitted.
// Run: bash tests/flow/run-real-flow.sh tests/architect/mass-submit-pg.test.ts
import { attachPg, pgBinDir, startPg } from "../flow/pg.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts"; // OWNER RULE 2026-10-26: the person has a confirmed resume
import { engineRunner, prepare } from "../../workers/career-browser/approve-first.ts";

const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const PERSON = "7b0f8f8e-6a43-4a49-9d2c-0000000a5501";
const SOURCE = { confirmed: true, provenance: "owner stated (TEST person, synthetic)", confirmation_event_id: "evt-mass-test" };
const PACING = { concurrency: 4, claimBatch: 25, hostMax: 2, hostSpacingMs: 1500, startBudgetMs: 240_000, botBackoffMax: 8 };
const KILL_AFTER = Number(Deno.env.get("MASS_KILL_AFTER") ?? 10);

function browserEnv(): boolean {
  if (Deno.env.get("UPMORE_PLAYWRIGHT_PATH")) return true;
  try { Deno.statSync(`${ROOT}/tools/node_modules/playwright`); Deno.env.set("UPMORE_PLAYWRIGHT_PATH", `${ROOT}/tools/node_modules/playwright`); return true; }
  catch { return false; }
}

// One employer host: a form per posting, each POST counted per posting. `kind` changes what its Submit meets.
function employer(kind: "plain" | "captcha" | "login") {
  const posts: Record<string, number> = {};
  let walled = false;
  const form = (p: string) =>
    `<!doctype html><title>TEST role</title><h1>TEST Analyst ${p}</h1><form method="post" action="/${p}/submit" enctype="multipart/form-data">` +
    `<label for="first">First name</label><input name="first_name" id="first" required>` +
    `<label for="last">Last name</label><input name="last_name" id="last" required>` +
    `<label for="email">Email</label><input name="email" id="email" type="email" required>` +
    `<label for="resume">Resume</label><input type="file" name="resume" id="resume" required>` +
    `<button type="submit"${kind === "captcha" ? ` onclick="event.preventDefault();document.body.insertAdjacentHTML('beforeend','<div id=&quot;challenge-form&quot; style=&quot;width:300px;height:80px&quot;>Please complete the check</div>')"` : ""}>Submit application</button></form>`;
  const login = `<!doctype html><title>Sign in</title><h1>Sign in to apply</h1><form method="post" action="/login"><label for="u">Email</label><input id="u" name="u">` +
    `<label for="pw">Password</label><input id="pw" type="password" name="pw"><button>Sign in</button></form>`;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const path = new URL(req.url).pathname, p = path.split("/")[1];
    if (req.method === "POST") {
      await req.arrayBuffer();
      posts[p] = (posts[p] ?? 0) + 1;
      return new Response(`<h1>Thank you for applying</h1><p>Application received. Confirmation number: MASS-${p.toUpperCase()}-${(server.addr as Deno.NetAddr).port}.</p>`, { headers: { "content-type": "text/html" } });
    }
    if (/^\/p\d+$/.test(path)) return new Response(kind === "login" && walled ? login : form(p), { headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  });
  return { base: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`, posts, wall: () => { walled = true; }, close: () => server.shutdown() };
}

// The person's computer, in its own process group so the kill takes its engines and browsers with it.
function worker(o: { pg: { host: string; port: number; bin: string }; journal: string; work: string; resume: string }) {
  const im = Deno.env.get("IMPORT_MAP");
  const cmd = new Deno.Command("setsid", {
    args: [Deno.execPath(), "run", "-A", "--no-check", ...(im ? [`--import-map=${im}`] : []), `${ROOT}/tests/flow/mass-driver.ts`],
    env: { ...Deno.env.toObject(), MASS_PG: `${o.pg.host}:${o.pg.port}:${o.pg.bin}`, MASS_PERSON: PERSON, MASS_JOURNAL: o.journal, MASS_PACING: JSON.stringify(PACING),
      MASS_RESUME: o.resume, MASS_ROOT: ROOT, MASS_WORK: o.work },
    stdout: "piped", stderr: "piped", stdin: "null",
  }).spawn();
  const lines: string[] = [];
  let onLine: (() => void) | null = null;
  const pump = (async () => {
    let pending = "";
    for await (const chunk of child(cmd).stdout.pipeThrough(new TextDecoderStream())) {
      pending += chunk;
      const parts = pending.split("\n");
      pending = parts.pop()!;
      for (const l of parts) { lines.push(l); onLine?.(); }
    }
  })();
  const err = new Response(cmd.stderr).text();
  return {
    lines,
    starts: () => lines.filter((l) => l.startsWith("START ")).length,
    waitStarts: (n: number, ms: number) => new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(Error(`fewer than ${n} starts in ${ms} ms:\n${lines.slice(-20).join("\n")}`)), ms);
      const check = () => { if (lines.filter((l) => l.startsWith("START ")).length >= n) { clearTimeout(t); onLine = null; res(); } };
      onLine = check; check();
    }),
    kill: async () => { await new Deno.Command("kill", { args: ["-KILL", "--", `-${cmd.pid}`] }).output(); },
    done: async () => { const st = await cmd.status; await pump; return { code: st.code, stderr: await err }; },
  };
}
const child = (c: Deno.ChildProcess) => c;

// Engine runs from the START/END lines: per run, [url, start ms, end ms].
function intervals(lines: string[]) {
  const open = new Map<string, number>(), out: { url: string; host: string; start: number; end: number }[] = [];
  for (const l of lines) {
    const m = /^(START|END) (\d+) (\S+)$/.exec(l);
    if (!m) continue;
    if (m[1] === "START") open.set(m[3], Number(m[2]));
    else { out.push({ url: m[3], host: new URL(m[3]).host, start: open.get(m[3])!, end: Number(m[2]) }); open.delete(m[3]); }
  }
  for (const [url, start] of open) out.push({ url, host: new URL(url).host, start, end: Infinity }); // killed mid-run
  return out;
}
function peak(iv: { start: number; end: number }[]) {
  const ev = iv.flatMap((x) => [[x.start, 1], [x.end, -1]] as [number, number][]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let n = 0, top = 0;
  for (const [, d] of ev) { n += d; top = Math.max(top, n); }
  return top;
}

Deno.test({
  name: "mass submission: 42 approved applications on 7 local hosts, batched and paced per host; the worker killed mid-batch and restarted; each sent exactly once; a check and a sign-in wall handed back, never retried",
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    if (!pgBinDir() || !browserEnv()) { if (CI) throw Error("needs Postgres 16 and the gate's Playwright browser in CI"); console.log("NOT_RUN locally: no Postgres or browser"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it with tests/flow/run-real-flow.sh (Chromium's sandbox)"); return; }
    const pg = await startPg();
    const hosts = [...Array.from({ length: 5 }, () => employer("plain")), employer("captcha"), employer("login")];
    const work = await Deno.makeTempDir({ prefix: "trainee-mass-" });
    try {
      await pg.sql(`insert into auth.users (id, email) values ('${PERSON}', 'mass.tester@example.test');
        insert into public.profiles (id) values ('${PERSON}');
        insert into public.career_watch_kv (user_id, key, value) values ('${PERSON}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
        ${confirmedResumeSql(PERSON, "%PDF-1.4\n% synthetic mass-test resume\n%%EOF\n")}`);
      const person = pg.asPerson(PERSON);
      const account = (await person.rpc("career_apply_account_own")).data;
      const resume = `${work}/resume.pdf`;
      await Deno.writeFile(resume, new TextEncoder().encode("%PDF-1.4\n% synthetic mass-test resume\n%%EOF\n"));
      // The postings: 8 on each ordinary host, one on the check host, one on the sign-in host; each its own company.
      const postings = [...hosts.slice(0, 5).flatMap((h, i) => Array.from({ length: 8 }, (_, k) => ({ url: `${h.base}/p${i * 8 + k}`, company: `TEST Employer ${i}-${k}` }))),
        { url: `${hosts[5].base}/p90`, company: "TEST Checked Employer" }, { url: `${hosts[6].base}/p91`, company: "TEST Walled Employer" }];
      // Preparation: the engine's dry run on each, four at a time (nothing is sent), stored as the person.
      const prepared: string[] = [];
      for (let i = 0; i < postings.length; i += 4) {
        await Promise.all(postings.slice(i, i + 4).map(async (p) => {
          const facts = `${work}/facts-${prepared.length}-${Math.random().toString(36).slice(2)}.json`;
          await Deno.writeTextFile(facts, JSON.stringify({ user_id: PERSON, posting: { company: p.company }, answers: {
            first_name: { value: "Mass", factId: "MASS-TEST-FACT-1", ...SOURCE }, last_name: { value: "Tester", factId: "MASS-TEST-FACT-2", ...SOURCE },
            email: { value: "mass.tester@example.test", factId: "MASS-TEST-FACT-3", ...SOURCE } } }));
          const state = await Deno.makeTempDir({ dir: work, prefix: "prep-state-" });
          const r = await prepare({ url: p.url, factsPath: facts, resumePath: resume, account, now: Date.now(), runEngine: engineRunner({ root: ROOT, extra: ["--state-dir", state] }) });
          assert(r.ready, `prepared ${p.url}: ${JSON.stringify((r as any).result)}`);
          const saved = await person.rpc("career_apply_prepare_own", { p_payload: r.payload, p_card_lines: r.card });
          assert(!saved.error, `stored: ${JSON.stringify(saved.error)}`);
          prepared.push(saved.data.id);
        }));
      }
      eq(hosts.reduce((n, h) => n + Object.keys(h.posts).length, 0), 0, "preparation sent nothing");
      // The person's taps: cards of 8, each approved whole.
      for (let i = 0; i < prepared.length; i += 8) {
        const card = await person.rpc("career_apply_card_open_own", { p_ids: prepared.slice(i, i + 8) });
        assert(!card.error, JSON.stringify(card.error));
        const ids = card.data.items.map((x: any) => x.n);
        const tap = await person.rpc("career_apply_card_answer_own", { p_card: card.data.id, p_approve: ids });
        assert(!tap.error && tap.data.every((x: any) => x.result === "queued"), `approved: ${JSON.stringify(tap)}`);
      }
      eq(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${PERSON}' and state = 'queued'`), "42", "42 approved and queued");
      hosts[6].wall(); // the employer now asks for a sign-in: the approved application meets it at Submit time

      const journal = `${work}/journal`;
      const where = { host: pg.host, port: pg.port, bin: pgBinDir()! };
      const t0 = performance.now();
      const one = worker({ pg: where, journal, work, resume });
      let killedAfter = 0;
      if (KILL_AFTER > 0) {
        await one.waitStarts(KILL_AFTER, 600_000);
        await one.kill();
        killedAfter = one.starts();
      }
      const r1 = await one.done();
      const midway = JSON.parse(await pg.sql(`select coalesce(jsonb_object_agg(state, n), '{}') from (select state, count(*) n from public.career_apply_jobs where user_id = '${PERSON}' group by state) x`));
      const two = KILL_AFTER > 0 ? worker({ pg: where, journal, work, resume }) : null;
      const r2 = two ? await two.done() : null;
      const wall = (performance.now() - t0) / 1000;
      const all = [...one.lines, ...(two?.lines ?? [])];
      const iv1 = intervals(one.lines), iv2 = intervals(two?.lines ?? []);
      const startsPer = new Map<string, number>();
      for (const x of [...iv1, ...iv2]) startsPer.set(x.url, (startsPer.get(x.url) ?? 0) + 1);
      const posts = new Map<string, number>();
      hosts.forEach((h) => { for (const [p, n] of Object.entries(h.posts)) posts.set(`${h.base}/${p}`, n); });
      const rows = JSON.parse(await pg.sql(`select coalesce(jsonb_agg(jsonb_build_object('url', url, 'state', state, 'reason', reason) order by url), '[]') from public.career_apply_jobs where user_id = '${PERSON}'`));
      const by = (s: string) => rows.filter((r: any) => r.state === s);
      const perHostPeak = Math.max(...[...new Set([...iv1, ...iv2].map((x) => x.host))].map((h) => Math.max(peak(iv1.filter((x) => x.host === h)), peak(iv2.filter((x) => x.host === h)))));
      const gaps = [iv1, iv2].flatMap((iv) => [...new Set(iv.map((x) => x.host))].flatMap((h) => {
        const s = iv.filter((x) => x.host === h).map((x) => x.start).sort((a, b) => a - b);
        return s.slice(1).map((t, i) => t - s[i]);
      }));
      console.log(`MEASURED jobs=42 hosts=7 wall_s=${wall.toFixed(1)} killed_after_starts=${killedAfter} run1_exit=${r1.code} run2_exit=${r2?.code ?? "-"} ` +
        `peak_all=${Math.max(peak(iv1), peak(iv2))} peak_per_host=${perHostPeak} min_host_gap_ms=${gaps.length ? Math.min(...gaps) : "-"} ` +
        `states=${JSON.stringify(Object.fromEntries([...new Set(rows.map((r: any) => r.state))].map((s) => [s, by(s as string).length])))} midway=${JSON.stringify(midway)}`);
      if (r2 && r2.code !== 0) console.log(r2.stderr.slice(-2000));

      // Every application ends in a recorded state; nothing is left being driven or queued.
      eq(by("queued").length + by("driving").length, 0, `nothing left queued or driving: ${JSON.stringify(rows.filter((r: any) => ["queued", "driving"].includes(r.state)))}\n${all.slice(-30).join("\n")}`);
      // Exactly once: never two engine starts or two POSTs for one application.
      assert([...startsPer.values()].every((n) => n === 1), `each application's engine started once: ${JSON.stringify([...startsPer].filter(([, n]) => n > 1))}`);
      assert([...posts.values()].every((n) => n === 1), `at most one POST per posting: ${JSON.stringify([...posts].filter(([, n]) => n > 1))}`);
      for (const r of [...by("submitted_unconfirmed"), ...by("confirmed")]) eq(posts.get(r.url), 1, `${r.url} recorded sent and posted once`);
      // The one running at the kill: unknown, never driven again (its START is in run 1 only).
      for (const r of by("unknown_outcome")) assert(!iv2.some((x) => x.url === r.url), `${r.url} was not driven again after the kill`);
      if (KILL_AFTER > 0) assert(by("unknown_outcome").length >= 1, "an application was running at the kill and is recorded unknown");
      // The check and the sign-in wall: handed back, nothing posted, the engine once.
      const checked = rows.find((r: any) => r.url === postings[40].url), walled = rows.find((r: any) => r.url === postings[41].url);
      if (!iv1.some((x) => x.url === postings[40].url && x.end === Infinity)) eq([checked.state, checked.reason], ["needs_user", "captcha"], "the verification check");
      if (!iv1.some((x) => x.url === postings[41].url && x.end === Infinity)) eq([walled.state, walled.reason], ["needs_user", "login_required"], "the sign-in wall");
      eq([posts.get(postings[40].url) ?? 0, posts.get(postings[41].url) ?? 0], [0, 0], "nothing was posted to the check or the wall");
      // Pacing: never more than hostMax on a host or concurrency in all; starts on one host at least its spacing apart.
      assert(perHostPeak <= PACING.hostMax, `at most ${PACING.hostMax} at once on one host (peak ${perHostPeak})`);
      assert(Math.max(peak(iv1), peak(iv2)) <= PACING.concurrency, `at most ${PACING.concurrency} at once (peak ${Math.max(peak(iv1), peak(iv2))})`);
      assert(!gaps.length || Math.min(...gaps) >= PACING.hostSpacingMs - 50, `starts on one host ${PACING.hostSpacingMs} ms apart (min ${Math.min(...gaps)})`);
      // Throughput: several at once across hosts (the base ran one at a time).
      assert(Math.max(peak(iv1), peak(iv2)) >= 2, `more than one application ran at once (peak ${Math.max(peak(iv1), peak(iv2))})`);
      // Everything else was sent, each once.
      eq(by("submitted_unconfirmed").length + by("confirmed").length + by("unknown_outcome").length + by("needs_user").length + by("not_submitted").length, 42, "every row accounted for");
      assert(by("not_submitted").every((r: any) => (posts.get(r.url) ?? 0) === 0), "a row recorded not sent was not posted");
    } finally {
      for (const h of hosts) await h.close();
      await pg.stop();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
// Keep attachPg referenced (the driver uses it from its own process).
void attachPg;
