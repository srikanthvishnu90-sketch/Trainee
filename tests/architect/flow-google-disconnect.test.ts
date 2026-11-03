// Google verification (2026-10-26, review of PR #196, blocker 2): "disconnect gmail" in the chat really disconnects. The
// REAL handler (handleChat, agent-chat/handler-career.ts) on real Postgres (CI's migration order, so 20261012060000 and
// 20261026200011 are there) with the real supabase-js client; the only seams are the HTTP hop to the Supabase project
// (tests/flow/postgrest.ts) and Google's revoke endpoint (a fake that records every request). Outcome checks only:
//   (1) the person's career grant and legacy grant are each revoked at Google with their own refresh token; their
//       connection rows, their Vault tokens and every mail-tracking row read from that Gmail are gone; another person's
//       grant, tokens and mail rows are untouched; the reply says exactly that.
//   (2) Google unreachable: the tokens and rows are still deleted, and the reply says Google didn't confirm and where to
//       remove access by hand; never "confirmed".
//   (3) Asked again with nothing connected: nothing is sent to Google, and the reply says there was nothing to disconnect.
// The same handler answers web, Telegram and SMS (the channel bridges call agent-chat), so this holds on every channel.
// Run: the gate runs it with CI=true. Where esm.sh is unreachable, add --import-map=tests/flow/supabase-npm.json.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, supabaseParity } from "../flow/handler.ts";
import { GOOGLE_REVOKE } from "../../supabase/functions/_shared/google_disconnect.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { supabaseMailStore } from "../../supabase/functions/_shared/career_mail_store.ts";
import { memoryAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { runMail } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { SERVICE_KEY, SUPABASE_URL } from "../flow/handler.ts";
const MIGRATION = Deno.readTextFileSync(new URL("../../supabase/migrations/20261026200011_google_disconnect_erase.sql", import.meta.url));

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const PEOPLE: Record<string, string> = {
  "tok-g1": "7b0f8f8e-6a43-4a49-9d2c-0000000004c1",
  "tok-g2": "7b0f8f8e-6a43-4a49-9d2c-0000000004c2",
  "tok-g3": "7b0f8f8e-6a43-4a49-9d2c-0000000004c3",
  "tok-g4": "7b0f8f8e-6a43-4a49-9d2c-0000000004c4",
  "tok-g5": "7b0f8f8e-6a43-4a49-9d2c-0000000004c5",
  "tok-g6": "7b0f8f8e-6a43-4a49-9d2c-0000000004c6",
  "tok-g7": "7b0f8f8e-6a43-4a49-9d2c-0000000004c7",
  "tok-g8": "7b0f8f8e-6a43-4a49-9d2c-0000000004c8",
  "tok-g9": "7b0f8f8e-6a43-4a49-9d2c-0000000004c9",
  "tok-ga": "7b0f8f8e-6a43-4a49-9d2c-0000000004ca",
};
const G1 = PEOPLE["tok-g1"], G2 = PEOPLE["tok-g2"], G3 = PEOPLE["tok-g3"], G4 = PEOPLE["tok-g4"], G5 = PEOPLE["tok-g5"], G6 = PEOPLE["tok-g6"], G7 = PEOPLE["tok-g7"], G8 = PEOPLE["tok-g8"], G9 = PEOPLE["tok-g9"], GA = PEOPLE["tok-ga"];

// Google's revoke endpoint, faked: every request recorded; the answer set per test.
const google = { calls: [] as string[], answer: 200 as number | "down" };
let pg: Pg | null = null, handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
async function world() {
  if (handler) return { pg: pg!, handler };
  pg = await startPg();
  await supabaseParity(pg);
  for (const id of Object.values(PEOPLE)) {
    await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
      insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
  }
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as string, init);
    if (req.url !== GOOGLE_REVOKE) return await real(input as any, init);
    google.calls.push(await req.text());
    if (google.answer === "down") throw new TypeError("connection refused");
    return new Response(google.answer === 200 ? "" : JSON.stringify({ error: "invalid_token" }), { status: google.answer });
  }) as typeof fetch;
  handler = await careerHandler(pg, PEOPLE); // the PostgREST double passes every other host to the fake above
  return { pg, handler };
}
const skip = () => {
  if (pgBinDir()) return false;
  if (CI) throw Error("the Google disconnect flow needs Postgres 16 in CI");
  console.log("NOT_RUN locally: no Postgres binaries");
  return true;
};
const n = async (q: string) => Number(await pg!.sql(q));
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
// A person with both Google grants (tokens in the Vault, rows as gmail-oauth writes them) and mail read from that Gmail.
async function connected(id: string, tag: string) {
  await pg!.sql(`select public.oauth_vault_store('oauth_google_career_${id}', ${lit(JSON.stringify({ access_token: `at-c-${tag}`, refresh_token: `rt-c-${tag}` }))});
    select public.oauth_vault_store('oauth_gmail_${id}', ${lit(JSON.stringify({ access_token: `at-l-${tag}`, refresh_token: `rt-l-${tag}` }))});
    insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values
      ('${id}', 'google_career', 'oauth_google_career_${id}', '${tag}@example.test', 'openid email https://www.googleapis.com/auth/gmail.readonly'),
      ('${id}', 'gmail', 'oauth_gmail_${id}', '${tag}@example.test', 'https://www.googleapis.com/auth/gmail.readonly');
    insert into public.career_mail_events (user_id, application_ref, kind, company, stage, evidence, message_hash, mail_at)
      values ('${id}', 'mail:acme', 'received', 'Acme', 'Submitted', 'Acme: we received your application', repeat('${tag.slice(-1)}', 64), now());
    insert into public.career_mail_drafts (user_id, draft_key, application_ref, kind, company, text, basis)
      values ('${id}', 'followup:mail:acme', 'mail:acme', 'followup', 'Acme', 'Hi, following up.', '14 days since received');
    insert into public.career_mail_cursors (user_id, read_through) values ('${id}', now());`);
}
const left = async (id: string) => ({
  rows: await n(`select count(*) from public.user_oauth_connections where user_id = '${id}'`),
  tokens: await n(`select count(*) from vault.secrets where name in ('oauth_google_career_${id}', 'oauth_gmail_${id}')`),
  mail: await n(`select (select count(*) from public.career_mail_events where user_id = '${id}') + (select count(*) from public.career_mail_drafts where user_id = '${id}') + (select count(*) from public.career_mail_cursors where user_id = '${id}')`),
});

