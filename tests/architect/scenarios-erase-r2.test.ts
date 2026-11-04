// Erase scenarios, round 2 (owner rules, 2026-10-30), fed ~10,000 generated scenarios (tests/architect/scenarios/
// erase-r2-generator.ts, seeded; fresh seeds and new categories next to round 1, scenarios-connectors.test.ts):
//   - account deletion revokes every Google grant AT GOOGLE before anything is erased (only Google's 200 is a revoke), says
//     where to remove an Outlook grant (Microsoft has no revoke endpoint), never blocks on a revoke Google did not confirm,
//     records it (account_deletion_log, nothing that names the person) and tells the person; it says "deleted" only when
//     the read-back shows the account gone; a second request is harmless;
//   - a token refresh racing a disconnect or a deletion never writes a token back for a connection that is gone, and the
//     refreshed token is not used;
//   - every reply about a deletion is truthful (never "deleted" before it is, never "Google confirmed" a revoke Google did
//     not confirm, never a token);
//   - a delivery run that claimed rows before the person's account was deleted sends nothing to them after.
// Part 1 runs the real functions (deleteAccount over restDeps, the edge function's wiring, against an in-memory project
// that answers like PostgREST, GoTrue and Storage, and a fake Google; careerTokenFor and outlookToken over vaultRefreshWrite;
// deletionWords; deliverDue) with a deterministic clock. Part 2 (flow-scenarios-erase-r2.test.ts) deletes people
// mid-activity on real Postgres and scans the whole schema for anything still tied to them. No model, no provider, no network.
// deno-lint-ignore-file no-explicit-any
import assertNode from "node:assert/strict";
import { type Answer, type Deletion, deletions, type Refresh, refreshes, results, secretOf, tokensOf, deliveries } from "./scenarios/erase-r2-generator.ts";
import { wordsWhy } from "./scenarios/erase-r2-check.ts";
import { deleteAccount, deletionWords, restDeps } from "../../supabase/functions/_shared/account_delete.ts";
import { GOOGLE_REVOKE } from "../../supabase/functions/_shared/google_disconnect.ts";
import { CAREER_READ_SCOPE, careerTokenFor } from "../../supabase/functions/_shared/career_mail_gmail.ts";
import { MS_TOKEN, outlookToken } from "../../supabase/functions/_shared/outlook_graph.ts";
import { vaultRefreshWrite } from "../../supabase/functions/_shared/oauth_vault_refresh.ts";
import { type ChannelStore, deliverDue, GONE_NOTE, type OutboxRow } from "../../supabase/functions/_shared/channel.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SEED = 20261030;
export const DELETIONS = deletions(SEED + 11, 5000);
export const REFRESHES = refreshes(SEED + 12, 2500);
export const RESULTS = results(SEED + 13, 1500);
export const DELIVERIES = deliveries(SEED + 14, 1000);
const NOW = Date.UTC(2026, 9, 30, 15, 0, 0);
const URL_ = "https://proj.example.test", KEY = "service-key-fake-0000";

