// Task 3 (2026-10-28): the connector framework's guards, written first and seen failing before each guard existed
// (PR body: the first run). Each test names the guard it pins; removing the guard makes it fail.
//   reply guard   say(): no token-shaped string and no internal status code ever reaches the person; the link's own
//                 one-time token is the only token-like thing a reply may carry.
//   token guard   the registry's token getter reads only the person's own Vault entry (oauth_<provider>_<uid>); a
//                 connection row naming any other entry is no connection, and that entry is never read.
//   erase guard   a disconnect says only what the read-back shows: a token that could not be deleted, or an approved email
//                 still waiting to go after the disconnect, is a failure said plainly, never "disconnected".
// Real Postgres 16 with every migration for the erase guard (tests/flow/pg.ts); Google faked at the HTTP boundary.
// Run: deno test -A --no-check tests/architect/connector-guards.test.ts
// deno-lint-ignore-file no-explicit-any
import { pgBinDir, startPg } from "../flow/pg.ts";
import { admin as adminOf } from "./outlook-fixture.ts";
import { CONNECTORS, connectorChatTurn, disconnectConnector, GUARDED, say } from "../../supabase/functions/_shared/connectors.ts";

const CI = Deno.env.get("CI") === "true";
function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const env = { get: (k: string) => ({ GOOGLE_OAUTH_CLIENT_ID: "fake-google-client", GOOGLE_OAUTH_CLIENT_SECRET: "fake-google-secret", MICROSOFT_OAUTH_CLIENT_ID: "fake-ms-client", MICROSOFT_OAUTH_CLIENT_SECRET: "fake-ms-secret" } as Record<string, string>)[k] };
const noNet = (async (u: any) => { throw new Error(`no network in this test: ${String(u?.url ?? u)}`); }) as typeof fetch;

Deno.test("reply guard: a token-shaped string or an internal code never reaches the person", () => {
  const logs: string[] = [];
  for (const bad of [
    "Your access is ya29.FAKEaccessTOKENvalue123 ok", "refresh 1//0FAKErefreshTOKENvalue", "id eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY3", "ms EwBwA8l6BAAUfakefakefakefakefake",
    "Authorization: Bearer abcdefghijklmnop", "here is your refresh_token", "NOT_WIRED: nothing was read", "status NEEDS_RECONNECT", "CAREER_EMAIL_SEND is off",
  ]) {
    eq(say(bad, (l) => logs.push(l)), GUARDED, `refused: ${bad}`);
  }
  assert(logs.every((l) => !/ya29|1\/\/|eyJ|EwB|NOT_WIRED/.test(l)), "the log names the reason, never the text");
  for (const fine of ["Gmail is disconnected. Google confirmed Trainee's access is revoked.", "Outlook: not connected. Text \"connect my outlook\" to connect it.",
    "Here's a one-time link.\n\nhttps://proj.example.test/functions/v1/gmail-oauth?t=AB_CD-efgh_IJKL-mnop_QRST-uvwx_Y"]) {
    eq(say(fine), fine, `kept: ${fine.slice(0, 40)}`);
  }
});

// A service client double whose connection row names another person's Vault entry; any Vault read is recorded.
function foreignRow(provider: string, vaultName: string, scopes: string) {
  const reads: string[] = [];
  const q: any = { select: () => q, eq: () => q, in: () => q, limit: () => q, order: () => q, maybeSingle: () => q,
    then: (ok: any) => Promise.resolve({ data: { provider, vault_name: vaultName, scopes }, error: null }).then(ok) };
  return { reads, admin: { from: () => q, rpc: (name: string, a: any) => { reads.push(`${name}:${a?.p_name ?? ""}`); return Promise.resolve({ data: JSON.stringify({ access_token: "ya29.FAKEotherPERSONtoken", expires_at: Date.now() + 3600e3 }), error: null }); } } };
}
Deno.test("token guard: only the person's own Vault entry is ever read, for Gmail and for Outlook", async () => {
  const me = "00000000-0000-4000-8000-0000000000a1", other = "00000000-0000-4000-8000-0000000000b2";
  const g = foreignRow("google_career", `oauth_google_career_${other}`, "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send");
  const gt = await CONNECTORS.gmail.token({ admin: g.admin, env, fetch: noNet, now: Date.now }, me, "read");
  eq(gt.status, "not_connected", "Gmail: a row naming another entry is no connection");
  eq(g.reads, [], "Gmail: no Vault entry was read");
  const m = foreignRow("microsoft", `oauth_microsoft_${other}`, "Mail.Read Mail.Send");
  const mt = await CONNECTORS.outlook.token({ admin: m.admin, env, fetch: noNet, now: Date.now }, me, "read");
  eq(mt.status, "not_connected", "Outlook: a row naming another entry is no connection");
  eq(m.reads, [], "Outlook: no Vault entry was read");
  // And the token never travels in a reply: what's-connected and connect replies over the same double carry none.
  const g2 = foreignRow("google_career", `oauth_google_career_${me}`, "https://www.googleapis.com/auth/gmail.readonly");
  const t = await CONNECTORS.gmail.token({ admin: g2.admin, env, fetch: noNet, now: Date.now }, me, "read");
  eq(t.status, "ok", "the person's own entry is read");
  eq(g2.reads, [`oauth_vault_read:oauth_google_career_${me}`], "exactly the person's own entry");
});