Deno.test({ name: "google disconnect (1): \"disconnect gmail\" revokes both grants at Google and deletes the tokens, rows and mail rows; nobody else's", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  await world();
  await connected(G1, "g1"); await connected(G2, "g2");
  eq(await left(G1), { rows: 2, tokens: 2, mail: 3 }, "before: both grants, both tokens, three mail rows");
  google.calls.length = 0; google.answer = 200;
  const r = await handler!.chat("tok-g1").say("disconnect gmail");
  eq(r.status, 200, r.reply);
  eq(google.calls.sort(), ["token=rt-c-g1", "token=rt-l-g1"], "each grant's own refresh token went to Google's revoke endpoint, once");
  eq(await left(G1), { rows: 0, tokens: 0, mail: 0 }, "after: no row, no token, no mail row");
  eq(await left(G2), { rows: 2, tokens: 2, mail: 3 }, "another person's grant, tokens and mail rows are untouched");
  eq([r.intent, r.resultStatus], ["career_google_disconnect", "completed"], "the disconnect turn answered, and its result is recorded as completed");
  assert(/^Gmail is disconnected\. Google confirmed Trainee's access is revoked\. I deleted the stored access and the application updates I had read from your Gmail\./.test(r.reply), r.reply);
}});

Deno.test({ name: "google disconnect (2): Google unreachable: still deleted, and the reply says Google didn't confirm", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  await world();
  await connected(G3, "g3");
  google.calls.length = 0; google.answer = "down";
  const r = await handler!.chat("tok-g3").say("Disconnect my Google account");
  eq(r.status, 200, r.reply);
  eq(google.calls.length, 12, "3 tries for each of 2 tokens, for each of the 2 grants");
  eq(await left(G3), { rows: 0, tokens: 0, mail: 0 }, "the person asked to disconnect: everything is deleted anyway");
  assert(/Google didn't confirm that Trainee's access is revoked, so please remove Trainee at myaccount\.google\.com\/permissions/.test(r.reply), r.reply);
  assert(!/Google confirmed/.test(r.reply), "never claims a revoke Google didn't confirm");
  eq(r.resultStatus, "completed", "everything was deleted, so completed");
}});