type Failure = { k: string; input: string; got: string; why: string };
class Report {
  total = 0; failures = new Map<string, Failure[]>();
  constructor(public path: string) {}
  grade(family: string, input: string, why: string | null, got: string) {
    this.total++;
    if (!why) return;
    const k = family.split("/").slice(0, 3).join("/");
    if (!this.failures.has(k)) this.failures.set(k, []);
    this.failures.get(k)!.push({ k, input, got, why });
  }
  assertClean() {
    const failed = [...this.failures.values()].reduce((a, b) => a + b.length, 0);
    const lines = [`[erase r2] ${this.path}: ${this.total} scenarios, ${failed} failures`];
    for (const [k, xs] of [...this.failures.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
      lines.push(`  FAIL ${k}: ${xs.length}`);
      for (const x of xs.slice(0, 2)) lines.push(`    ${x.input.slice(0, 160)} -> ${x.got.slice(0, 260)} (${x.why})`);
    }
    console.log(lines.join("\n"));
    const first = [...this.failures.entries()].slice(0, 3).map(([k, xs]) => `${k} x${xs.length}: ${xs[0].why} | ${xs[0].input.slice(0, 100)} -> ${xs[0].got.slice(0, 160)}`).join(" || ");
    eq(failed, 0, `${this.path}: ${failed} scenarios went wrong: ${first}`);
  }
}

// ------------------------------------------------------------------------------------------------ 1. account deletion
// An in-memory Supabase project that answers the requests restDeps makes the way PostgREST, GoTrue and Storage do, with the
// database's own behaviour (a connection row's delete removes its Vault entry; the auth user's delete cascades), one step
// made to fail as the generator says, and Google's revoke endpoint. Any other host is an error and is logged.
export function fakeProject(d: Deletion, fail = d.fail) {
  const U = d.uid;
  const st = {
    users: new Set([U]),
    conns: (["google_career", "gmail", "microsoft"] as const).filter((p) => d.grants[p]).map((p) => ({ user_id: U, provider: p })),
    vault: new Map<string, string>(),
    refs: Array.from({ length: d.execRefs }, (_, i) => ({ user_id: U, vault_name: `exec_cred_${U}_m${i}` })),
    files: new Set(Array.from({ length: d.files }, (_, i) => `${U}/r${i}.pdf`)),
    plaid: [{ user_id: U }], log: [] as any[], ledgerPurged: false,
  };
  for (const p of ["google_career", "gmail"] as const) {
    const s = secretOf(d.shape[p], p, d.id);
    if (d.grants[p] && s !== null) st.vault.set(`oauth_${p}_${U}`, s);
  }
  if (d.grants.microsoft) st.vault.set(`oauth_microsoft_${U}`, JSON.stringify({ access_token: `EwBFAKE-${d.id}`, refresh_token: `M.FAKE-${d.id}` }));
  st.vault.set(`simplefin_access_url_${U}`, "https://user:pass@bridge.example.test/simplefin");
  for (const r of st.refs) st.vault.set(r.vault_name, "{}");
  const calls: { n: number; what: string }[] = [];
  const outbound: string[] = [];
  const tries = new Map<string, number>();
  let phase: "before" | "after" = "before";
  const json = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const err = () => json(500, { message: "upstream connect error", code: "PGRST000" });
  const dropConn = () => {
    for (const c of st.conns) st.vault.delete(`oauth_${c.provider}_${U}`); // 20261012060000: the row's Vault entry goes with it
    st.conns = [];
  };
  const fetch: typeof globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input, init);
    const u = new URL(req.url);
    const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
    calls.push({ n: calls.length, what: `${req.method} ${u.host}${u.pathname}` });
    if (req.url === GOOGLE_REVOKE) {
      const tok = new URLSearchParams(body).get("token") ?? "";
      const k = tries.get(tok) ?? 0;
      tries.set(tok, k + 1);
      calls[calls.length - 1].what = `google ${tok}`;
      const a: Answer = d.answers[tok]?.[k] ?? 400;
      if (a === "timeout") throw new DOMException("The signal has been aborted", "TimeoutError");
      if (a === "network") throw new TypeError("error sending request: connection reset");
      return new Response(a === 400 ? '{"error":"invalid_token"}' : "", { status: a });
    }
    if (u.origin !== URL_) { outbound.push(`${req.method} ${u.host}`); throw new Error(`a call left the test: ${u.host}`); }
    if (req.headers.get("authorization") !== `Bearer ${KEY}` || req.headers.get("apikey") !== KEY) return json(401, { message: "no service key" });
    const p = u.pathname, q = u.searchParams;
    const args = body && /json/.test(req.headers.get("content-type") ?? "") ? JSON.parse(body) : {};
    const mine = (x: string | null) => x === `eq.${U}`;
    if (p === "/rest/v1/user_oauth_connections" && req.method === "GET") {
      if (fail === "grants" || !mine(q.get("user_id"))) return err();
      return json(200, st.conns.map((c) => ({ provider: c.provider })));
    }
    if (p === "/rest/v1/user_oauth_connections" && req.method === "DELETE") {
      if (fail === "disconnect" || !mine(q.get("user_id"))) return err();
      dropConn();
      return json(204, undefined);
    }
    if (p === "/rest/v1/rpc/oauth_vault_read") {
      const name = String(args.p_name);
      if (phase === "before" && fail === "vault_read") return err();
      if (phase === "before" && /^oauth_(google_career|gmail)_/.test(name) && d.shape[name.startsWith("oauth_gmail_") ? "gmail" : "google_career"] === "unreadable") return err();
      if (phase === "after" && fail === "secrets_left") return err();
      return json(200, st.vault.get(name) ?? null);
    }
    if (/^\/rest\/v1\/rpc\/(simplefin|exec|oauth)_vault_delete$/.test(p)) {
      if (fail === "secrets") return err();
      if (!String(args.p_name).includes(U)) return err();
      st.vault.delete(String(args.p_name));
      return json(200, null);
    }
    if (p === "/rest/v1/exec_credential_refs" && req.method === "GET") {
      if (fail === "secrets") return err();
      return json(200, st.refs.filter((r) => `eq.${r.user_id}` === q.get("user_id")).map((r) => ({ vault_name: r.vault_name })));
    }
    if (p === "/storage/v1/object/list/career-resumes") {
      if (fail === "files") return err();
      if (args.prefix !== `${U}/`) return err();
      return json(200, [...st.files].filter((f) => f.startsWith(args.prefix)).slice(0, args.limit).map((f) => ({ name: f.slice(args.prefix.length) })));
    }
    if (p === "/storage/v1/object/career-resumes" && req.method === "DELETE") {
      for (const f of args.prefixes ?? []) st.files.delete(f);
      return json(200, []);
    }
    if (p === "/rest/v1/plaid_requests" && req.method === "DELETE") {
      if (fail === "rows") return err();
      st.plaid = st.plaid.filter((r) => `eq.${r.user_id}` !== q.get("user_id"));
      return json(204, undefined);
    }
    if (p === "/rest/v1/rpc/purge_user_action_ledger") {
      phase = "after";
      if (fail === "ledger") return err();
      st.ledgerPurged = true;
      return json(200, null);
    }
    if (p === `/auth/v1/admin/users/${U}` && req.method === "DELETE") {
      if (fail === "user_delete") return json(500, { msg: "Database error deleting user" });
      if (fail === "user_delete_404") return json(404, { msg: "User not found" }); // an API that says gone while it is not
      if (!st.users.has(U)) return json(404, { code: 404, error_code: "user_not_found", msg: "User not found" });
      st.users.delete(U); dropConn(); st.refs = []; // the cascade (the refs rows; their Vault entries have none)
      return json(200, {});
    }
    if (p === `/auth/v1/admin/users/${U}` && req.method === "GET") {
      if (fail === "readback_user") return err();
      return st.users.has(U) ? json(200, { id: U }) : json(404, { code: 404, error_code: "user_not_found", msg: "User not found" });
    }
    if (p === "/rest/v1/account_deletion_log" && req.method === "POST") {
      if (fail === "record") return err();
      st.log.push(args);
      return json(201, undefined);
    }
    return json(404, { message: `fake project: no route ${req.method} ${p}` });
  }) as typeof fetch;
  return { fetch, st, calls, outbound };
}

