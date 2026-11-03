// RESUME CONFIRMATION RACE through the REAL chat handler (handleChat, supabase/functions/agent-chat/handler-career.ts) on
// real Postgres with every migration (tests/flow/pg.ts) behind the PostgREST double, with the real supabase-js client.
// Found by flow-scenarios-onboarding-r2 (#317, "races"): the yes to a resume arriving at the same moment on two threads of
// one person (Telegram and the web chat). The Telegram turn wrote its fact_confirmed events (and, through them, the one
// resume record) DURING the turn, then its save was refused because the other thread saved first: career_resume_on_file
// read true while the profile still held drafts, and the resend wrote a second set of events. D-007: the evidence and the
// confirmation commit together (career_host_commit_evidenced, 20261030060000) or not at all.
//
// Deterministic interleavings: each turn is held at its save point (the commit RPC request, before it reaches the
// database) and released in a chosen order.
//   A  the web chat saves first; the texting thread's yes is refused   (loser = the thread that confirms)
//   B  the texting thread's yes saves first; the web chat is refused    (loser = the other thread)
//   C  the same texting thread twice (the turn gate's lease lapsed, so both loaded one revision), in both orders
//   D  A through the real channel runtime (chatThroughAgent, as Telegram's webhook calls it): the refused turn did nothing
//      before its save, so the runtime runs it once more and it is saved, once
// After every step: every fact_confirmed event names an entry a saved profile holds as confirmed, every confirmed entry
// has its event, one event per entry, and career_resume_on_file is true exactly when a profile holds confirmed entries.
// The loser's reply says plainly that it was not saved and to send it again; a resend is idempotent.
// No model, no network (CAREER_BRAIN, ANTHROPIC_API_KEY unset; CAREER_ACCOUNT_MEMORY off, the default).
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { chatThroughAgent } from "../../supabase/functions/_shared/channel_runtime.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const PASTE = `ok here is my resume:\n${RESUME}`, YES = "yes, that's my resume";
const PERSON = (n: number) => `7b0f8f8e-6a43-4a49-9d2c-00000000c7${String(n).padStart(2, "0")}`;
const ENV_OFF = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "CAREER_BRAIN_ROUTER_INTENTS", "CAREER_ACCOUNT_MEMORY", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL",
  "CAREER_REPLY_WRITER", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "TRAINEE_FILE_BASE_URL"];

