// F09 round 5, on the REAL path: the production agent-chat handler (handler-career.ts handleChat) on a real Postgres
// (tests/flow/handler.ts), the real card turn and every other yes/no consumer in their real order. A tap on the screen's Yes / No
// buttons arrives as body.screen_tap = { qid, answer } (what channel_inbound sends for callback data scr:<qid>:yes|no):
//   * a tap on the open sponsorship question records it (and no consumer replies "reply directly to the card");
//   * a tap after that question closed records nothing and approves nothing;
//   * a tap while a card is waiting for approval approves nothing (the card's own typed yes still works afterwards).
// Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/screen-tap-handler-pg.test.ts
import { CareerProfile } from "../../supabase/functions/_shared/router_core.career.js";
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { careerHandler, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";
import { TAP_STALE_REPLY } from "../../supabase/functions/_shared/career_apply_screen_answer.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const RESUME_FILE = "%PDF-1.4\n% TEST screen-tap resume\n%%EOF\n";
const RESUME_SHA = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RESUME_FILE))), (b) => b.toString(16).padStart(2, "0")).join("");
// The person's confirmed home, as the account record holds it (real CareerProfile shape): the one fact the relocation question needs.
function homeProfile() {
  const p: any = CareerProfile.createProfile({});
  const f = CareerProfile.addFact(p, { kind: "location", text: "Lives in Chicago, IL", needs_confirmation: true, status: "draft" });
  CareerProfile.confirmFact(p, f.id);
  return p;
}
const sqlLit = (v: string) => `$j$${v}$j$::jsonb`;
const ID = "a13ae586-f4cb-4385-8822-c42b9b54ed75", LINK = `https://jobs.ashbyhq.com/ramp/${ID}`;
const PEOPLE: Record<string, string> = { "tok-st-1": "7b0f8f8e-6a43-4a49-9d2c-00000000e001", "tok-st-2": "7b0f8f8e-6a43-4a49-9d2c-00000000e002", "tok-st-3": "7b0f8f8e-6a43-4a49-9d2c-00000000e003", "tok-st-4": "7b0f8f8e-6a43-4a49-9d2c-00000000e004" };

