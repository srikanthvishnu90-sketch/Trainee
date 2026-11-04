// Every per-person secret Upmore puts in Supabase Vault has a way out when the person deletes their account (megadoc
// Q04; privacy policy: "deleting your account erases ... your bank/brokerage connections including stored
// credentials"). The Vault has no foreign keys, so a cascade never reaches it: each writer below is declared with the
// path that removes its secret, and a new vault.create_secret in a migration fails this test until it is declared here.
// Found 2026-10-12: the Gmail token (oauth_gmail_<uid>) had no path out at all.
// Check: node --test tests/vault-deletion.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const MIG = path.join(root, "supabase/migrations");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
// The function and the steps it runs (moved to _shared/account_delete.ts in ERASE SCENARIOS ROUND 2, 2026-10-30).
const DELETE_ACCOUNT = read("supabase/functions/delete-account/index.ts") + "\n" + read("supabase/functions/_shared/account_delete.ts");
const ALL_SQL = fs.readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort().map((f) => fs.readFileSync(path.join(MIG, f), "utf8")).join("\n");

// file -> [{ secret, out: "delete-account" (the RPC it calls) | "trigger" (an after-delete trigger on the row) }]
const WRITERS = {
  "20260926_000001_agent_exec.sql": [{ secret: "exec_cred_<uid>_<merchant>", out: "delete-account", rpc: "exec_vault_delete" }],
  "20260927_000002_simplefin_vault.sql": [{ secret: "simplefin_access_url_<uid>", out: "delete-account", rpc: "simplefin_vault_delete" }],
  "20260928_000011_oauth_connections.sql": [{ secret: "oauth_gmail_<uid>", out: "trigger", trigger: "user_oauth_connections_vault_cleanup", rpc: "oauth_vault_delete" }],
  "20261011030000_brokerage_accounts_per_user.sql": [
    { secret: "broker token (brokerage_accounts.vault_key_ref)", out: "trigger", trigger: "brokerage_accounts_vault_cleanup" },
    { secret: "broker token, relinked", out: "trigger", trigger: "brokerage_accounts_vault_cleanup" },
    { secret: "broker_pending_<link>", out: "trigger", trigger: "broker_pending_links_vault_cleanup" },
  ],
  "20261012010000_manual_connections.sql": [{ secret: "manual_<uid>_<platform>", out: "trigger", trigger: "manual_connections_vault_cleanup" }],
  // oauth_vault_refresh: a refreshed token, written only while its connection row exists (and under that row's lock).
  "20261030050000_account_erase_r2.sql": [{ secret: "oauth_<provider>_<uid>, refreshed", out: "trigger", trigger: "user_oauth_connections_vault_cleanup", rpc: "oauth_vault_delete" }],
};

test("every vault.create_secret in a migration is declared with its way out", () => {
  const found = {};
  for (const f of fs.readdirSync(MIG).filter((x) => x.endsWith(".sql"))) {
    const n = (fs.readFileSync(path.join(MIG, f), "utf8").match(/vault\.create_secret\s*\(/g) || []).length;
    if (n) found[f] = n;
  }
  const declared = Object.fromEntries(Object.entries(WRITERS).map(([f, w]) => [f, w.length]));
  assert.deepEqual(found, declared, "a migration writes a Vault secret with no declared deletion path (add it to WRITERS with its trigger or delete-account call)");
});

test("a trigger way out exists as an after-delete trigger in the migrations", () => {
  for (const w of Object.values(WRITERS).flat().filter((x) => x.out === "trigger")) {
    assert.match(ALL_SQL, new RegExp(`create trigger ${w.trigger} after delete on public\\.\\w+`), w.secret);
  }
});

test("delete-account calls the RPC for every secret that has no trigger, and for the Gmail token too", () => {
  for (const w of Object.values(WRITERS).flat().filter((x) => x.out === "delete-account" || x.rpc === "oauth_vault_delete")) {
    assert.match(DELETE_ACCOUNT, new RegExp(`rpc/${w.rpc}\\b`), w.secret);
  }
  assert.match(DELETE_ACCOUNT, /p_name: `oauth_gmail_\$\{uid\}`/);
  assert.match(DELETE_ACCOUNT, /p_name: `exec_cred_\$\{uid\}_plaid`/, "the Plaid token has no refs row, so it is named explicitly");
});

test("the Gmail trigger removes the secret by a name derived from the row's owner, never by its vault_name column", () => {
  const m = /create or replace function public\.oauth_connection_vault_cleanup\(\)[\s\S]*?end \$\$;/.exec(ALL_SQL);
  assert.ok(m, "cleanup function present");
  assert.match(m[0], /name = 'oauth_' \|\| old\.provider \|\| '_' \|\| old\.user_id::text/);
  assert.doesNotMatch(m[0], /old\.vault_name/);
});