Deno.test({ name: "erase guard: a disconnect says only what the read-back shows (real Postgres)", ignore: !pgBinDir() && !CI, sanitizeOps: false, sanitizeResources: false }, async (t) => {
  const pg = await startPg();
  const base = adminOf(pg);
  const U = "00000000-0000-4000-8000-00000000e001";
  const google = (async (u: any) => { if (String(u?.url ?? u) === "https://oauth2.googleapis.com/revoke") return new Response("", { status: 200 }); throw new Error("unexpected call"); }) as typeof fetch;
  const seed = async () => {
    await pg.sql(`insert into auth.users (id, email) values ('${U}', 'e@example.test') on conflict do nothing; insert into public.profiles (id) values ('${U}') on conflict do nothing;
      select public.oauth_vault_store('oauth_google_career_${U}', '{"access_token":"ya29.FAKEguard","refresh_token":"1//FAKEguardrefresh"}');
      insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values ('${U}', 'google_career', 'oauth_google_career_${U}', 'e@example.test', 'openid email https://www.googleapis.com/auth/gmail.readonly') on conflict do nothing;
      insert into public.career_outreach_drafts (user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status, approved_hash, approved_at)
        values ('${U}', gen_random_uuid(), 1, '{"name":"Maya"}', 'maya@acme.example', 'Hello', 'Hi Maya', 'Sent by me', repeat('a', 64), 'approved', repeat('a', 64), now());`);
  };
  try {
    await t.step("the stored token could not be deleted: failed, said plainly, never 'disconnected'", async () => {
      await seed();
      const failing = { from: base.from, rpc: (n: string, a: any) => n === "oauth_vault_delete" ? Promise.resolve({ data: null, error: { message: "permission denied" } }) : base.rpc(n, a) };
      const r = await disconnectConnector({ admin: failing, env, fetch: google, now: Date.now }, CONNECTORS.gmail, U);
      eq(r.ok, false, "not ok");
      assert(!/Gmail is disconnected/.test(r.reply) && /couldn't finish disconnecting Gmail/.test(r.reply), r.reply);
      eq(say(r.reply), r.reply, "plain words");
    });
    await t.step("an approved email still waiting after the disconnect is a failure, never 'cancelled'", async () => {
      await pg.sql(`delete from public.career_outreach_drafts where user_id = '${U}'; delete from vault.secrets where name = 'oauth_google_career_${U}';`);
      await seed();
      // A trigger that swallows every update of the drafts: the cancel reports success and changes nothing.
      await pg.sql(`create or replace function public.guard_block() returns trigger language plpgsql as $$ begin return null; end $$;
        create trigger guard_block before update on public.career_outreach_drafts for each row execute function public.guard_block();`);
      try {
        const r = await disconnectConnector({ admin: base, env, fetch: google, now: Date.now }, CONNECTORS.gmail, U);
        eq(r.ok, false, "not ok");
        assert(r.failures.includes("cancel the emails still waiting to go"), JSON.stringify(r.failures));
        assert(/couldn't cancel the emails still waiting to go/.test(r.reply) && !/I also cancelled/.test(r.reply), r.reply);
        eq(Number(await pg.sql(`select count(*) from public.career_outreach_drafts where user_id = '${U}' and status = 'approved'`)), 1, "the email is still approved (the blocker worked)");
      } finally { await pg.sql(`drop trigger guard_block on public.career_outreach_drafts; drop function public.guard_block();`); }
    });
    await t.step("the links and parked tasks are the service role's only: no person and no anonymous caller reads or calls them", async () => {
      eq(await pg.sql(`select has_table_privilege('anon', 'public.career_parked_tasks', 'select') or has_table_privilege('authenticated', 'public.career_parked_tasks', 'select')
        or has_table_privilege('authenticated', 'public.career_connector_links', 'select') or has_function_privilege('authenticated', 'public.career_connector_link_issue(uuid,text,text,uuid,timestamptz)', 'execute')
        or has_function_privilege('anon', 'public.career_parked_park(uuid,text,text,uuid,text,timestamptz)', 'execute') or has_function_privilege('authenticated', 'public.career_parked_claim(uuid,text[],timestamptz,int)', 'execute')`), "f", "no grant");
      eq(await pg.sql(`select count(*) from public.career_connector_links where nonce_hash !~ '^[0-9a-f]{64}$'`), "0", "only hashes are stored");
    });
    await t.step("the chat turn's own reply goes through the guard too", async () => {
      const r = await connectorChatTurn({ admin: base, env, fetch: google, now: Date.now, message: "disconnect gmail", userId: U, threadId: "00000000-0000-4000-8000-00000000e0ff", bridge: false });
      assert(r && !/ya29|1\/\/|[A-Z]{2,}_[A-Z]{2,}/.test(r.reply), r?.reply);
    });
  } finally { await pg.stop(); }
});