Deno.test({
  name: "screen Yes / No tap through the production handler: records on the open question; stale or card-pending approves nothing",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) {
      if (CI) throw Error("the screen tap handler test needs Postgres 16 binaries in CI");
      console.log("NOT_RUN locally: no Postgres binaries");
      return;
    }
    Deno.env.set("CAREER_ACCOUNT_MEMORY", "on");
    const pg = await startPg();
    const ats = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/posting-api/job-board/ramp") {
        return Response.json({ jobs: [{ id: ID, title: "Analyst (TEST)", location: "New York, NY", jobUrl: LINK, applyUrl: `${LINK}/application`, publishedAt: new Date().toISOString(),
          descriptionPlain: "TEST synthetic posting. SQL and Python. This is an in-office role." }] });
      }
      return new Response("not found", { status: 404 });
    });
    const origin = `http://127.0.0.1:${(ats.addr as Deno.NetAddr).port}`;
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    try {
      await supabaseParity(pg);
      for (const id of Object.values(PEOPLE)) {
        await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
          insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', ${sqlLit(JSON.stringify({ epoch: 0, version: 0, paused: false, memory: { profile: homeProfile() } }))});
          ${confirmedResumeSql(id, RESUME_FILE)}`);
      }
      h = await careerHandler(pg, PEOPLE);
      const double = globalThis.fetch;
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.origin === new URL(SUPABASE_URL).origin || u.hostname === "127.0.0.1") return double(req);
        if (u.hostname === "api.ashbyhq.com") return double(new Request(`${origin}${u.pathname}${u.search}`, req));
        return Promise.reject(new Error(`no real host: ${u.href}`));
      }) as typeof fetch;
      const P1 = PEOPLE["tok-st-1"], P2 = PEOPLE["tok-st-2"];
      const wanted = async (p: string) => await pg.sql(`select count(*) from public.career_apply_wanted where user_id = '${p}'`);

      let lastQid = "";
      const chat1 = h.chat("tok-st-1");
      await t.step("apply to an in-office posting from another city: the screen asks ONE yes/no question (relocation); a Yes tap on it records it and queues the posting", async () => {
        const r = await chat1.say(`apply me to this: ${LINK}`);
        const ask = r.body?.meta?.screen_ask as { fact: string; question: string }[];
        eq(ask?.map((x) => x.fact), ["relocation"], r.reply);
        eq(ask[0].question, "Would you relocate for this role? Reply yes or no.");
        const qid = String(r.body.meta.screen_qid);
        assert(/^[0-9a-f]{8}$/.test(qid), JSON.stringify(r.body.meta));
        eq(r.body.meta.screen_buttons, ["Yes", "No"]);
        eq(await wanted(P1), "0");
        const t1 = await chat1.say("yes", { screen_tap: { qid, answer: "yes" } });
        assert(!/reply directly to the card/i.test(t1.reply), t1.reply);
        assert(/^Saved \(/.test(t1.reply), t1.reply);
        lastQid = qid;
        eq(await wanted(P1), "1", t1.reply);
      });

      await t.step("the same tap after the question closed: nothing recorded, nothing else queued or approved, and no question is invented", async () => {
        const r = await chat1.say("no", { screen_tap: { qid: lastQid, answer: "no" } });
        assert(r.reply.startsWith(TAP_STALE_REPLY), r.reply);
        assert(!r.body?.meta?.screen_ask, "no question was open, none is carried");
        eq(await wanted(P1), "1");
        eq(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${P1}'`), "0");
      });

      for (const mode of ["tap", "typed"] as const) {
        await t.step(`a stale tap on question 1 does not kill the open question 2 (${mode} answer afterwards is recorded)`, async () => {
          const tok = mode === "tap" ? "tok-st-3" : "tok-st-4", P = PEOPLE[tok];
          const chat = h!.chat(tok);
          const q1 = await chat.say(`apply me to this: ${LINK}`);
          const qid1 = String(q1.body?.meta?.screen_qid);
          eq((q1.body?.meta?.screen_ask as any[])?.map((x) => x.fact), ["relocation"], q1.reply);
          // a non-answer asks the same question again, with a NEW id: question 2
          const q2 = await chat.say("hmm let me think about it");
          const qid2 = String(q2.body?.meta?.screen_qid);
          assert(/^[0-9a-f]{8}$/.test(qid2) && qid2 !== qid1, `question 2 has its own id: ${JSON.stringify(q2.body?.meta)}`);
          // the old button of question 1: a notice, and question 2 stays open with its buttons
          const stale = await chat.say("yes", { screen_tap: { qid: qid1, answer: "yes" } });
          assert(stale.reply.startsWith(TAP_STALE_REPLY), stale.reply);
          eq(stale.body?.meta?.screen_qid, qid2, "the stale notice carries question 2's id forward");
          eq(stale.body?.meta?.screen_buttons, ["Yes", "No"]);
          eq((stale.body?.meta?.screen_ask as any[])?.map((x) => x.fact), ["relocation"]);
          assert(((stale.body?.meta?.screen_held as any[]) ?? []).length === 1, "the held posting is carried forward");
          eq(await wanted(P), "0", "the stale tap recorded nothing");
          const done = mode === "tap" ? await chat.say("yes", { screen_tap: { qid: qid2, answer: "yes" } }) : await chat.say("yes");
          assert(/^Saved \(/.test(done.reply), done.reply);
          eq(await wanted(P), "1", done.reply);
        });
      }

      await t.step("a tap with a card waiting for approval approves nothing; the card's own typed yes still works", async () => {
        const chat = h!.chat("tok-st-2");
        for (let i = 1; i <= 2; i++) {
          const payload = { version: 1, user_id: P2, job_id: `TEST-ST-${i}`, company: `Tap Employer ${i}`, url: `https://jobs.lever.co/tap${i}/${i}`,
            fields: [{ name: "email", label: "Email", value: "t@example.test", factId: "TEST-1" }], privacy_epoch: 0, account_version: 0, expires_at: new Date(Date.now() + 3600_000).toISOString(), resume_sha256: RESUME_SHA };
          const r = await pg.asPerson(P2).rpc("career_apply_prepare_own", { p_payload: payload, p_card_lines: [`Tap Employer ${i}: TEST Analyst`, "Email: t@example.test", `Sends to https://jobs.lever.co/tap${i}/${i}`] });
          eq(r.error, null, JSON.stringify(r.error));
        }
        const shown = await chat.say("show my applications");
        eq([shown.intent, shown.resultStatus], ["career_apply_card", "shown"], shown.reply);
        for (const answer of ["yes", "no"]) {
          const tap = await chat.say(answer, { screen_tap: { qid: "deadbeef", answer } });
          eq(tap.reply, TAP_STALE_REPLY);
          assert(tap.intent !== "career_apply_card_answer", `${tap.intent}: ${tap.reply}`);
        }
        eq(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${P2}'`), "0", "nothing approved by a tap");
        eq(await pg.sql(`select string_agg(state, ',') from public.career_apply_cards where user_id = '${P2}'`), "open", "the card is still waiting");
        // (the stale notice is now the thread's last word, so the card is shown again before its own typed yes)
        await chat.say("show my applications");
        const typed = await chat.say("yes");
        eq([typed.intent, typed.resultStatus], ["career_apply_card_answer", "answered"], typed.reply);
        eq(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${P2}'`), "2", "the typed yes is the approval, as before");
      });
    } finally {
      Deno.env.delete("CAREER_ACCOUNT_MEMORY");
      h?.restore();
      await ats.shutdown();
      await pg.stop();
    }
  },
});