// Google's revoke per OAuth (round 1's rule, derived again here): the refresh token first, then the access token; 200
// revoked; 400 not accepted (not a confirmation); another 4xx final; 429, 5xx, a timeout or a network failure tried again,
// three tries per token; the first 200 stops.
export function expectedRevoke(tokens: string[], answers: Record<string, Answer[]>): { outcome: string; calls: string[] } {
  if (!tokens.length) return { outcome: "no_token", calls: [] };
  const calls: string[] = [];
  let refused = false;
  for (const t of tokens) {
    for (let i = 0; i < 3; i++) {
      const a = answers[t][i];
      calls.push(t);
      if (a === 200) return { outcome: "revoked", calls };
      if (a === 400) { refused = true; break; }
      if (typeof a === "number" && a !== 429 && a < 500) break;
    }
  }
  return { outcome: refused ? "refused" : "not_confirmed", calls };
}
function expectedGoogle(d: Deletion) {
  const out: Record<string, string> = {};
  const calls: string[] = [];
  if (d.fail === "grants") return { out, calls };
  for (const p of ["google_career", "gmail"] as const) {
    if (!d.grants[p]) continue;
    if (d.fail === "vault_read" || d.shape[p] === "unreadable") { out[p] = "not_confirmed"; continue; }
    const t = tokensOf(p, d.id), s = d.shape[p];
    const toks = s === "both" ? [t.refresh, t.access] : s === "refresh" ? [t.refresh] : s === "access" ? [t.access] : [];
    const e = expectedRevoke(toks, d.answers);
    out[p] = e.outcome;
    calls.push(...e.calls);
  }
  return { out, calls };
}

