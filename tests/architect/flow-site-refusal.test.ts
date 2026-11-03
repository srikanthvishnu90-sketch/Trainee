// OWNER RULE on the live path (handler-career.ts handleChat over real Postgres, tests/flow/handler.ts; no network, no
// model): an Indeed or Handshake link or ask is declined plainly, naming the site, before any apply, link-read or batch
// turn. Nothing is queued and no batch is opened, so the bare "yes" that follows is not answered by one. Before this
// (trunk 2026-10-28) an indeed.com or joinhandshake.com link opened a career_batch_apply batch ("a company — a role:
// Trainee can't reach this employer's application site") that then answered every later "yes" with "Nothing was
// submitted — this batch is not ready".
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const PERSON = "7b0f8f8e-6a43-4a49-9d2c-0000000051e1";

Deno.test({
  name: "Indeed and Handshake links and asks are declined before any batch; a later 'yes' is not taken by one",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const unset = ["CAREER_BRAIN", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING", "CAREER_ACCOUNT_MEMORY", "ANTHROPIC_API_KEY"];
    const saved = Object.fromEntries(unset.map((k) => [k, Deno.env.get(k)]));
    for (const k of unset) Deno.env.delete(k);
    // D-036: CAREER_MAIL_TRACKING is a release flag (on when unset): every mail path stays off only with "off".
    Deno.env.set("CAREER_MAIL_TRACKING", "off");
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch;
    try {
      await supabaseParity(pg);
      await pg.sql(`insert into auth.users (id, email) values ('${PERSON}', 'site@example.test'); insert into public.profiles (id) values ('${PERSON}');
        insert into public.career_watch_kv (user_id, key, value) values ('${PERSON}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
      h = await careerHandler(pg, { "tok-site": PERSON });
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host}`); throw new TypeError(`network refused: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;
      const chat: Chat = h.chat("tok-site");
      const batchState = async () => await pg.sql(`select coalesce(string_agg(coalesce(state#>>'{career,stores,batchApplyState}', ''), ''), '') from public.agent_flow_state where user_id = '${PERSON}'`);
      const queued = async () => Number(await pg.sql(`select (select count(*) from public.career_apply_wanted where user_id = '${PERSON}') + (select count(*) from public.career_apply_jobs where user_id = '${PERSON}') + (select count(*) from public.career_apply_cards where user_id = '${PERSON}')`));
      for (const [m, site] of [["apply to this job for me https://www.indeed.com/viewjob?jk=abc", "Indeed"], ["apply me on handshake https://app.joinhandshake.com/jobs/12345", "Handshake"],
        ["apply to https://uk.indeed.com/viewjob?jk=9", "Indeed"], ["apply to the Data Analyst job at Contoso on Indeed", "Indeed"], ["apply to jobs on Handshake for me", "Handshake"],
        ["message recruiters on Handshake for me", "Handshake"]]) {
        const r = await chat.say(m);
        eq(r.status, 200, `${m}: ${r.reply}`);
        eq([r.intent, r.resultStatus], ["career_site_refused", "refused"], `${m}: ${r.reply}`);
        assert(r.reply.includes(`Nothing was sent or done on ${site}.`) && !/\byet\b/i.test(r.reply), `${m}: ${r.reply}`);
        eq(await batchState(), "", `${m}: no batch opened`);
        eq(await queued(), 0, `${m}: nothing queued or carded`);
        const yes = await chat.say("yes");
        eq(yes.status, 200, yes.reply);
        assert(yes.intent !== "career_batch_apply" && !/this batch is not ready|Nothing was submitted/i.test(yes.reply), `the "yes" after "${m}" is not a batch's: ${yes.intent}: ${yes.reply}`);
      }
      eq(outbound, [], "no request left the machine");
    } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await pg.stop();
    }
  },
});
