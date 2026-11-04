// KNOWN GAPS (architect, 2026-10-30), gap 1, through the REAL chat handler (handleChat, agent-chat/handler-career.ts) on
// real Postgres with every migration (tests/flow/pg.ts) behind the PostgREST double, with the real supabase-js client.
// #318 made the router's resume confirmation write its fact_confirmed events with the turn's save
// (career_host_commit_evidenced). Its "Not in this PR" left two writers that still wrote theirs DURING the turn, so a save
// refused afterwards (another thread of the person saved first) left events naming facts no saved record holds: a fact
// stated in chat (evidenceStatedFacts via accountMemoryAfterTurn) and the agent brain's confirm_profile_fact. Both are now
// held (heldEvents) and written by the evidenced commit (20261030080000 lets it take stated facts).
//   A  a fact stated on the texting thread ("I am a junior majoring in computer science") while the web chat saves first
//   B  #318's fallback, for a stated fact: a non-conflict failure of the evidenced commit saves the turn without the
//      events; the statement stays on the record unevidenced (never called confirmed), and the reply is the router's.
// The brain's confirm_profile_fact is not reachable through the live handler today (the full brain is not released, and the
// staged brain never takes a bare yes): its half is known-gaps-sweep.test.ts (the tool and agentTurn write into the held
// store) with the handler's wiring.
// Each turn is held at its save point (the commit RPC request, before it reaches the database) and released in order.
// After every step: every fact_confirmed event names a fact a saved record holds with that confirmation id, and every
// saved fact carrying a confirmation id has its event (D-007: no evidence without state, no state without evidence).
// No model, no network: every host but the PostgREST double is refused.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const PERSON = (n: number) => `7b0f8f8e-6a43-4a49-9d2c-00000000e8${String(n).padStart(2, "0")}`;
const STATED = "I am a junior majoring in computer science";
const STATED_VIA = "router: stated by the person in chat";
const ENV_OFF = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "CAREER_BRAIN_ROUTER_INTENTS", "CAREER_ACCOUNT_MEMORY", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL",
  "CAREER_REPLY_WRITER", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "TRAINEE_FILE_BASE_URL", "CAREER_JUDGE", "CAREER_APPLY_LINK"];