Deno.test({ name: "google disconnect (3): nothing connected: nothing sent to Google, and said so", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  await world();
  google.calls.length = 0; google.answer = 200;
  const r = await handler!.chat("tok-g1").say("disconnect gmail");
  eq(google.calls, [], "no request to Google");
  eq(r.reply, "No Google account is connected to Trainee, so there was nothing to disconnect.", r.reply);
  eq(r.resultStatus, "nothing", "and the turn's result is 'nothing'");
  eq(await left(G2), { rows: 2, tokens: 2, mail: 3 }, "still nobody else's rows");
}});

// ---- review of #196, blocker 3: the read-back guards are what makes the reply true, on a real database ------------------
const reconnectTrigger = () => pg!.sql(MIGRATION); // idempotent: recreates the erase trigger a test dropped
const said = (r: { reply: string }) => r.reply;

Deno.test({ name: "google disconnect (4): code deployed before migration 20261026200011 (no trigger): the disconnect still deletes the mail rows, and the reply is true", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  await world();
  await connected(G4, "g4");
  await pg!.sql(`drop trigger user_oauth_connections_google_erase on public.user_oauth_connections;`);
  try {
    google.calls.length = 0; google.answer = 200;
    const r = await handler!.chat("tok-g4").say("disconnect gmail");
    eq(await left(G4), { rows: 0, tokens: 0, mail: 0 }, "no trigger, yet the mail events, drafts and cursor are gone");
    eq(r.resultStatus, "completed", r.reply);
    assert(/I deleted the stored access and the application updates I had read from your Gmail\./.test(r.reply), r.reply);
  } finally { await reconnectTrigger(); }
}});

// A delete that reports success and removes nothing (a policy or trigger swallowing it): the read-back must catch it, per table.
for (const [table, gid, tok] of [["career_mail_events", G5, "tok-g5"], ["career_mail_drafts", G6, "tok-g6"], ["career_mail_cursors", G7, "tok-g7"]] as const) {
  Deno.test({ name: `google disconnect (5): ${table} rows that survive the delete are caught by the read-back: not 'I deleted', status failed; saying it again cleans up`, sanitizeResources: false, sanitizeOps: false, async fn() {
    if (skip()) return;
    await world();
    await connected(gid, tok.slice(-2));
    await pg!.sql(`create or replace function public.gv_block_delete() returns trigger language plpgsql as $$ begin return null; end $$;
      create trigger gv_block before delete on public.${table} for each row execute function public.gv_block_delete();`);
    const before = await n(`select count(*) from public.${table} where user_id = '${gid}'`);
    eq(before, 1, "the table has the person's row");
    try {
      google.calls.length = 0; google.answer = 200;
      const r = await handler!.chat(tok).say("disconnect gmail");
      eq(await n(`select count(*) from public.${table} where user_id = '${gid}'`), 1, "the row survived (the blocker works)");
      eq(r.resultStatus, "failed", `the turn's result is failed: ${r.reply}`);
      assert(/^I couldn't finish disconnecting Gmail: I wasn't able to delete the application updates, drafts and read time saved from your Gmail\./.test(r.reply), said(r));
      assert(!/I deleted|Gmail is disconnected/.test(r.reply), `a failed disconnect never says it deleted: ${r.reply}`);
      eq([(await left(gid)).rows, (await left(gid)).tokens], [0, 0], "the grant and tokens are gone though");
    } finally { await pg!.sql(`drop trigger gv_block on public.${table}; drop function public.gv_block_delete();`); }
    // The grant is gone and stray rows remain: the person says it again, and that deletes them.
    google.calls.length = 0;
    const again = await handler!.chat(tok).say("disconnect gmail");
    eq(google.calls, [], "nothing to revoke the second time");
    eq(await left(gid), { rows: 0, tokens: 0, mail: 0 }, "the stray rows are deleted");
    eq(again.resultStatus, "completed", again.reply);
    assert(/^No Google account is connected to Trainee, but I deleted the application updates, drafts and read time still saved from an earlier connection\./.test(again.reply), again.reply);
  }});
}