Deno.test({ name: "a resume yes on two threads at once: the evidence and the confirmation are saved together or not at all, in every order", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) {
    if (CI) throw Error("the resume confirmation race needs Postgres 16 in CI");
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
    const people = [1, 2, 3, 4, 5];
    for (const n of people) {
      await pg.sql(`insert into auth.users (id, email) values ('${PERSON(n)}', 'race-${n}@example.test'); insert into public.profiles (id) values ('${PERSON(n)}');
        insert into public.career_watch_kv (user_id, key, value) values ('${PERSON(n)}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    h = await careerHandler(pg, Object.fromEntries(people.map((n) => [`tok-${n}`, PERSON(n)])));
    const handleChat = (await import("../../supabase/functions/agent-chat/handler-career.ts")).handleChat;

    // ------------------------------------------------------------------------------------------ the save point
    // A hold stops the first commit request whose body matches, before it reaches the database, until released.
    type Hold = { match: (body: string) => boolean; hit: boolean; reached: Promise<void>; arrive: () => void; go: Promise<void>; release: () => void };
    const holds: Hold[] = [];
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
      if (u.origin === SUPABASE_URL && u.pathname === "/functions/v1/agent-chat") return await handleChat(req);
      if (u.origin === SUPABASE_URL && u.pathname.startsWith("/rest/v1/rpc/career_host_commit")) {
        const body = await req.clone().text();
        const x = holds.find((y) => !y.hit && y.match(body));
        if (x) { x.hit = true; x.arrive(); await x.go; }
        commits.push({ rpc: u.pathname.split("/").pop()!, body });
      }
      if (u.origin === SUPABASE_URL) return await viaDouble(req);
      throw new TypeError(`network refused: ${u.host}`);
    }) as typeof fetch;

    // ------------------------------------------------------------------------------------------ two threads of one person
    // The texting thread: the request every texting channel's webhook sends (service key, as_user_id, a turn key; Telegram's).
    let k = 0;
    const texting = (n: number) => {
      let thread: string | null = null;
      return {
        thread: () => thread!,
        async say(message: string, key = `tg-${n}-${++k}`) {
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
    const threadIs = (tid: string) => (b: string) => b.includes(`"p_thread":"${tid}"`);

    // ------------------------------------------------------------------------------------------ the database, judged
    const q = async (s: string) => JSON.parse((await pg.sql(s)).trim() || "null");
    const look = async (n: number) => {
      const u = PERSON(n);
      // deno-lint-ignore no-explicit-any
      const held: any[] = await q(`select coalesce(json_agg(f), '[]'::json)::text from public.agent_flow_state s, jsonb_array_elements(coalesce(s.state#>'{career,stores,profile,facts}', '[]'::jsonb)) f
        where s.user_id = '${u}' and f->>'source' = 'resume-ingest'`);
      // deno-lint-ignore no-explicit-any
      const events: any[] = await q(`select coalesce(json_agg(json_build_object('cid', detail->>'confirmation_event_id', 'id', detail->>'id')), '[]'::json)::text from public.career_events
        where user_id = '${u}' and kind = 'fact_confirmed' and detail->>'via' = 'router: their yes to the resume entries shown to them'`);
      const onFile = (await pg.sql(`select public.career_resume_on_file('${u}')`)).trim() === "t";
      const record = await q(`select coalesce((select json_build_object('state', state, 'kind', kind, 'sha256', sha256, 'generation', generation)::text from public.career_resume_record where user_id = '${u}'), 'null')`);
      const confirmed = held.filter((f) => f.needs_confirmation === false && f.status === "confirmed");
      const drafts = held.filter((f) => f.needs_confirmation === true);
      return { held, events, onFile, record, confirmed, drafts };
    };
    // The invariant (D-007): evidence only with state, state only with evidence, one event per entry, on file only then.
    const consistent = async (n: number, when: string) => {
      const s = await look(n);
      const cids = new Set(s.confirmed.map((f) => f.confirmation_event_id));
      for (const e of s.events) ok(cids.has(e.cid), `${when}: an event (${e.cid}) names no entry a saved profile holds as confirmed (evidence without state)`);
      for (const f of s.confirmed) ok(s.events.some((e) => e.cid === f.confirmation_event_id), `${when}: a confirmed entry (${f.title ?? f.text}) has no event`);
      eq(new Set(s.events.map((e) => e.id)).size, s.events.length, `${when}: one event per entry, never a second set`);
      eq(s.onFile, s.confirmed.length > 0, `${when}: career_resume_on_file is ${s.onFile} with ${s.confirmed.length} confirmed entries and ${s.drafts.length} drafts`);
      eq(!!s.record && s.record.state === "confirmed", s.confirmed.length > 0, `${when}: the resume record (${JSON.stringify(s.record)}) and the profile disagree`);
      return s;
    };
    const honestLoser = (r: { status: number; reply: string; body: any }, who: string) => {
      eq(r.status, 409, `${who}: the refused save is a 409: ${JSON.stringify(r.body).slice(0, 300)}`);
      eq(r.body.error, "revision_conflict", who);
      ok(/^I couldn't save my answer to that message because your conversation moved on while I was answering it\./.test(r.reply), `${who}: says plainly it was not saved: ${r.reply}`);
      ok(/Send it again and I'll answer it\.$/.test(r.reply), `${who}: asks to send it again: ${r.reply}`);
      ok(/Nothing new was started, and nothing was sent or submitted\./.test(r.reply), `${who}: claims nothing it did not keep: ${r.reply}`);
      ok(!/confirmed/i.test(r.reply), `${who}: never says the resume is confirmed: ${r.reply}`);
      eq(r.body.turn_effects, false, `${who}: the refused turn wrote nothing before its save`);
    };
    // The resume pasted on the texting thread: drafts shown, nothing on file.
    const pasted = async (n: number) => {
      const tg = texting(n);
      const p = await tg.say(PASTE);
      eq([p.status, p.intent], [200, "career_resume_ingest"], p.reply);
      const s = await consistent(n, "after the paste");
      ok(s.drafts.length >= 3 && s.confirmed.length === 0 && !s.onFile, `drafts shown, nothing confirmed: ${s.drafts.length}/${s.confirmed.length}`);
      return tg;
    };
    // A confirmed resume, as one yes on its own leaves it (the reference every race is held to).
    const settled = async (n: number, tg: ReturnType<typeof texting>) => {
      const s = await consistent(n, "settled");
      ok(s.confirmed.length >= 3 && s.drafts.length === 0, `every entry confirmed: ${s.confirmed.length} confirmed, ${s.drafts.length} drafts`);
      eq(s.events.length, s.confirmed.length, "exactly one set of fact_confirmed events");
      const stored = await pg.sql(`select encode(sha256(convert_to(m.content, 'UTF8')), 'hex') from public.agent_messages m join public.agent_threads th on th.id = m.thread_id
        where th.user_id = '${PERSON(n)}' and m.role = 'user' and m.content like '%Alex Testcase%' order by m.id desc limit 1`);
      eq([s.record?.state, s.record?.kind, s.record?.generation, s.record?.sha256], ["confirmed", "paste", 1, stored], "the record is the pasted message, written once");
      // A resend is idempotent: no second set, the record unchanged.
      const again = await tg.say(YES);
      eq(again.status, 200, again.reply);
      const s2 = await consistent(n, "after a resend");
      eq(s2.events, s.events, "a resend writes no event");
      eq(s2.record, s.record, "a resend leaves the record");
      return s;
    };

    await t.step("A: the web chat saves first; the texting thread's yes is refused, writes nothing, and the resend saves it once", async () => {
      const n = 1, tg = await pasted(n), web = h!.chat(`tok-${n}`);
      eq((await web.say("hi")).status, 200);
      const key = `tg-${n}-yes-a`, x = hold(keyIs(key));
      const yes = tg.say(YES, key);
      await x.reached;
      // Held at its save point: its evidence is computed but not written (the bug wrote it here).
      eq((await consistent(n, "texting yes held at its save")).events.length, 0, "no event before the save");
      const w = await web.say(YES);
      eq(w.status, 200, w.reply);
      x.release();
      const r = await yes;
      honestLoser(r, "the texting thread's refused yes");
      eq(commits.filter((c) => keyIs(key)(c.body)).map((c) => c.rpc), ["career_host_commit_evidenced"], "the confirming turn commits its evidence with its save");
      const s = await consistent(n, "after the refused yes");
      eq([s.events.length, s.confirmed.length, s.onFile, s.record], [0, 0, false, null], "a refused yes leaves the drafts, no evidence, no record, nothing on file");
      ok(s.drafts.length >= 3, "the drafts wait for the resend");
      const again = await tg.say(YES);
      eq([again.status, again.intent, again.resultStatus], [200, "career_resume_ingest", "completed"], again.reply);
      await settled(n, tg);
    });

    await t.step("B: the texting thread's yes saves first; the web chat's turn is refused and changes nothing", async () => {
      const n = 2, tg = await pasted(n), web = h!.chat(`tok-${n}`);
      eq((await web.say("hi")).status, 200);
      const x = hold(threadIs(web.thread()!));
      const w = web.say(YES);
      await x.reached;
      const r = await tg.say(YES);
      eq([r.status, r.intent, r.resultStatus], [200, "career_resume_ingest", "completed"], r.reply);
      const before = await consistent(n, "after the texting yes");
      x.release();
      const lost = await w;
      honestLoser({ status: lost.status, reply: lost.reply, body: lost.body }, "the web chat's refused turn");
      const after = await consistent(n, "after the web chat's refused turn");
      eq(after.events, before.events, "the refused turn wrote no event");
      eq((await web.say(YES)).status, 200, "the web chat's resend is answered");
      eq((await consistent(n, "after the web chat's resend")).events, before.events, "and writes no event");
      await settled(n, tg);
    });

    for (const [n, order] of [[3, "first"], [4, "second"]] as const) {
      await t.step(`C: the same texting thread twice, both on one revision (the gate's lease lapsed); the ${order} yes saves`, async () => {
        const tg = await pasted(n);
        const k1 = `tg-${n}-yes-1`, k2 = `tg-${n}-yes-2`, x1 = hold(keyIs(k1)), x2 = hold(keyIs(k2));
        const y1 = tg.say(YES, k1);
        await x1.reached;
        // A turn that outruns its lease stops holding the line (career_turn_gate): the next turn of the thread goes ahead.
        await pg.sql(`update public.career_turn_gate set lease_until = now() - interval '1 second' where user_id = '${PERSON(n)}'`);
        const y2 = tg.say(YES, k2);
        await x2.reached;
        // Both computed their evidence for the same drafts; neither is written yet.
        eq((await consistent(n, "both yeses held at their save")).events.length, 0);
        const [win, lose] = order === "first" ? [[x1, y1], [x2, y2]] as const : [[x2, y2], [x1, y1]] as const;
        win[0].release();
        const w = await win[1];
        eq([w.status, w.intent, w.resultStatus], [200, "career_resume_ingest", "completed"], w.reply);
        const s = await consistent(n, "after the winner");
        ok(s.events.length >= 3 && s.drafts.length === 0, "the winner's entries confirmed with their events");
        lose[0].release();
        honestLoser(await lose[1], "the same thread's refused yes");
        const s2 = await consistent(n, "after the loser");
        eq(s2.events, s.events, "exactly one set of fact_confirmed events: the loser's evidence was never written");
        eq(commits.filter((c) => keyIs(k1)(c.body) || keyIs(k2)(c.body)).map((c) => c.rpc), ["career_host_commit_evidenced", "career_host_commit_evidenced"]);
        await settled(n, tg);
      });
    }

    await t.step("D: A through the real channel runtime (chatThroughAgent): the refused yes did nothing, so it is run once more and saved once", async () => {
      const n = 5, tg = await pasted(n), web = h!.chat(`tok-${n}`);
      eq((await web.say("hi")).status, 200);
      const key = `tg-${n}-yes-d`, x = hold(keyIs(key));
      const chat = chatThroughAgent(SUPABASE_URL, SERVICE_KEY, { channel: "telegram", retryDelayMs: 1 });
      const yes = chat({ userId: PERSON(n), threadId: tg.thread(), message: YES, turnKey: key });
      await x.reached;
      eq((await web.say(YES)).status, 200);
      x.release();
      const r = await yes;
      eq([r.status, (r as { resultStatus?: string }).resultStatus], [200, "completed"], `the runtime's second run is saved: ${JSON.stringify(r).slice(0, 300)}`);
      ok(!/couldn't save/.test(r.reply), `the person reads the answer, not a refusal: ${r.reply}`);
      eq(commits.filter((c) => keyIs(key)(c.body)).map((c) => c.rpc), ["career_host_commit_evidenced", "career_host_commit_evidenced"], "refused once, then saved, each with its evidence in the save");
      await settled(n, tg);
    });
  } finally {
    globalThis.fetch = realFetch;
    h?.restore();
    for (const [k2, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k2) : Deno.env.set(k2, v);
    await pg.stop();
  }
} });
