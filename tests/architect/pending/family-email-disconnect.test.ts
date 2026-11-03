// FAMILY EMAIL, pending on PR #196 (Google verification: "disconnect gmail" from the chat, and the migration
// 20261026200011_google_disconnect_erase.sql). Moves to tests/architect/ when #196 lands with the patch named below.
// Through the REAL handler on real Postgres, with a fake Google (Gmail reads and the revoke endpoint):
//   a person who connected Gmail and had their mail read (status events, a follow-up draft, the read cursor, an
//   assessment's deadline reminder queued in career_outbox) says "disconnect gmail". After it: no Google row, no Vault
//   entry, and nothing read from that Gmail is left, including the reminder not yet delivered (it repeats an email's
//   words and would otherwise still be texted after the person took Trainee's access away); the reply says only what the
//   rows show; "check my email" then reads nothing.
// On trunk: the chat has no disconnect (PR #196 adds it) and nothing erases mail rows on a grant's delete.
// On #196 as of 2026-10-26: everything but the undelivered reminder (patch: the erase also deletes the person's
// undelivered career_outbox rows keyed status:deadline:%).
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../../flow/pg.ts";
import { careerHandler, supabaseParity } from "../../flow/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ME = "7b0f8f8e-6a43-4a49-9d2c-0000000000d1";
const HOUR = 3_600_000, DAY = 86_400_000;
const READ_ONLY = "openid email https://www.googleapis.com/auth/gmail.readonly";

Deno.test({ name: "FAMILY EMAIL (pending #196): disconnect erases everything read from Gmail, the queued reminder too", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (Deno.env.get("CI") === "true") throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  const now = Date.now();
  const mails = [{ id: "d-acme-oa", at: now - 2 * HOUR, from: "Acme Talent <talent@acme.io>", subject: "Acme Data Analyst: online assessment",
    snippet: "Hi Pat, as the next step for the Data Analyst role, please complete the online assessment within 72 hours of receiving this email." }];
  const calls: string[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const google = async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url);
    calls.push(`${req.method} ${u.origin}${u.pathname}`);
    if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/revoke") return json({});
    if (u.hostname !== "gmail.googleapis.com" || req.headers.get("authorization") !== "Bearer AT-D") return json({ error: { code: 401 } }, 401);
    if (u.pathname === "/gmail/v1/users/me/messages") return json({ messages: mails.map((m) => ({ id: m.id })) });
    const m = mails.find((x) => u.pathname.endsWith(`/${x.id}`));
    return m ? json({ id: m.id, internalDate: String(m.at), snippet: m.snippet, payload: { headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject },
      { name: "Authentication-Results", value: "mx.google.com; dkim=pass header.i=@acme.io; spf=pass; dmarc=pass header.from=acme.io" }] } }) : json({}, 404);
  };
  const realFetch = globalThis.fetch;
  const before = Deno.env.get("CAREER_MAIL_TRACKING");
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    await supabaseParity(pg);
    const payload = JSON.stringify({ version: "1", user_id: ME, job_id: "gh:acme", company: "Acme", url: "https://acme.io/careers/1", fields: [], title: "Data Analyst" });
    const h = "a".repeat(64), h2 = "b".repeat(64);
    const p2 = JSON.stringify({ version: "1", user_id: ME, job_id: "gh:hooli", company: "Hooli", url: "https://hooli.com/careers/1", fields: [], title: "Data Analyst" });
    await pg.sql(`insert into auth.users (id, email) values ('${ME}', 'd@example.test'); insert into public.profiles (id) values ('${ME}');
      insert into public.career_watch_kv (user_id, key, value) values ('${ME}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
      set session_replication_role = replica;
      insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, created_at, updated_at) values
        ('${ME}', 'gh:acme', 'Acme', 'https://acme.io/careers/1', '${payload}'::jsonb, '${h}', '${h}', 'submitted_unconfirmed', now() - interval '5 days', now() - interval '5 days'),
        ('${ME}', 'gh:hooli', 'Hooli', 'https://hooli.com/careers/1', '${p2}'::jsonb, '${h2}', '${h2}', 'submitted_unconfirmed', now() - interval '16 days', now() - interval '16 days');
      set session_replication_role = origin;
      insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values ('${ME}', 'google_career', 'oauth_google_career_${ME}', 'pat@example.test', '${READ_ONLY}');
      select public.oauth_vault_store('oauth_google_career_${ME}', '{"access_token":"AT-D","refresh_token":"RT-D","expires_at":${now + 365 * DAY}}');`);
    globalThis.fetch = google as typeof fetch;
    Deno.env.set("CAREER_MAIL_TRACKING", "on");
    handler = await careerHandler(pg, { "tok-d": ME });
    const chat = handler.chat("tok-d");
    const q = (sql: string) => pg.sql(sql);
    const read = await chat.say("check my email");
    eq(read.resultStatus, "updated", read.reply);
    const mailRows = () => q(`select (select count(*) from public.career_mail_events where user_id = '${ME}') || '|' || (select count(*) from public.career_mail_drafts where user_id = '${ME}') || '|' ||
      (select count(*) from public.career_mail_cursors where user_id = '${ME}') || '|' || (select count(*) from public.career_outbox where user_id = '${ME}' and key like 'status:deadline:%' and delivered_at is null)`);
    eq(await mailRows(), "1|1|1|1", "before: an assessment event, Hooli's follow-up draft, the cursor and the deadline reminder");

    const off = await chat.say("disconnect gmail");
    eq(off.status, 200, off.reply);
    eq(off.intent, "career_google_disconnect", off.reply);
    assert(/Gmail is disconnected\. Google confirmed Trainee's access is revoked\. I deleted the stored access and the application updates I had read from your Gmail/.test(off.reply), off.reply);
    eq(await q(`select count(*) from public.user_oauth_connections where user_id = '${ME}'`), "0");
    eq(await q(`select count(*) from vault.secrets where name = 'oauth_google_career_${ME}'`), "0");
    eq(await mailRows(), "0|0|0|0", "after: nothing read from that Gmail is left, the undelivered reminder included");
    assert(calls.includes("POST https://oauth2.googleapis.com/revoke"), calls.join("\n"));

    const gmail = calls.filter((c) => c.includes("gmail.googleapis.com")).length;
    const again = await chat.say("check my email");
    eq(again.resultStatus, "NOT_WIRED", again.reply);
    eq(calls.filter((c) => c.includes("gmail.googleapis.com")).length, gmail, "no Gmail call after the disconnect");
  } finally {
    handler?.restore();
    globalThis.fetch = realFetch;
    if (before === undefined) Deno.env.delete("CAREER_MAIL_TRACKING"); else Deno.env.set("CAREER_MAIL_TRACKING", before);
    await pg.stop();
  }
} });