Deno.test(`erase r2, account deletion (deleteAccount over restDeps): ${DELETIONS.length} people, provider answers and failing steps`, async () => {
  const rep = new Report("delete account");
  for (const d of DELETIONS) {
    const proj = fakeProject(d);
    const sleeps: number[] = [];
    let why: string | null = null, got = "";
    try {
      const r = await deleteAccount(restDeps(URL_, KEY, proj.fetch, { sleep: async (ms) => { sleeps.push(ms); } }), d.uid);
      const x = deletionWords(r);
      got = `${JSON.stringify({ deleted: r.deleted, google: r.google, outlook: r.outlook, failures: r.failures })} ${x}`;
      const want = expectedGoogle(d);
      const googleCalls = proj.calls.filter((c) => c.what.startsWith("google ")).map((c) => c.what.slice(7));
      const firstErase = proj.calls.findIndex((c) => /DELETE .*user_oauth_connections|vault_delete|DELETE .*admin\/users/.test(c.what));
      const lastGoogle = proj.calls.map((c) => c.what.startsWith("google ")).lastIndexOf(true);
      const gone = !proj.st.users.has(d.uid);
      const at = (what: string) => proj.calls.findIndex((c) => c.what === what);
      if (proj.outbound.length) why = `a call left for ${proj.outbound[0]} (Microsoft has no revoke endpoint; nothing else is called)`;
      else if (JSON.stringify(r.google) !== JSON.stringify(want.out)) why = `Google outcomes must be ${JSON.stringify(want.out)}`;
      else if (JSON.stringify(googleCalls) !== JSON.stringify(want.calls)) why = `Google calls must be ${JSON.stringify(want.calls)}`;
      else if (lastGoogle >= 0 && firstErase >= 0 && lastGoogle > firstErase) why = "revoke at Google before anything is erased";
      else if (!(at("DELETE proj.example.test/rest/v1/user_oauth_connections") >= 0 && at("DELETE proj.example.test/rest/v1/user_oauth_connections") < at("POST proj.example.test/storage/v1/object/list/career-resumes")
        && at("POST proj.example.test/storage/v1/object/list/career-resumes") < at("POST proj.example.test/rest/v1/rpc/purge_user_action_ledger"))) why = "the connections go (cancelling what waits to be sent) right after the revoke, before the slower steps";
      else if (r.outlook !== (d.grants.microsoft && d.fail !== "grants")) why = "an Outlook grant is reported";
      else if (gone !== (d.fail !== "ledger" && d.fail !== "user_delete" && d.fail !== "user_delete_404")) why = "the account goes unless the ledger or the auth delete fails (a revoke never blocks it)";
      else if ((why = wordsWhy(r, x, { gone }))) { /* the words */ }
      else if (gone && [...proj.st.vault.keys()].some((k) => k.startsWith("oauth_"))) why = "a deleted account keeps an OAuth token in the Vault";
      else if (gone && d.fail !== "files" && [...proj.st.files].length) why = "resume files left in Storage";
      else if (d.fail !== "secrets" && [...proj.st.vault.keys()].some((k) => k.includes(d.uid))) why = `a secret left: ${[...proj.st.vault.keys()].find((k) => k.includes(d.uid))}`;
      else if (d.fail !== "record" && proj.st.log.length !== 1) why = "the deletion is recorded once";
      else if (proj.st.log.some((e) => /@|FAKE|ya29|5e2a0c1d/.test(JSON.stringify(e)))) why = "the record names nobody and holds no token";
      else if (d.fail !== "record" && JSON.stringify(proj.st.log[0].google) !== JSON.stringify(r.google)) why = "the record keeps what Google answered";
      else if (sleeps.some((s) => s > 1000)) why = "never waits more than a second between tries";
      // A second request (the person taps again, or retries after a failure): no Google call for a grant already gone, and
      // the answer is the truth now.
      if (!why && d.twice) {
        const before = proj.calls.length;
        const proj2 = fakeProject(d, "none");
        Object.assign(proj2.st, { users: proj.st.users, conns: proj.st.conns, vault: proj.st.vault, refs: proj.st.refs, files: proj.st.files, log: proj.st.log });
        const r2 = await deleteAccount(restDeps(URL_, KEY, proj2.fetch, { sleep: async () => {} }), d.uid);
        const x2 = deletionWords(r2);
        const g2 = proj2.calls.filter((c) => c.what.startsWith("google "));
        const stillConn = d.fail === "disconnect" && !gone;
        if (!r2.deleted || proj2.st.users.has(d.uid)) why = `a retry deletes the account: ${x2}`;
        else if (!stillConn && g2.length) why = "a retry calls Google for a grant already removed";
        else if ((why = wordsWhy(r2, x2, { gone: !proj2.st.users.has(d.uid) }))) why = `retry: ${why}`;
        got += ` | retry: ${x2} (${proj.calls.length - before})`;
      }
    } catch (e) { why = `threw: ${(e as Error)?.message ?? e}`; }
    rep.grade(`delete/${d.family}`, `#${d.id} ${JSON.stringify({ grants: d.grants, shape: d.shape, fail: d.fail })}`, why, got);
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ 2. refresh races
// The person's connection and Vault entry in memory; the provider's token endpoint deletes the row (a disconnect, or the
// account's deletion: the row cascades) while the refresh is "at the provider". oauth_vault_refresh answers as the
// migration does (writes only while the row exists); oauth_vault_store writes anything.
function refreshWorld(f: Refresh) {
  const name = `oauth_${f.provider === "gmail" ? "google_career" : "microsoft"}_${f.uid}`;
  const st = { row: true as boolean, user: true, vault: new Map<string, string>(), reconnect: [] as string[], providerCalls: 0, outbound: [] as string[] };
  st.vault.set(name, JSON.stringify({ access_token: `old-access-${f.id}`, refresh_token: `old-refresh-${f.id}`, expires_at: f.expired ? NOW - 1000 : NOW + 3600_000 }));
  const admin = {
    rpc: async (fn: string, a: any) => {
      if (fn === "oauth_vault_refresh") {
        if (f.rpc === "missing") return { data: null, error: { code: "PGRST202", message: "Could not find the function public.oauth_vault_refresh(p_name, p_secret) in the schema cache" } };
        if (f.rpc === "failing") return { data: null, error: { message: "connection reset by peer" } };
        if (!st.row) return { data: false, error: null };
        st.vault.set(a.p_name, a.p_secret);
        return { data: true, error: null };
      }
      if (fn === "oauth_vault_store") { st.vault.set(a.p_name, a.p_secret); return { data: crypto.randomUUID(), error: null }; }
      return { data: null, error: { message: `unknown rpc ${fn}` } };
    },
  };
  const fetch: typeof globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url !== "https://oauth2.googleapis.com/token" && url !== MS_TOKEN) { st.outbound.push(url); throw new Error(`a call left the test: ${url}`); }
    st.providerCalls++;
    if (f.gone !== "no") { st.row = false; st.vault.delete(name); if (f.gone === "account_delete") st.user = false; } // committed while the provider answered
    void init;
    if (f.answer === 200) return new Response(JSON.stringify({ access_token: `new-access-${f.id}`, expires_in: 3600, ...(f.provider === "outlook" ? { refresh_token: `new-refresh-${f.id}` } : {}) }), { status: 200 });
    if (f.answer === 429) return new Response("{}", { status: 429, headers: { "retry-after": "7" } });
    return new Response(JSON.stringify({ error: f.answer === 500 ? "server_error" : "invalid_grant" }), { status: f.answer });
  }) as typeof fetch;
  const env = { get: (k: string) => ({ GOOGLE_OAUTH_CLIENT_ID: "gid", GOOGLE_OAUTH_CLIENT_SECRET: "gsecret", MICROSOFT_OAUTH_CLIENT_ID: "mid", MICROSOFT_OAUTH_CLIENT_SECRET: "msecret" } as Record<string, string>)[k] };
  const connection = async () => (st.row ? { vault_name: name, scopes: f.provider === "gmail" ? `openid email ${CAREER_READ_SCOPE}` : "Mail.Read Mail.Send offline_access" } : null);
  const readVault = async (n: string) => st.vault.get(n) ?? null;
  const writeVault = (n: string, s: string) => vaultRefreshWrite(admin, n, s, "save the refreshed access");
  return { name, st, fetch, env, connection, readVault, writeVault };
}
Deno.test(`erase r2, a token refresh racing a disconnect or a deletion (careerTokenFor, outlookToken): ${REFRESHES.length} refreshes`, async () => {
  const rep = new Report("refresh");
  for (const f of REFRESHES) {
    const w = refreshWorld(f);
    let why: string | null = null, got = "";
    let token: string | null = null, status = "", threw = "";
    try {
      if (f.provider === "gmail") {
        token = await careerTokenFor({ fetch: w.fetch, env: w.env, now: () => NOW, connection: w.connection, readVault: w.readVault, writeVault: w.writeVault }, CAREER_READ_SCOPE)(f.uid);
        status = token ? "ok" : "none";
      } else {
        const r = await outlookToken({ fetch: w.fetch, env: w.env, now: () => NOW, connection: w.connection, readVault: w.readVault, writeVault: w.writeVault,
          markReconnect: async (_u, why) => { w.st.reconnect.push(why); } }, f.uid, "Mail.Send");
        status = r.status; token = r.status === "ok" ? r.token : null;
      }
    } catch (e) { threw = String((e as Error)?.message ?? e); status = "threw"; }
    const stored = w.st.vault.get(w.name) ?? null;
    got = `${status} token=${token} vault=${stored ? JSON.parse(stored).access_token : "none"} ${threw}`;
    // What must happen, derived from the fields.
    const refreshed = f.expired && f.answer === 200;
    if (w.st.outbound.length) why = `a call left the test: ${w.st.outbound[0]}`;
    else if (!f.expired) why = token === `old-access-${f.id}` && w.st.providerCalls === 0 ? null : "a fresh token is used as it is, without a refresh";
    else if (!refreshed) {
      const wantStatus = f.provider === "gmail" ? (f.answer === 400 || f.answer === 401 ? "none" : "threw")
        : f.answer === 400 || f.answer === 401 ? "NEEDS_RECONNECT" : f.answer === 429 ? "RATE_LIMITED" : "ERROR";
      why = status === wantStatus ? null : `a refused or failed refresh is ${wantStatus}`;
      if (!why && token) why = "no token from a refused refresh";
    } else if (f.rpc === "failing") why = status === "threw" ? null : "a write that failed is an error, never a token";
    else if (f.rpc === "missing") why = token === `new-access-${f.id}` ? null : "before the migration, the old write (the token is used)";
    else if (f.gone !== "no") {
      // The fix: the connection went while the refresh ran: nothing written back, and the token is not used.
      if (stored) why = "a refreshed token was written back for a connection that is gone (it outlives the disconnect)";
      else if (token) why = "a refreshed token for a connection that is gone was used";
      else if (f.provider === "outlook" && status !== "NOT_WIRED") why = "Outlook gone: not connected";
    } else if (token !== `new-access-${f.id}` || !stored || JSON.parse(stored).access_token !== `new-access-${f.id}`) why = "a refresh while connected writes the new token and uses it";
    rep.grade(`refresh/${f.family}`, `#${f.id} ${f.family}`, why, got);
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ 3. the words
Deno.test(`erase r2, what the person is told about a deletion (deletionWords): ${RESULTS.length} outcomes`, () => {
  const rep = new Report("words");
  for (const r of RESULTS) {
    const x = deletionWords(r as any);
    rep.grade(`words/${r.family}`, JSON.stringify(r), wordsWhy(r, x), x);
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ 4. deliveries
// A delivery run claims rows (due), then the person's account is deleted (it commits between the claim and the send), as
// a deletion running beside the run would. The store answers like channel_store over the database after 20261030050000:
// quiet is true for an account that no longer exists, gone says so. Nothing reaches the deleted person; the other person's
// rows go (an answer waits when the check cannot be read).
Deno.test(`erase r2, a delivery run racing an account deletion (deliverDue): ${DELIVERIES.length} runs`, async () => {
  const rep = new Report("deliveries");
  const logError = console.error;
  console.error = () => {}; // a check that cannot be read is logged by deliverDue; restored below
  try { for (const v of DELIVERIES) {
    const users = { deleted: "u-deleted", other: "u-other" } as const;
    const exists = new Set<string>([users.deleted, users.other]);
    const sent: string[] = [], marks = new Map<string, any>();
    const rows: OutboxRow[] = v.rows.map((x, i) => ({ id: x.id, userId: users[x.user], contact: x.user === "deleted" ? "tg:111" : "tg:222", key: x.key,
      text: Array.from({ length: x.parts }, (_, k) => `part ${k + 1} of ${x.key}`).join("\n\n"), deliver_at: NOW - 60_000 + i, attempts: 0 }));
    const store: ChannelStore = {
      async due() { const out = rows.map((r) => ({ ...r })); exists.delete(users.deleted); return out; }, // the deletion commits after the claim
      async optedOut() { return false; },
      async quiet(u) { return !exists.has(u); },
      async gone(u) { if (v.goneRead === "fails") throw new Error("connection reset"); return !exists.has(u); },
      async setOptOut() {}, async contactsSentOn() { return 0; }, async sentTo() { return true; },
      async mark(id, m) { marks.set(id, m); },
    };
    const adapter = { channel: "telegram" as const, limits: {}, render: (t: string) => t.split("\n\n"), send: async (addr: string, bubbles: string[]) => { sent.push(`${addr}|${bubbles.length}`); return { ok: true as const, id: `m${sent.length}` }; } };
    let why: string | null = null;
    const r = await deliverDue({ store, adapters: { telegram: adapter as any }, now: NOW });
    const toDeleted = sent.filter((s) => s.startsWith("111|"));
    const otherRows = v.rows.filter((x) => x.user === "other");
    const otherWant = otherRows.filter((x) => !(x.key.startsWith("reply:") && v.goneRead === "fails")).length;
    if (toDeleted.length) why = `${toDeleted.length} message(s) went to a deleted account`;
    else if (sent.filter((s) => s.startsWith("222|")).length !== otherWant) why = `the other person's messages go: ${otherWant}`;
    else if (v.goneRead === "ok" && v.rows.some((x) => x.user === "deleted" && x.key.startsWith("reply:") && marks.get(x.id)?.error !== GONE_NOTE)) why = "an answer to a deleted account is marked not sent, with why";
    rep.grade(`deliveries/${v.family}`, `#${v.id} ${v.family}`, why, `${JSON.stringify(r)} sent=${JSON.stringify(sent)}`);
  } } finally { console.error = logError; }
  rep.assertClean();
});
