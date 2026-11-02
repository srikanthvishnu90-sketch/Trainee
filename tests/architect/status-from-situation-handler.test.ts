// STATUS FROM THE SITUATION at the REAL handler (handleChat, Postgres): the situation the handler reads at the top of the turn
// reaches the router's status answer (ctx.situation), so "whats happening with my applications" names the apply queue's rows,
// says "sent" only from the queue's send record (a confirmation needs the employer's matched email, so it is not claimed), and keeps the tracker in the person's own words. Local:
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/status-from-situation-handler.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, supabaseParity } from "../flow/handler.ts";

const CI = Deno.env.get("CI") === "true";
const PERSON = "7b0f8f8e-6a43-4a49-9d2c-0000000f3971";
const HASH = "a".repeat(64), HASH2 = "b".repeat(64);

Deno.test({ name: "status at the real handler: the queue's rows, sent only from a send record", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  const saved = Deno.env.get("CAREER_BRAIN");
  try {
    await supabaseParity(pg);
    Deno.env.set("CAREER_BRAIN", "router");
    await pg.sql(`insert into auth.users (id, email) values ('${PERSON}', '${PERSON}@example.test'); insert into public.profiles (id) values ('${PERSON}');
      insert into public.career_watch_kv (user_id, key, value) values ('${PERSON}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
      insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, confirmation_id, created_at, updated_at)
        values ('${PERSON}', 'greenhouse:notion:7007007', 'Notion', 'https://job-boards.greenhouse.io/notion/jobs/7007007', '{}', '${HASH}', '${HASH}', 'submitted_unconfirmed', null, now() - interval '2 days', now() - interval '2 days'),
               ('${PERSON}', 'greenhouse:brex:7005005', 'Brex', 'https://job-boards.greenhouse.io/brex/jobs/7005005', '{}', '${HASH2}', '${HASH2}', 'needs_user', null, now() - interval '1 hour', now() - interval '1 hour');
      update public.career_apply_jobs set reason = 'email_code' where user_id = '${PERSON}' and company = 'Brex';`);
    handler = await careerHandler(pg, { "tok-397": PERSON });
    const chat = handler.chat("tok-397");
    const r = await chat.say("whats happening with my applications");
    assertNode.equal(r.status, 200, r.reply);
    assertNode.equal(r.intent, "tracking_status", `${r.intent}: ${r.reply}`);
    assertNode.match(r.reply, /I sent 1 application in the last two weeks; 1 more is not sent yet\./, r.reply);
    assertNode.match(r.reply, /Notion: sent, not confirmed by Notion yet\./, r.reply);
    assertNode.match(r.reply, /Brex: not sent yet; the employer emailed a code\./, r.reply);
    assertNode.doesNotMatch(r.reply, /Brex: sent|tracker is empty/i, r.reply);
  } finally {
    if (saved === undefined) Deno.env.delete("CAREER_BRAIN"); else Deno.env.set("CAREER_BRAIN", saved);
    handler?.restore();
    await pg.stop();
  }
} });