Deno.test({ name: "google disconnect (6): the Vault read-back failing is 'not known to be deleted': failed, never 'I deleted'", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  await world();
  await connected(GA, "ga");
  const def = await pg!.sql(`select pg_get_functiondef('public.oauth_vault_read(text)'::regprocedure)`);
  // The Vault answers an error for a secret that is not there (as it would if it were down once the delete had gone through).
  await pg!.sql(`create or replace function public.oauth_vault_read(p_name text) returns text language plpgsql security definer set search_path = vault, public as $$
    declare v_secret text; begin
      select decrypted_secret into v_secret from vault.decrypted_secrets where name = p_name;
      if v_secret is null then raise exception 'vault unavailable'; end if;
      return v_secret; end $$;`);
  try {
    google.calls.length = 0; google.answer = 200;
    const r = await handler!.chat("tok-ga").say("disconnect gmail");
    eq(r.resultStatus, "failed", r.reply);
    assert(/^I couldn't finish disconnecting Gmail: I wasn't able to check that everything was deleted\./.test(r.reply), r.reply);
    assert(!/I deleted|Gmail is disconnected/.test(r.reply), r.reply);
  } finally { await pg!.sql(def); }
}});

// ---- review of #196, non-blocking: a mail check running while the person disconnects, on real Postgres ---------------
Deno.test({ name: "google disconnect (7): a mail check that is reading Gmail when the person says 'disconnect gmail' saves nothing from it; another person's check is saved", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (skip()) return;
  await world();
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  for (const [id, tag] of [[G8, "g8"], [G9, "g9"]] as const) {
    await pg!.sql(`select public.oauth_vault_store('oauth_google_career_${id}', ${lit(JSON.stringify({ access_token: `at-${tag}`, refresh_token: `rt-${tag}` }))});
      insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values
        ('${id}', 'google_career', 'oauth_google_career_${id}', '${tag}@example.test', 'openid email https://www.googleapis.com/auth/gmail.readonly');`);
  }
  const NOW = Date.parse("2026-10-20T15:00:00Z");
  const AUTH = ["mx.google.com; dkim=pass header.i=@greenhouse.io header.s=s1; spf=pass smtp.mailfrom=greenhouse.io; dmarc=pass (p=REJECT) header.from=greenhouse.io"];
  const mail = { hash: "ab".repeat(32), from: "Asana <no-reply@greenhouse.io>", subject: "Your Asana application", snippet: "Unfortunately, we have decided not to move forward with your application.", date: new Date(NOW - 120000).toISOString(), auth: AUTH };
  const app = { ref: "track:a1", company: "Asana", role: "Account Manager", stage: "Submitted", source: "tracker" as const, applied_at: new Date(NOW - 864e6).toISOString(), events: [] };
  const mine = (uid: string) => ({ ...supabaseMailStore(admin), people: async () => [{ user_id: uid, read_through: new Date(NOW - 3600000).toISOString() }], applications: async () => [app] });
  const rows = async (id: string) => ({
    events: await n(`select count(*) from public.career_mail_events where user_id = '${id}'`),
    drafts: await n(`select count(*) from public.career_mail_drafts where user_id = '${id}'`),
    cursors: await n(`select count(*) from public.career_mail_cursors where user_id = '${id}'`),
  });
  google.calls.length = 0; google.answer = 200;
  // G8 stays connected: the run saves the event and the cursor, and queues the text.
  const box8 = memoryAlertStore();
  await runMail({ outbox: box8, now: NOW, store: mine(G8), read: async () => ({ status: "ok", mails: [mail], readThrough: NOW, listed: 1 }) });
  eq(await rows(G8), { events: 1, drafts: 0, cursors: 1 }, "control: a connected person's check is saved");
  eq(box8.dump().outbox.map((o: any) => o.kind), ["status"], "and told");
  // G9 disconnects (the real chat turn) while their Gmail is being read.
  const box9 = memoryAlertStore();
  const stats = await runMail({
    outbox: box9, now: NOW, store: mine(G9),
    read: async () => { const r = await handler!.chat("tok-g9").say("disconnect gmail"); eq(r.status, 200, r.reply); return { status: "ok", mails: [mail], readThrough: NOW, listed: 1 }; },
  });
  eq(await left(G9), { rows: 0, tokens: 0, mail: 0 }, "G9 is disconnected and nothing from the check was saved after it");
  eq([box9.dump().outbox.length, stats.disconnected], [0, 1], "no text queued for G9, and the run counted the skip");
  eq(await rows(G8), { events: 1, drafts: 0, cursors: 1 }, "G8 untouched");
}});
