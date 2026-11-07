// Release 9, workstream A, part 4 (2026-11-07): real submission at volume, against a STUB ATS on 127.0.0.1 (never a real
// employer, never the network). The pace is the product's own (workers/career-browser/apply-scheduler.cjs, the batch
// executor's scheduler) on a virtual clock; every application is a real HTTP request to the stub, which checks on its side
// that the body hashes to the approval it carries and that no person sends one posting twice.
// Proven, each by the stub's own record and the scheduler's:
//   1. 60 an hour per person, sustained: no 60-minute window ever holds more than 60 of one person's sends, and a person
//      with a long queue sends 60 in each of the first hours;
//   2. the 200-a-day cap: no 24-hour window holds more than 200 of one person's sends; the rest wait, never dropped;
//   3. 5,000 in a month across 25 people (APPLY_LOAD_PEOPLE x a month of approvals), with transient failures retried,
//      permanent ones dead-lettered with their reason, and a proof on every send;
//   4. no duplicates (the same posting by another link, or again) and no send without a matching approval hash.
// Size: APPLY_LOAD_PEOPLE (default 25), APPLY_LOAD_MONTH (default 5000). Nothing is sent anywhere but the stub.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../../workers/career-browser/apply-scheduler.cjs");
const PEOPLE = Number(Deno.env.get("APPLY_LOAD_PEOPLE") ?? 25), MONTH = Number(Deno.env.get("APPLY_LOAD_MONTH") ?? 5000);
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Date.parse("2026-12-01T00:00:00Z");
const SITES = ["greenhouse", "lever", "ashby", "smartrecruiters"];
const h32 = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; return h; };