Deno.test({ name: "known gaps (1): a fact stated in chat writes its evidence with the save or not at all", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) {
    if (CI) throw Error("the evidence flow needs Postgres 16 in CI");
    console.log("NOT_RUN locally: no Postgres binaries");
    return;
  }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
  const saved = Object.fromEntries(ENV_OFF.map((k) => [k, Deno.env.get(k)]));
  for (const k of ENV_OFF) Deno.env.delete(k);
  const pg: Pg = await startPg();
  let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
  const realFetch = globalThis.fetch;
  try {
    await supabaseParity(pg);
    const people = [1, 2];
    for (const n of people) {
      await pg.sql(`insert into auth.users (id, email) values ('${PERSON(n)}', 'kg-${n}@example.test'); insert into public.profiles (id) values ('${PERSON(n)}');
        insert into public.career_watch_kv (user_id, key, value) values ('${PERSON(n)}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    h = await careerHandler(pg, Object.fromEntries(people.map((n) => [`tok-${n}`, PERSON(n)])));
    const handleChat = (await import("../../supabase/functions/agent-chat/handler-career.ts")).handleChat;

    // ------------------------------------------------------------------------------------------ the save point
    type Hold = { match: (body: string) => boolean; hit: boolean; reached: Promise<void>; arrive: () => void; go: Promise<void>; release: () => void };
    const holds: Hold[] = [];
    const fails: { match: (body: string) => boolean; hit: boolean }[] = [];
    const commits: { rpc: string; body: string }[] = [];
    const hold = (match: (body: string) => boolean): Hold => {
      let arrive!: () => void, release!: () => void;
      const reached = new Promise<void>((r) => (arrive = r)), go = new Promise<void>((r) => (release = r));
      const x: Hold = { match, hit: false, reached, arrive, go, release };
      holds.push(x);
      return x;
    };
    const viaDouble = globalThis.fetch;
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      const u = new URL(req.url);
      if (u.origin === SUPABASE_URL && u.pathname.startsWith("/rest/v1/rpc/career_host_commit")) {
        const body = await req.clone().text();
        const rpc = u.pathname.split("/").pop()!;
        const x = holds.find((y) => !y.hit && y.match(body));
        if (x) { x.hit = true; x.arrive(); await x.go; }
        commits.push({ rpc, body });
        const f = rpc === "career_host_commit_evidenced" ? fails.find((y) => !y.hit && y.match(body)) : undefined;
        if (f) { f.hit = true; return Response.json({ code: "XX000", message: "TEST the evidenced commit is unavailable", details: null, hint: null }, { status: 500 }); }
      }
      if (u.origin === SUPABASE_URL) return await viaDouble(req);
      throw new TypeError(`network refused: ${u.host}`);
    }) as typeof fetch;

    // ------------------------------------------------------------------------------------------ two threads of one person
    let k = 0;
    const texting = (n: number) => {
      let thread: string | null = null;
      return {
        thread: () => thread!,
        async say(message: string, key = `kg-${n}-${++k}`) {
          const res = await handleChat(new Request(`${SUPABASE_URL}/functions/v1/agent-chat`, {
            method: "POST", headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ as_user_id: PERSON(n), message, turn_key: key, channel: "telegram", ...(thread ? { thread_id: thread } : {}) }),
          }));
          const body = await res.json().catch(() => ({}));
          if (body?.thread_id) thread = body.thread_id;
          return { status: res.status, reply: String(body?.reply ?? ""), body, intent: body?.meta?.intent ?? null, resultStatus: body?.meta?.result_status ?? null };
        },
      };
    };
    const keyIs = (key: string) => (b: string) => b.includes(`"p_key":"${key}"`);

    // ------------------------------------------------------------------------------------------ the database, judged
    const q = async (s: string) => JSON.parse((await pg.sql(s)).trim() || "null");
    // Every saved place a confirmation id can live: the account's stated facts (both lists), every thread's stated facts and
    // profile facts.
    const look = async (n: number) => {
      const u = PERSON(n);
      // deno-lint-ignore no-explicit-any
      const events: any[] = await q(`select coalesce(json_agg(json_build_object('cid', detail->>'confirmation_event_id', 'via', detail->>'via', 'kind', detail->>'kind')), '[]'::json)::text
        from public.career_events where user_id = '${u}' and kind = 'fact_confirmed'`);
      // deno-lint-ignore no-explicit-any
      const stated: any[] = await q(`select coalesce(json_agg(f), '[]'::json)::text from (
          select f from public.career_watch_kv a, jsonb_array_elements(coalesce(a.value#>'{stated_facts,facts}', '[]'::jsonb) || coalesce(a.value#>'{stated_facts,keyed}', '[]'::jsonb)) f
           where a.user_id = '${u}' and a.key = 'career:account'
          union all
          select f from public.agent_flow_state s, jsonb_array_elements(coalesce(s.state#>'{career,stores,statedFacts,facts}', '[]'::jsonb)) f where s.user_id = '${u}') x`);
      // deno-lint-ignore no-explicit-any
      const profile: any[] = await q(`select coalesce(json_agg(f), '[]'::json)::text from public.agent_flow_state s, jsonb_array_elements(coalesce(s.state#>'{career,stores,profile,facts}', '[]'::jsonb)) f where s.user_id = '${u}'`);
      return { events, stated, profile };
    };
    const consistent = async (n: number, when: string) => {
      const s = await look(n);
      const savedIds = new Set([...s.stated.filter((f) => f && f.confirmation_event_id).map((f) => f.confirmation_event_id),
        ...s.profile.filter((f) => f && f.confirmation_event_id && f.status === "confirmed" && f.needs_confirmation === false).map((f) => f.confirmation_event_id)]);
      for (const e of s.events) ok(savedIds.has(e.cid), `${when}: an event (${e.cid}, ${e.via ?? e.kind}) names no fact a saved record holds (evidence without state)`);
      for (const id of savedIds) ok(s.events.some((e) => e.cid === id), `${when}: a saved fact (${id}) carries a confirmation id with no event (state without evidence)`);
      eq(new Set(s.events.map((e) => e.cid)).size, s.events.length, `${when}: one event per confirmation`);
      return s;
    };
    const statedEvents = (s: Awaited<ReturnType<typeof look>>) => s.events.filter((e) => e.via === STATED_VIA);

    await t.step("A: a fact stated on the texting thread while the web chat saves first: the refused statement writes no event; sent again, it is saved once", async () => {
      const n = 1, tg = texting(n), web = h!.chat(`tok-${n}`);
      eq((await tg.say("hi")).status, 200);
      eq((await web.say("hi")).status, 200);
      const key = `kg-${n}-stated-a`, x = hold(keyIs(key));
      const said = tg.say(STATED, key);
      await x.reached;
      // Held at its save point: its evidence is computed but not written (trunk wrote it here, during the turn).
      eq(statedEvents(await consistent(n, "the statement held at its save")).length, 0, "no stated fact's event before the save");
      eq((await web.say("what can you do?")).status, 200);
      x.release();
      const r = await said;
      eq([r.status, r.body.error], [409, "revision_conflict"], `the refused save is a 409: ${JSON.stringify(r.body).slice(0, 300)}`);
      ok(/Send it again/.test(r.reply), `says plainly it was not saved: ${r.reply}`);
      eq(commits.filter((c) => keyIs(key)(c.body)).map((c) => c.rpc), ["career_host_commit_evidenced"], "the stating turn commits its evidence with its save");
      const s = await consistent(n, "after the refused statement");
      eq(statedEvents(s).length, 0, "a refused statement leaves no event (trunk: one per fact, naming facts no record holds)");
      const again = await tg.say(STATED);
      eq(again.status, 200, again.reply);
      const s2 = await consistent(n, "after the statement sent again");
      eq(statedEvents(s2).map((e) => e.kind).sort(), ["majors", "year"], "sent again: one event per stated fact");
      ok(s2.stated.filter((f) => f.confirmation_event_id).length >= 2, "the saved stated facts carry their confirmation ids");
    });

    await t.step("B: the evidenced commit fails for another reason: the turn is saved without the events, the statement unevidenced, the router's reply kept", async () => {
      const n = 2, tg = texting(n);
      eq((await tg.say("hi")).status, 200);
      const key = `kg-${n}-stated-b`;
      fails.push({ match: keyIs(key), hit: false });
      const r = await tg.say(STATED, key);
      eq(r.status, 200, `the turn is saved: ${JSON.stringify(r.body).slice(0, 300)}`);
      ok(/junior/i.test(r.reply), `the router's own reply: ${r.reply}`);
      ok(!/confirmed/i.test(r.reply), `never called confirmed: ${r.reply}`);
      eq(commits.filter((c) => keyIs(key)(c.body)).map((c) => c.rpc), ["career_host_commit_evidenced", "career_host_commit"], "the evidenced commit, then the plain one");
      const s = await consistent(n, "after the fallback");
      eq(statedEvents(s).length, 0, "no event");
      ok(s.stated.some((f) => f.kind === "year" && /junior/i.test(String(f.value))), `the statement is on the record: ${JSON.stringify(s.stated)}`);
      ok(s.stated.every((f) => !f.confirmation_event_id && !f.provenance), `unevidenced: no confirmation id or provenance: ${JSON.stringify(s.stated)}`);
    });

  } finally {
    globalThis.fetch = realFetch;
    h?.restore();
    for (const [k2, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k2) : Deno.env.set(k2, v);
    await pg.stop();
  }
} });
