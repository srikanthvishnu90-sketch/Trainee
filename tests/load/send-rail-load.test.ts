// Mass networking, lane M1, SCALE (owner, 2026-10-27 19:52 CDT): the sending rail under load on real Postgres 16.
// 10,000 people x 50 approved outreach emails each, plus one heavy sender with 5,000 more, sent by 20 concurrent sender
// instances (each its own database session, as the career-send function runs), Gmail faked at the HTTP boundary.
// Asserted: every approved email reaches Gmail exactly once; nobody is starved by the heavy sender; Gmail's own refusal
// of the heavy account (429 after 2,000, its daily ceiling in this fake) backs off only that account, tells that person
// once, and loses nothing. Measured and printed: throughput, claim/complete latency, time to each person's first email.
// The size is SEND_LOAD_PEOPLE (default 10000) x SEND_LOAD_EACH (default 50); nothing is sent anywhere.
import assertNode from "node:assert/strict";
import { queueApprovedOutreach, runSendWorker, type WorkerDeps } from "../../supabase/functions/_shared/career_send_rail.ts";
import { CI, draftsReader, haveDb, railDb } from "../flow/send-rail-fixture.ts";
import { serviceRpc } from "../flow/pgwire.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const PEOPLE = Number(Deno.env.get("SEND_LOAD_PEOPLE") ?? 10000), EACH = Number(Deno.env.get("SEND_LOAD_EACH") ?? 50);
const WORKERS = 20, HEAVY_EXTRA = 5000, HEAVY_CEILING = 2000, VIA_ENQUEUE = Math.min(500, Math.floor(PEOPLE / 20));
const RUN = crypto.randomUUID().slice(0, 4);
const idOf = (g: number) => `00000000-0000-4000-9${RUN.slice(0, 3)}-${g.toString(16).padStart(12, "0")}`;
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0; };