// ---- the stub ATS: one Deno server on loopback, four "sites" by path --------------------------------------------------------
function stubAts() {
  const got: { user: string; key: string; site: string; at: number; ok: boolean }[] = [];
  const violations: string[] = [];
  const applied = new Set<string>(); // user|posting key
  const perSiteMinute = new Map<string, number>();
  let requests = 0;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    requests++;
    const u = new URL(req.url);
    const m = /^\/(greenhouse|lever|ashby|smartrecruiters)\/([^/]+)\/jobs\/([^/]+)\/apply$/.exec(u.pathname);
    if (req.method !== "POST" || !m) return new Response("not found", { status: 404 });
    const at = Number(req.headers.get("x-test-clock"));
    const body = await req.json();
    const approval = req.headers.get("x-approval-sha256") ?? "";
    if (!approval || S.payloadSha256(body.payload) !== approval) { violations.push(`no matching approval: ${u.pathname}`); return new Response("not approved", { status: 403 }); }
    // The employer's own rate limit, per site per (virtual) minute: the scheduler's site limit must keep under it.
    const minute = `${m[1]}|${Math.floor(at / MIN)}`;
    perSiteMinute.set(minute, (perSiteMinute.get(minute) ?? 0) + 1);
    if ((perSiteMinute.get(minute) ?? 0) > 40) return new Response("slow down", { status: 429 });
    const attempt = Number(req.headers.get("x-attempt"));
    const roll = h32(`${body.payload.user_id}|${body.payload.job_id}|${attempt}`) % 1000;
    if (roll < 25) return new Response("busy", { status: 503 }); // 2.5%: transient, nothing recorded
    if (h32(`${body.payload.user_id}|${body.payload.job_id}`) % 1000 < 4) return new Response(JSON.stringify({ error: "posting_closed" }), { status: 410 }); // 0.4%: permanent
    const key = `${body.payload.user_id}|${S.postingKey(body.payload.url)}`;
    if (applied.has(key)) { violations.push(`duplicate: ${key}`); return new Response(JSON.stringify({ error: "already_applied" }), { status: 409 }); }
    applied.add(key);
    got.push({ user: body.payload.user_id, key, site: m[1], at, ok: true });
    const id = `${m[1].slice(0, 2).toUpperCase()}-${h32(key).toString(36)}`;
    // Greenhouse and SmartRecruiters answer with an API receipt; Lever and Ashby with a thank-you page.
    return m[1] === "greenhouse" || m[1] === "smartrecruiters"
      ? new Response(JSON.stringify({ application_id: id }), { status: 201, headers: { "content-type": "application/json" } })
      : new Response(`<html><body><h1>Thank you for applying!</h1><p>Your application ID is ${id}.</p></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  });
  const port = (server.addr as Deno.NetAddr).port;
  return { base: `http://127.0.0.1:${port}`, got, violations, applied, requests: () => requests, close: () => server.shutdown() };
}

// ---- the send: one approved application to the stub, its outcome in the scheduler's terms ----------------------------------
function submitTo(clock: () => number) {
  return async (job: any) => {
    const url = new URL(job.url);
    if (url.hostname !== "127.0.0.1") throw new Error("the load test sends only to the stub ATS on loopback");
    const r = await fetch(job.url, { method: "POST", headers: { "content-type": "application/json", "x-approval-sha256": job.approvalHash, "x-test-clock": String(clock()), "x-attempt": String(job.attempts) },
      body: JSON.stringify({ payload: job.payload }) });
    const text = await r.text();
    if (r.status === 201) return { posted: true, outcome: "submitted", proof: { kind: "api_receipt", ref: JSON.parse(text).application_id } };
    if (r.status === 200) { const id = /application ID is ([A-Z0-9-]+)/i.exec(text)?.[1]; return { posted: true, outcome: "submitted", proof: id ? { kind: "confirmation_page", ref: `Thank you for applying! ${id}` } : null }; }
    if (r.status === 429 || r.status === 503) return { posted: false, outcome: "transient", reason: `http_${r.status}` };
    return { posted: false, outcome: "permanent", reason: r.status === 410 ? "posting_closed" : `http_${r.status}` };
  };
}

function application(base: string, user: string, n: number, o: Record<string, unknown> = {}) {
  const site = SITES[h32(`${user}:${n}`) % SITES.length];
  const employer = h32(`${user}:${n}:e`) % 400;
  const url = `${base}/${site}/employer${employer}/jobs/${user}-${n}/apply`;
  const payload = { version: 1, user_id: user, job_id: `${user}-${n}`, url, company: `Employer ${employer} (TEST)`, fields: [{ name: "email", value: `${user}@example.test`, factId: `${user}:email` }], resume_sha256: "a".repeat(64) };
  const sha = S.payloadSha256(payload);
  return { id: `${user}#${n}`, userId: user, jobId: payload.job_id, company: payload.company, url, payload, payloadSha256: sha, approvalHash: sha, ...o };
}

function harness(limits: Record<string, number> = {}) {
  let t = T0;
  const clock = () => t;
  const ats = stubAts();
  const sch = S.createApplyScheduler({ now: clock, limits, submit: submitTo(clock) });
  const runUntil = async (end: number) => {
    for (let guard = 0; guard < 2_000_000; guard++) {
      const due = sch.nextDueAt();
      if (due === null || due > end) { t = Math.max(t, end); return; }
      t = Math.max(t, due);
      await sch.tick();
    }
    throw new Error("runaway");
  };
  return { ats, sch, runUntil, clock, set: (x: number) => { t = Math.max(t, x); } };
}
const maxInWindow = (times: number[], span: number) => {
  const s = [...times].sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; i < s.length; i++) { while (s[i] - s[j] >= span) j++; best = Math.max(best, i - j + 1); }
  return best;
};

Deno.test({ name: "R9 load: 60 an hour per person, sustained, for every one of 25 people at once", sanitizeResources: false, sanitizeOps: false, async fn() {
  const h = harness();
  try {
    for (let p = 0; p < PEOPLE; p++) for (let n = 0; n < 180; n++) assert(h.sch.enqueue(application(h.ats.base, `P${p}`, n)).ok);
    const started = performance.now();
    await h.runUntil(T0 + 3 * HOUR - 1);
    const ms = performance.now() - started;
    const byUser = Map.groupBy(h.ats.got, (g) => g.user);
    for (const [u, list] of byUser) {
      const times = list.map((g) => g.at);
      assert(maxInWindow(times, HOUR) <= 60, `${u}: at most 60 in any hour`);
      for (let k = 0; k < 3; k++) {
        const inHour = times.filter((x) => x >= T0 + k * HOUR && x < T0 + (k + 1) * HOUR).length;
        assert(inHour >= 57 && inHour <= 60, `${u} hour ${k + 1}: ${inHour} sent (60 less the few the stub refused that hour)`);
      }
    }
    const sent = h.ats.got.length;
    console.log(`R9 sustained: ${PEOPLE} people x 3 hours: ${sent} sent (${(sent / PEOPLE / 3).toFixed(1)} per person-hour), ${h.ats.requests()} requests, ${ms.toFixed(0)} ms wall`);
    assertEquals(h.ats.violations, []);
  } finally { await h.ats.close(); }
} });

Deno.test({ name: "R9 load: the 200-a-day cap holds for every person; the rest wait, never dropped", sanitizeResources: false, sanitizeOps: false, async fn() {
  const h = harness();
  try {
    for (let p = 0; p < 5; p++) for (let n = 0; n < 450; n++) h.sch.enqueue(application(h.ats.base, `C${p}`, n));
    await h.runUntil(T0 + DAY - 1);
    for (let p = 0; p < 5; p++) {
      const day1 = h.ats.got.filter((g) => g.user === `C${p}`).length;
      const settled = h.sch.jobs().filter((j: any) => j.userId === `C${p}` && j.state !== "queued" && j.state !== "retry_wait");
      assert(day1 <= 200 && settled.filter((j: any) => ["submitted_unconfirmed", "confirmed", "unknown_outcome"].includes(j.state)).length <= 200, `C${p}: ${day1} on day one`);
      assert(day1 >= 190, `C${p}: the day's 200, less the few the stub refused (${day1})`);
    }
    await h.runUntil(T0 + 4 * DAY);
    for (let p = 0; p < 5; p++) {
      const times = h.ats.got.filter((g) => g.user === `C${p}`).map((g) => g.at);
      assert(maxInWindow(times, DAY) <= 200, `C${p}: never more than 200 in 24 hours`);
      assert(maxInWindow(times, HOUR) <= 60, `C${p}: never more than 60 in an hour`);
      const left = h.sch.jobs().filter((j: any) => j.userId === `C${p}` && (j.state === "queued" || j.state === "retry_wait"));
      assertEquals(left.length, 0, `C${p}: all 450 settled by day four`);
    }
    assertEquals(h.ats.violations, []);
    console.log(`R9 cap: 5 people x 450 approved: ${h.ats.got.length} sent over 4 days, max ${Math.max(...[0, 1, 2, 3, 4].map((p) => maxInWindow(h.ats.got.filter((g) => g.user === `C${p}`).map((g) => g.at), DAY)))} in any 24 hours`);
  } finally { await h.ats.close(); }
} });