Deno.test({ name: `M1 send rail at scale: ${PEOPLE} people x ${EACH} emails + one heavy sender, ${WORKERS} concurrent senders`, sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const db = await railDb();
  try {
    const heavy = PEOPLE + 1;
    const t0 = performance.now();
    // People, their Google grants (connection rows), and their approved drafts, as N2's approval leaves them. The hash is
    // computed in SQL exactly as payloadHash(messageOf(draft)) computes it (asserted below by the sends themselves: the
    // worker refuses any draft whose stored text does not hash to its approval).
    await db.sql.query(`
      set synchronous_commit = off;
      insert into auth.users(id, email) select ('${idOf(0).slice(0, 24)}' || lpad(to_hex(g), 12, '0'))::uuid, 'load' || g || '@example.test' from generate_series(1, ${heavy}) g;
      insert into public.profiles(id) select ('${idOf(0).slice(0, 24)}' || lpad(to_hex(g), 12, '0'))::uuid from generate_series(1, ${heavy}) g;
      insert into public.user_oauth_connections(user_id, provider, vault_name, scopes)
        select u, 'google_career', 'oauth_google_career_' || u, 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'
        from (select ('${idOf(0).slice(0, 24)}' || lpad(to_hex(g), 12, '0'))::uuid u from generate_series(1, ${heavy}) g) x;
      create temp table plan as
        select ('${idOf(0).slice(0, 24)}' || lpad(to_hex(g), 12, '0'))::uuid as user_id, g, i,
          'r' || i || '.p' || g || '.${RUN}@example.test' as email
        from generate_series(1, ${heavy}) g, generate_series(1, ${EACH}) i
        union all
        select ('${idOf(0).slice(0, 24)}' || lpad(to_hex(${heavy}), 12, '0'))::uuid, ${heavy}, i, 'r' || i || '.p${heavy}.${RUN}@example.test'
        from generate_series(${EACH} + 1, ${EACH} + ${HEAVY_EXTRA}) i;
      insert into public.career_outreach_drafts(id, user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status, approved_hash, approved_at)
        select gen_random_uuid(), user_id, md5(user_id::text || ((i - 1) / 10))::uuid, ((i - 1) % 10) + 1,
          jsonb_build_object('name', 'Person ' || i, 'firm', 'Example Co', 'title', 'Analyst', 'school', '', 'email', email, 'source', 'load'),
          email, 'Question ' || i, 'Hi Person ' || i || ', would you have 15 minutes?', 'Sam Lee', h, 'approved', h, now()
        from (select *, encode(sha256(convert_to('["' || email || '","Question ' || i || '","Hi Person ' || i || ', would you have 15 minutes?\\n\\nSam Lee"]', 'UTF8')), 'hex') h from plan) p;
      insert into public.career_send_queue(user_id, kind, source_id, approval_hash, idem_key, recipient_email, subject, body)
        select d.user_id, 'outreach', d.id, d.hash, 'outreach:' || d.id || ':' || d.hash, d.recipient_email, d.subject, d.body || E'\\n\\n' || d.footer
        from public.career_outreach_drafts d join plan p on p.user_id = d.user_id and p.email = d.recipient_email
        where p.g > ${VIA_ENQUEUE};
      insert into public.career_send_accounts(user_id, provider, has_work)
        select distinct user_id, 'gmail', true from public.career_send_queue where recipient_email like '%.${RUN}@example.test';
      analyze;`);
    const seededMs = performance.now() - t0;
    const total = PEOPLE * EACH + EACH + HEAVY_EXTRA;

    // The first VIA_ENQUEUE people go through the real hand-off (queueApprovedOutreach), 20 at once.
    const conns = await Promise.all(Array.from({ length: WORKERS }, () => db.conn()));
    const e0 = performance.now();
    const enqLat: number[] = [];
    let next = 1;
    await Promise.all(conns.map(async (c) => {
      const rpc = serviceRpc(c), drafts = draftsReader(c);
      for (let g = next++; g <= VIA_ENQUEUE; g = next++) {
        const u = idOf(g);
        const rows = await c.query(`select id, hash from public.career_outreach_drafts where user_id = '${u}' order by n`);
        const s = performance.now();
        const r = await queueApprovedOutreach({ ...rpc, drafts }, u, rows.map(([id, hash]) => ({ draftId: id!, approvalHash: hash! })));
        enqLat.push(performance.now() - s);
        eq(r.filter((x) => x.status === "queued").length, EACH);
      }
    }));
    const enqueueMs = performance.now() - e0;
    eq(Number(await db.sql.one(`select count(*) from public.career_send_queue where recipient_email like '%.${RUN}@example.test'`)), total);

    // A fake Gmail that only counts: who got what, in what order, and the heavy account's ceiling.
    const perTo = new Map<string, number>();
    const firstAt = new Map<string, number>(), firstRank = new Map<string, number>();
    const perAccount = new Map<string, number>();
    let rank = 0, heavyAtLastFirst = -1, refusedHeavy = 0;
    const heavyId = idOf(heavy);
    const fetchFake = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
      const url = String(input instanceof Request ? input.url : input);
      const acct = String((init?.headers as Record<string, string>)?.Authorization ?? "").replace(/^Bearer tok-(send|read)-/, "");
      if (url.endsWith("/messages/send")) {
        if (acct === heavyId && (perAccount.get(acct) ?? 0) >= HEAVY_CEILING) {
          refusedHeavy++;
          return new Response('{"error":{"code":429,"message":"Daily user sending limit exceeded","errors":[{"reason":"dailyLimitExceeded"}]}}', { status: 429, headers: { "retry-after": "86400" } });
        }
        const raw = String(JSON.parse(String(init?.body)).raw);
        const mime = atob(raw.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (raw.length % 4)) % 4));
        const to = /^To: (.*)$/m.exec(mime)![1];
        perTo.set(`${acct}|${to}`, (perTo.get(`${acct}|${to}`) ?? 0) + 1);
        perAccount.set(acct, (perAccount.get(acct) ?? 0) + 1);
        rank++;
        if (!firstRank.has(acct)) {
          firstRank.set(acct, rank); firstAt.set(acct, performance.now());
          if (firstRank.size === PEOPLE + 1) heavyAtLastFirst = perAccount.get(heavyId) ?? 0;
        }
        return new Response(`{"id":"m${rank}","threadId":"t${rank}"}`, { status: 200 });
      }
      return Response.json({ messages: [] }); // a Sent check (none expected: no send is interrupted here)
    };
    const lat: Record<string, number[]> = {};
    const timed = (rpc: WorkerDeps["rpc"]): WorkerDeps["rpc"] => async (name, args) => {
      const s = performance.now();
      try { return await rpc(name, args); } finally { (lat[name] ??= []).push(performance.now() - s); }
    };
    const s0 = performance.now();
    const stats = await Promise.all(conns.map((c, i) => runSendWorker({
      rpc: timed(serviceRpc(c).rpc), fetch: fetchFake as typeof fetch, drafts: draftsReader(c),
      token: async (u, scope) => `tok-${scope.endsWith("gmail.send") ? "send" : "read"}-${u}`,
    }, { worker: `load-${i}`, accounts: 20, perAccount: 25, leaseSeconds: 300, deadlineMs: 3_600_000 })));
    const sendMs = performance.now() - s0;
    const sum = (k: keyof (typeof stats)[0]) => stats.reduce((a, s) => a + Number(s[k] ?? 0), 0);

    // Exactly once, everyone, and the heavy account only up to what Gmail accepted.
    const sent = sum("sent");
    eq(sent, total - (EACH + HEAVY_EXTRA - HEAVY_CEILING), JSON.stringify({ sent, stats: stats.slice(0, 2) }));
    eq([...perTo.values()].every((n) => n === 1), true, "no address received two emails");
    eq(perTo.size, sent);
    eq(firstRank.size, PEOPLE + 1, "every person sent");
    eq(sum("errors"), 0, JSON.stringify(stats.find((s) => s.errors)));
    eq(sum("stale") + sum("refused") + sum("failed"), 0);
    const left = await db.sql.query(`select state, count(*) from public.career_send_queue where recipient_email like '%.${RUN}@example.test' group by state order by 1`);
    eq(Object.fromEntries(left.map(([s, n]) => [s, Number(n)])), { queued: EACH + HEAVY_EXTRA - HEAVY_CEILING, sent });
    const hv = await db.sql.query(`select state, resume_at > now() + interval '23 hours' from public.career_send_accounts where user_id = '${heavyId}'`);
    eq(hv[0], ["backoff", "t"], "the heavy account waits for Gmail's own time");
    eq(Number(await db.sql.one(`select count(*) from public.career_outbox where user_id = '${heavyId}' and key like 'status:send-paused:%'`)), 1, "told once");
    eq(Number(await db.sql.one(`select count(*) from public.career_send_accounts where user_id::text like '00000000-0000-4000-9${RUN.slice(0, 3)}%' and state <> 'ok' and user_id <> '${heavyId}'`)), 0, "nobody else paused");
    // Fairness: when the last person got their first email, the heavy sender had had at most a few turns.
    ok(heavyAtLastFirst >= 0 && heavyAtLastFirst <= 3 * 25, `heavy sender had ${heavyAtLastFirst} sent when everyone had started`);
    eq(refusedHeavy, 1, "one refusal, then the account waits: Gmail is never hammered");

    const firsts = [...firstAt.values()].map((x) => (x - s0) / 1000);
    const report = {
      people: PEOPLE + 1, emails_queued: total, sent, workers: WORKERS,
      seed_s: +(seededMs / 1000).toFixed(1),
      enqueue: { people: VIA_ENQUEUE, items: VIA_ENQUEUE * EACH, s: +(enqueueMs / 1000).toFixed(2), per_s: Math.round((VIA_ENQUEUE * EACH) / (enqueueMs / 1000)), p50_ms_per_50: +pct(enqLat, 50).toFixed(1), p99_ms_per_50: +pct(enqLat, 99).toFixed(1) },
      send: { s: +(sendMs / 1000).toFixed(1), per_s: Math.round(sent / (sendMs / 1000)), claims: sum("claims") },
      latency_ms: Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, { n: v.length, p50: +pct(v, 50).toFixed(2), p95: +pct(v, 95).toFixed(2), p99: +pct(v, 99).toFixed(2), max: +v.reduce((m, x) => Math.max(m, x), 0).toFixed(1) }])),
      first_email_s: { p50: +pct(firsts, 50).toFixed(1), p99: +pct(firsts, 99).toFixed(1), max: +Math.max(...firsts).toFixed(1) },
      heavy: { queued: EACH + HEAVY_EXTRA, sent: perAccount.get(heavyId), sent_when_everyone_had_started: heavyAtLastFirst, gmail_refusals: refusedHeavy },
    };
    console.log(`SEND RAIL LOAD ${JSON.stringify(report)}`);
  } finally {
    await db.stop();
  }
} });