Deno.test({ name: `R9 load: ${MONTH} in a month across ${PEOPLE} people; no duplicate, no send without its approval, a proof on every send`, sanitizeResources: false, sanitizeOps: false, async fn() {
  const h = harness();
  try {
    const slots = 30 * PEOPLE; // person-days; slot i takes its share of MONTH, so the month totals exactly MONTH
    const share = (i: number) => Math.floor(((i + 1) * MONTH) / slots) - Math.floor((i * MONTH) / slots);
    const counts = new Map<string, number>();
    let approved = 0, refusedDup = 0, refusedHash = 0, tampered = 0;
    const started = performance.now();
    for (let d = 0; d < 30; d++) {
      // Each morning, each person's yes to the day's card (6 to 7 applications), then the day runs.
      h.set(T0 + d * DAY + 8 * HOUR + (d % 5) * MIN);
      for (let p = 0; p < PEOPLE; p++) {
        const u = `M${p}`;
        const take = share(d * PEOPLE + p);
        for (let k = 0; k < take; k++) {
          const n = counts.get(u) ?? 0;
          counts.set(u, n + 1);
          const r = h.sch.enqueue(application(h.ats.base, u, n));
          assert(r.ok, JSON.stringify(r));
          approved++;
        }
        // The same posting reached again by another link (a tracking parameter, a trailing slash), or as a second source's
        // job id: refused before anything is sent.
        const n0 = (counts.get(u) ?? 1) - 1, again = application(h.ats.base, u, n0);
        for (const url of [again.url + "?utm_source=alert", again.url.replace(/\/apply$/, "/")]) {
          const r = h.sch.enqueue({ ...again, id: `${again.id}~${url.length}`, url, payload: { ...again.payload }, jobId: `${again.jobId}~other-source` });
          if (r.reason === "duplicate_job") refusedDup++; else throw new Error(`a second application to one posting was admitted: ${url} ${JSON.stringify(r)}`);
        }
        // An approval of another payload, and a payload changed after the yes: never sent.
        if (d % 10 === 0) {
          const x = application(h.ats.base, u, 100000 + d);
          if (h.sch.enqueue({ ...x, approvalHash: S.payloadSha256({ ...x.payload, fields: [] }) }).reason === "not_approved") refusedHash++;
          const y = application(h.ats.base, u, 200000 + d);
          assert(h.sch.enqueue(y).ok);
          y.payload.fields.push({ name: "added_after_yes", value: "TEST", factId: "x" });
          tampered++;
        }
      }
      await h.runUntil(T0 + (d + 1) * DAY - 1);
    }
    await h.runUntil(T0 + 31 * DAY);
    const ms = performance.now() - started;
    const jobs = h.sch.jobs();
    const real = jobs.filter((j: any) => !/#(1|2)\d{5}$/.test(j.id));
    const by = (s: string) => real.filter((j: any) => j.state === s);
    const sent = [...by("submitted_unconfirmed"), ...by("confirmed")];
    const dead = by("dead_letter");
    assertEquals(approved, MONTH);
    assertEquals(real.length, MONTH, "every approved application is accounted for");
    assertEquals(sent.length + dead.length + by("unknown_outcome").length, MONTH, "each one sent, or set aside with its reason; none left waiting");
    assert(sent.length >= MONTH * 0.99, `${sent.length} sent of ${MONTH}`);
    for (const j of sent) assert(j.proof && j.proof.ref && ["api_receipt", "confirmation_page", "email"].includes(j.proof.kind), `${j.id} keeps its proof`);
    for (const j of dead) assert(/^(permanent: posting_closed|retries_exhausted: http_(503|429))$/.test(j.reason), `${j.id}: ${j.reason}`);
    assertEquals(h.ats.got.length, sent.length, "the stub holds exactly the sends the scheduler recorded");
    assertEquals(h.ats.violations, [], "the stub saw no duplicate and no body without its approval");
    assertEquals(new Set(h.ats.got.map((g) => g.key)).size, h.ats.got.length, "no posting twice for one person");
    // The tampered ones never reached the stub; they are set aside by name.
    const changed = jobs.filter((j: any) => /#2\d{5}$/.test(j.id));
    assertEquals(changed.length, tampered);
    for (const j of changed) assertEquals([j.state, j.reason], ["dead_letter", "permanent: payload_changed_after_approval"]);
    assert(refusedHash > 0 && refusedDup > 0);
    for (let p = 0; p < PEOPLE; p++) {
      const times = h.ats.got.filter((g) => g.user === `M${p}`).map((g) => g.at);
      assert(maxInWindow(times, HOUR) <= 60 && maxInWindow(times, DAY) <= 200, `M${p}: within 60 an hour and 200 a day`);
    }
    const retried = real.filter((j: any) => j.attempts > 1).length;
    const kinds = Object.entries(Object.groupBy(sent, (j: any) => j.proof.kind)).map(([k, v]) => `${k} ${v!.length}`).join(", ");
    console.log(`R9 month: ${MONTH} approved by ${PEOPLE} people over 30 days: ${sent.length} sent (${kinds}), ${dead.length} dead-lettered (${[...new Set(dead.map((j: any) => j.reason))].join("; ")}), ` +
      `${retried} retried after a transient failure, ${refusedDup} duplicate links refused, ${refusedHash} mismatched approvals refused, ${tampered} changed-after-yes set aside; ` +
      `${h.ats.requests()} requests to the stub in ${(ms / 1000).toFixed(1)} s wall`);
  } finally { await h.ats.close(); }
} });
