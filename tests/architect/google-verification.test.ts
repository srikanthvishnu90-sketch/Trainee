// Google verification (owner, 2026-10-26: "yes start google's verification"). What the submission promises Google, held
// by code: the consent URL asks only for the submitted scopes; a disconnect revokes the grant at Google and deletes the
// mail rows (the SQL half is tests/db/google_disconnect_erase.test.sql); the public pages carry the Limited Use statement
// and say only what the code does; the pre-consent words are one source. No network, no database, no real Google.
import { createRequire } from "node:module";
import {
  approvedExtras, consentNotice, EMAIL, GMAIL_READONLY, GMAIL_SEND, OPENID, permissionScopes, requestableScopes, SUBMITTED_SCOPES,
} from "../../supabase/functions/_shared/google_scopes.ts";
import { careerLanding, LEGACY_OFF_MESSAGE, redirectUriFrom, requestScopesFor, scopeSet, startAllowed } from "../../supabase/functions/gmail-oauth/career.ts";
import { disconnectGoogle, disconnectReply, GOOGLE_REVOKE, isGoogleDisconnect, revokeAtGoogle, REVOKE_TIMEOUT_MS } from "../../supabase/functions/_shared/google_disconnect.ts";
import { buildLegal, buildNoticePage, missingInputs, OWNER_INPUTS, placeholdersIn } from "../../scripts/launch/build-legal-pages.ts";
import OAUTH_SRC from "../../supabase/functions/gmail-oauth/index.ts" with { type: "text" };
import GO_LIVE from "../../scripts/launch/trainee-go-live.sh" with { type: "text" };
import DB_RUN from "../db/run.sh" with { type: "text" };
import MIGRATION from "../../supabase/migrations/20261026200011_google_disconnect_erase.sql" with { type: "text" };
import DOC from "../../docs/launch/GOOGLE-VERIFICATION-2026-10-26.md" with { type: "text" };

const ROOT = new URL("../../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, ROOT));
const eq = (a: unknown, b: unknown, m: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};
const assert = (c: unknown, m: string) => {
  if (!c) throw new Error(m);
};
const env = (v: Record<string, string> = {}) => ({ get: (k: string) => v[k] });
const CAL_FB = "https://www.googleapis.com/auth/calendar.freebusy", CAL_EV = "https://www.googleapis.com/auth/calendar.events";
const FULL_MAIL = "https://mail.google.com/";

Deno.test("GV/1 the submission is openid, email and gmail.readonly; send and Calendar are never asked for by default", () => {
  eq(SUBMITTED_SCOPES, [OPENID, EMAIL, GMAIL_READONLY], "the scopes submitted on 2026-10-26");
  const r = requestableScopes([GMAIL_READONLY, GMAIL_SEND, CAL_FB, CAL_EV], env());
  eq(r.scopes, [OPENID, EMAIL, GMAIL_READONLY], "only the submitted ones reach the consent URL");
  eq(r.dropped, [GMAIL_SEND, CAL_FB, CAL_EV], "and what was refused is named");
  eq(requestableScopes([], env()).scopes, [OPENID, EMAIL], "an empty ask still only names the account");
  eq(requestableScopes([GMAIL_READONLY, GMAIL_READONLY], env()).scopes, [OPENID, EMAIL, GMAIL_READONLY], "a repeated scope is asked once");
});

Deno.test("GV/2 gmail.send comes back only when the owner says Google approved it; junk in the switch widens nothing", () => {
  const on = env({ GOOGLE_APPROVED_EXTRA_SCOPES: GMAIL_SEND });
  eq(requestableScopes([GMAIL_READONLY, GMAIL_SEND], on).scopes, [OPENID, EMAIL, GMAIL_READONLY, GMAIL_SEND], "approved send is asked");
  eq(requestableScopes([GMAIL_READONLY, GMAIL_SEND, CAL_FB], on).dropped, [CAL_FB], "Calendar stays out");
  // A bare word, a full-mail URL on another host, a header break and a list with spaces: none is a scope this accepts.
  const junk = env({ GOOGLE_APPROVED_EXTRA_SCOPES: `gmail.send ${FULL_MAIL} https://www.googleapis.com/auth/gmail.modify\r\nX: y ,` });
  eq(approvedExtras(junk), ["https://www.googleapis.com/auth/gmail.modify"], "only a googleapis scope URL is read from the switch");
  eq(requestableScopes([FULL_MAIL, GMAIL_SEND], junk).scopes, [OPENID, EMAIL], "full mail access and unapproved send are refused");
  eq(requestableScopes([GMAIL_READONLY], env({ GOOGLE_APPROVED_EXTRA_SCOPES: "" })).scopes, [OPENID, EMAIL, GMAIL_READONLY], "empty switch");
});

Deno.test("GV/3 gmail-oauth asks Google exactly what the shared module allows, for both grants", () => {
  for (const extras of [undefined, "", GMAIL_SEND, `${GMAIL_SEND} ${CAL_FB}`, "nonsense"]) {
    const e = env(extras === undefined ? {} : { GOOGLE_APPROVED_EXTRA_SCOPES: extras });
    eq(requestScopesFor("career", extras), requestableScopes([GMAIL_READONLY, GMAIL_SEND, CAL_FB, CAL_EV], e), `career grant, extras ${extras}`);
    eq(requestScopesFor("gmail", extras), requestableScopes([GMAIL_READONLY], e), `legacy grant, extras ${extras}`);
  }
  eq(requestScopesFor("career").scopes, [OPENID, EMAIL, GMAIL_READONLY], "the career consent today");
});

Deno.test("GV/7 openid and email never change what a grant may do (both status readers)", () => {
  eq(scopeSet([OPENID, "https://www.googleapis.com/auth/userinfo.email", GMAIL_READONLY]), "readonly", "career.ts: read-only with identity scopes");
  eq(scopeSet([OPENID, EMAIL]), "none", "career.ts: identity alone is no mail permission");
  eq(permissionScopes([OPENID, EMAIL, GMAIL_READONLY]), [GMAIL_READONLY], "shared module");
  const A = createRequire(import.meta.url)(new URL("packages/domain/120-career-access.js", ROOT).pathname);
  const acc = A.connectedAccounts([{ provider: "google_career", email: "p@example.test", scopes: `${OPENID} https://www.googleapis.com/auth/userinfo.email ${GMAIL_READONLY}`, connected_at: null }]);
  eq(acc.gmail.scope_set, "readonly", "router 120 reads the same grant as read-only");
  assert(/Gmail: connected as p@example\.test \(read-only\)/.test(acc.text), `and says so: ${acc.text}`);
  eq(acc.calendar_connected, false, "no Calendar from identity scopes");
});

Deno.test("GV/8 the disconnect erase migration is applied by go-live and tested by the database run", () => {
  const f = "20261026200011_google_disconnect_erase.sql";
  assert(GO_LIVE.includes(`  ${f}\n`), "listed in go-live MIGRATIONS");
  assert(GO_LIVE.includes(`"exists (select 1 from pg_trigger where tgname = 'user_oauth_connections_google_erase')"`), "with its mark");
  assert(DB_RUN.includes(f) && DB_RUN.includes("google_disconnect_erase.test.sql"), "applied and tested in tests/db/run.sh");
  for (const t of ["career_mail_events", "career_mail_drafts", "career_mail_cursors"]) {
    assert(new RegExp(`delete from public\\.${t} where user_id = old\\.user_id;`).test(MIGRATION), `the migration deletes ${t} for the row's own person`);
  }
  assert(/if old\.provider = 'google_career' then/.test(MIGRATION), "only on the career Google grant's delete");
});


Deno.test("GV/4 the handler: filtered consent URL, legacy consent off, its own landing and redirect, one disconnect", () => {
  const start = OAUTH_SRC.slice(OAUTH_SRC.indexOf("const startPurpose = purposeForAction(action);"), OAUTH_SRC.indexOf('if (action === "status")'));
  assert(/if \(!startAllowed\(startPurpose, Deno\.env\)\) return json\(\{ error: LEGACY_OFF_MESSAGE \}, 410\);/.test(start), "the legacy start is refused first");
  assert(/requestScopesFor\(startPurpose, Deno\.env\.get\("GOOGLE_APPROVED_EXTRA_SCOPES"\)\)/.test(start) && /scope: asked\.scopes\.join\(" "\)/.test(start), "the URL carries only filtered scopes");
  assert(!/scopesForPurpose/.test(OAUTH_SRC), "nothing in the handler asks for the raw career set");
  assert(/: requestScopesFor\(purpose, Deno\.env\.get\("GOOGLE_APPROVED_EXTRA_SCOPES"\)\)\.scopes\.join\(" "\);/.test(OAUTH_SRC), "the fallback granted list is the filtered one");
  assert(/if \(!startAllowed\(purpose, Deno\.env\)\) throw new Error/.test(OAUTH_SRC), "a legacy callback is not stored either");
  assert(/purpose === "career" \? careerLanding\(ok\)/.test(OAUTH_SRC), "the career grant never lands on the Upmore app");
  assert(/return redirectUriFrom\(Deno\.env\);/.test(OAUTH_SRC), "the redirect URI can move to Trainee's domain");
  const dis = OAUTH_SRC.slice(OAUTH_SRC.indexOf('if (action === "disconnect")'), OAUTH_SRC.indexOf('return json({ error: "unknown action" }, 400);'));
  assert(/await disconnectGoogle\(admin, user\.id, \{ fetch \}, plan\.providers\)/.test(dis), "disconnect is the shared, checked implementation");
  assert(/ok: r\.ok, disconnected: r\.ok/.test(dis) && /r\.ok \? 200 : 500/.test(dis), "a partial failure is never ok:true");
  assert(!/oauth_vault_delete|\.delete\(\)/.test(dis), "no unchecked delete left in the handler");
});

Deno.test("GV/5 revoke at Google: only a 200 is revoked; timeout, retries, and every other answer said as not confirmed", async () => {
  type Call = { url: string; body: string; signal: boolean };
  const make = (answers: (number | "throw" | "hang")[]) => {
    const calls: Call[] = [], slept: number[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body), signal: init?.signal instanceof AbortSignal });
      const a = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (a === "throw") throw new TypeError("network down");
      if (a === "hang") return await new Promise<Response>((_, no) => init!.signal!.addEventListener("abort", () => no(init!.signal!.reason)));
      return new Response(a === 200 ? "" : JSON.stringify({ error: "invalid_token" }), { status: a });
    }) as typeof fetch;
    return { calls, slept, d: { fetch: f, sleep: async (ms: number) => { slept.push(ms); }, timeoutMs: 20 } };
  };
  const both = JSON.stringify({ access_token: "at-1", refresh_token: "rt-1" });
  let m = make([200]);
  eq(await revokeAtGoogle(m.d, both), "revoked", "200");
  eq(m.calls.map((c) => [c.url, c.body, c.signal]), [[GOOGLE_REVOKE, "token=rt-1", true]], "the refresh token, once, with a timeout signal");
  m = make([400, 400]);
  eq(await revokeAtGoogle(m.d, both), "refused", "400 is Google refusing the token, not a confirmed revoke");
  eq(m.calls.map((c) => c.body), ["token=rt-1", "token=at-1"], "a refused refresh token: the access token is tried, each once");
  m = make([400, 200]);
  eq(await revokeAtGoogle(m.d, both), "revoked", "the access token's 200 revokes the grant");
  m = make([503, 503, 503, 503, 503, 503]);
  eq(await revokeAtGoogle(m.d, both), "not_confirmed", "5xx every time");
  eq(m.calls.length, 6, "3 tries per token");
  eq(m.slept, [500, 1000, 500, 1000], "backing off between tries");
  m = make(["throw", 200]);
  eq(await revokeAtGoogle(m.d, both), "revoked", "a network failure is retried");
  m = make(["hang", 200]);
  eq(await revokeAtGoogle(m.d, both), "revoked", "a call that hangs is cut by the timeout and retried");
  m = make([429, 429, 429, 401]);
  eq(await revokeAtGoogle(m.d, both), "not_confirmed", "429 retried; a 401 is not");
  eq(m.calls.length, 4, "three 429s then one 401 on the access token");
  eq(REVOKE_TIMEOUT_MS, 5000, "the default timeout");
  m = make([200]);
  for (const bad of [null, "not json{", JSON.stringify({ email: "x@example.test" }), JSON.stringify({ refresh_token: "", access_token: 5 })]) {
    eq(await revokeAtGoogle(m.d, bad), "no_token", `no token in ${bad}`);
  }
  eq(m.calls.length, 0, "and none of those calls Google");
  await revokeAtGoogle(m.d, JSON.stringify({ refresh_token: "a&token=b" }));
  eq(new URLSearchParams(m.calls.at(-1)!.body).getAll("token"), ["a&token=b"], "a hostile token is one encoded field");
});

// A service-role client double: the person's rows in memory; each call can be told to fail. Keys of `fail`:
//   row_read / row_readback (the first / the later read of the connection rows), row_delete (error, nothing deleted),
//   row_delete_silent (no error, nothing deleted), row_delete_done (deleted, but the answer is an error),
//   mail_read / mail_readback (the first / the later read of a mail table), mail_delete (error, nothing deleted),
//   mail_silent:<table> (no error, that table's rows stay), mail_delete_done (deleted, but the answer is an error), vault_read (every read), vault_read_after (reads after a delete),
//   vault_delete, vault_delete_done. trigger:false is the database before migration 20261026200011.
const MAIL = ["career_mail_events", "career_mail_drafts", "career_mail_cursors"] as const;
function adminDouble(o: { rows?: string[]; vault?: Record<string, string>; mail?: number; fail?: Set<string>; trigger?: boolean } = {}) {
  const state = { rows: [...(o.rows ?? [])], vault: { ...(o.vault ?? {}) }, mail: Object.fromEntries(MAIL.map((t) => [t, o.mail ?? 0])) as Record<string, number> };
  const fail = o.fail ?? new Set<string>(), trigger = o.trigger ?? true;
  const err = (k: string) => (fail.has(k) ? { message: `${k} failed` } : null);
  const seen: Record<string, number> = {};
  const mailTotal = () => Object.values(state.mail).reduce((a, b) => a + b, 0);
  const from = (table: string) => {
    let op = "select", ps: string[] = [];
    const self: any = {
      select: () => self, eq: () => self, limit: () => self,
      delete: () => { op = "delete"; return self; },
      in: (_c: string, p: string[]) => { ps = p; return self; },
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => { try { resolve(run()); } catch (e) { reject(e); } },
    };
    const run = () => {
      const n = (seen[`${table}:${op}`] = (seen[`${table}:${op}`] ?? 0) + 1);
      if (table === "user_oauth_connections" && op === "select") {
        const e = err(n === 1 ? "row_read" : "row_readback");
        return { data: e ? null : state.rows.filter((p) => ps.includes(p)).map((provider) => ({ provider })), error: e };
      }
      if (table === "user_oauth_connections" && op === "delete") {
        if (err("row_delete")) return { data: null, error: err("row_delete") };
        if (!fail.has("row_delete_silent")) {
          state.rows = state.rows.filter((p) => !ps.includes(p));
          if (trigger && ps.includes("google_career")) for (const t of MAIL) state.mail[t] = 0;
        }
        return { data: null, error: err("row_delete_done") };
      }
      if ((MAIL as readonly string[]).includes(table) && op === "select") {
        const e = err(n === 1 ? "mail_read" : "mail_readback");
        return { data: e ? null : state.mail[table] > 0 ? [{ user_id: U }] : [], error: e };
      }
      if ((MAIL as readonly string[]).includes(table) && op === "delete") {
        if (err("mail_delete")) return { data: null, error: err("mail_delete") };
        if (!fail.has(`mail_silent:${table}`)) state.mail[table] = 0;
        return { data: null, error: err("mail_delete_done") }; // deleted, but the answer was an error
      }
      throw new Error(`${table} ${op}`);
    };
    return self;
  };
  let reads = 0, deleted = false;
  const admin = {
    from,
    rpc: async (fn: string, a: { p_name: string }) => {
      if (fn === "oauth_vault_read") {
        reads++;
        if (err("vault_read") || (deleted && err("vault_read_after"))) return { data: null, error: err("vault_read") ?? err("vault_read_after") };
        return { data: state.vault[a.p_name] ?? null, error: null };
      }
      if (fn === "oauth_vault_delete") {
        if (err("vault_delete")) return { data: null, error: err("vault_delete") };
        delete state.vault[a.p_name]; deleted = true;
        return { data: null, error: err("vault_delete_done") }; // deleted, but the answer was an error (a timeout after commit)
      }
      throw new Error(fn);
    },
  };
  return { admin, state, mailTotal, reads: () => reads };
}
const U = "00000000-0000-4000-8000-0000000004b1";
const ok200 = { fetch: (async () => new Response("", { status: 200 })) as typeof fetch, sleep: async () => {}, timeoutMs: 20 };
const down = { fetch: (async () => { throw new TypeError("down"); }) as typeof fetch, sleep: async () => {}, timeoutMs: 20 };
const grant = (p: string) => ({ [`oauth_${p}_${U}`]: JSON.stringify({ refresh_token: `rt-${p}` }) });
const MAIL_SAID = "delete the application updates, drafts and read time saved from your Gmail";

Deno.test("GV/6 disconnect: revoked, deleted and read back; every failure path is ok:false and said plainly", async () => {
  let w = adminDouble({ rows: ["google_career", "gmail"], vault: { ...grant("google_career"), ...grant("gmail") }, mail: 2 });
  let r = await disconnectGoogle(w.admin, U, ok200);
  eq([r.ok, r.had, r.revoke, r.failures, r.mailErased], [true, ["google_career", "gmail"], { google_career: "revoked", gmail: "revoked" }, [], true], "both grants");
  eq([w.state.rows, w.state.vault, w.mailTotal()], [[], {}, 0], "rows, tokens and mail rows gone");
  assert(/^Gmail is disconnected\. Google confirmed Trainee's access is revoked\. I deleted the stored access and the application updates I had read from your Gmail\./.test(disconnectReply(r)), disconnectReply(r));
  w = adminDouble({ rows: ["google_career"], vault: grant("google_career"), mail: 1 });
  r = await disconnectGoogle(w.admin, U, down);
  eq([r.ok, r.revoke.google_career], [true, "not_confirmed"], "Google unreachable: still deleted, revoke not confirmed");
  assert(/Gmail is disconnected\. Google didn't confirm that Trainee's access is revoked, so please remove Trainee at myaccount\.google\.com\/permissions/.test(disconnectReply(r)), disconnectReply(r));
  r = await disconnectGoogle(adminDouble().admin, U, ok200);
  eq([r.ok, r.had, r.mailErased], [true, [], false], "nothing connected");
  eq(disconnectReply(r), "No Google account is connected to Trainee, so there was nothing to disconnect.", "said so");
  const cases: [string, string][] = [
    ["row_read", "read which Google accounts are connected"], ["vault_read", "read the stored Google access to revoke it"],
    ["vault_delete", "delete the stored Google tokens"], ["row_delete", "delete the Google connection"],
    ["row_delete_silent", "delete the Google connection"], ["mail_read", "check that everything was deleted"],
    // The store answered an error though the delete went through: never reported as done (the person retries; it is safe).
    ["vault_delete_done", "delete the stored Google tokens"], ["row_delete_done", "delete the Google connection"],
    // The read-backs themselves failing: not knowing is not "deleted".
    ["row_readback", "check that everything was deleted"], ["mail_readback", "check that everything was deleted"],
    ["vault_read_after", "check that everything was deleted"],
    // The mail delete failing, or "succeeding" without removing a table's rows (each table is judged on its own).
    ["mail_delete", MAIL_SAID], ["mail_delete_done", MAIL_SAID], ["mail_silent:career_mail_events", MAIL_SAID], ["mail_silent:career_mail_drafts", MAIL_SAID], ["mail_silent:career_mail_cursors", MAIL_SAID],
  ];
  for (const [f, said] of cases) {
    // A mail delete that fails or removes nothing is tried against a database without the trigger, which would clear the rows itself.
    w = adminDouble({ rows: ["google_career"], vault: grant("google_career"), mail: 1, fail: new Set([f]), trigger: !f.startsWith("mail_") || f.endsWith("read") || f.endsWith("readback") });
    r = await disconnectGoogle(w.admin, U, ok200);
    eq(r.ok, false, `${f}: not ok`);
    assert(r.failures.includes(said), `${f}: ${JSON.stringify(r.failures)}`);
    const reply = disconnectReply(r);
    assert(reply.startsWith("I couldn't finish disconnecting Gmail: I wasn't able to ") && reply.includes(said) && /Say "disconnect gmail" again to retry\./.test(reply), `${f}: ${reply}`);
    assert(!/I deleted/.test(reply), `${f}: a failed disconnect never says it deleted anything: ${reply}`);
  }
  // A token left behind (the delete said yes but the read-back still finds it) is a failure too.
  w = adminDouble({ rows: ["google_career"], vault: grant("google_career") });
  const sticky = { ...w.admin, rpc: async (fn: string, a: { p_name: string }) => fn === "oauth_vault_delete" ? { data: null, error: null } : w.admin.rpc(fn, a) };
  r = await disconnectGoogle(sticky, U, ok200);
  eq([r.ok, r.failures], [false, ["delete the stored Google tokens"]], "read-back finds the token");
  // A legacy-only disconnect does not judge or touch mail rows (they belong to the career grant, which stays).
  w = adminDouble({ rows: ["google_career", "gmail"], vault: { ...grant("google_career"), ...grant("gmail") }, mail: 3 });
  r = await disconnectGoogle(w.admin, U, ok200, ["gmail"]);
  eq([r.ok, w.state.rows, w.mailTotal(), r.mailChecked], [true, ["google_career"], 9, false], "only the legacy grant goes");
  assert(/I deleted the stored access\. Your application tracker/.test(disconnectReply(r)) && !/application updates/.test(disconnectReply(r)), disconnectReply(r));
});

Deno.test("GV/6b the migration is not needed for a disconnect to delete the mail rows, and stray mail rows are cleaned up", async () => {
  // Code deployed before migration 20261026200011: the database has no trigger, so the code itself deletes the mail rows.
  let w = adminDouble({ rows: ["google_career"], vault: grant("google_career"), mail: 2, trigger: false });
  let r = await disconnectGoogle(w.admin, U, ok200);
  eq([r.ok, r.mailErased, w.mailTotal(), w.state.rows], [true, true, 0, []], "no trigger: the mail rows are still deleted");
  assert(/I deleted the stored access and the application updates I had read from your Gmail\./.test(disconnectReply(r)), disconnectReply(r));
  // Mail rows with no connection left (a mail check that was running when the person disconnected): saying it again cleans up.
  w = adminDouble({ mail: 2 });
  r = await disconnectGoogle(w.admin, U, ok200);
  eq([r.ok, r.had, r.mailErased, w.mailTotal()], [true, [], true, 0], "stray mail rows deleted though nothing is connected");
  eq(disconnectReply(r), "No Google account is connected to Trainee, but I deleted the application updates, drafts and read time still saved from an earlier connection. Your application tracker and this chat keep their history.", "and said so, not 'nothing to disconnect'");
  // Connected, but no mail was ever tracked: it does not claim to have deleted any.
  w = adminDouble({ rows: ["google_career"], vault: grant("google_career") });
  r = await disconnectGoogle(w.admin, U, ok200);
  eq([r.ok, r.mailErased], [true, false], "nothing tracked");
  assert(/I deleted the stored access\. No application updates had been saved from your Gmail\./.test(disconnectReply(r)), disconnectReply(r));
  // Stray rows that cannot be deleted: not ok, and never reported as nothing to do.
  w = adminDouble({ mail: 1, fail: new Set(["mail_silent:career_mail_cursors"]) });
  r = await disconnectGoogle(w.admin, U, ok200);
  eq([r.ok, r.failures], [false, [MAIL_SAID]], "stray rows that stay");
  assert(/^I couldn't finish disconnecting Gmail/.test(disconnectReply(r)), disconnectReply(r));
});

Deno.test("GV/9 the asks that disconnect, and the ones that don't", () => {
  for (const t of ["disconnect gmail", "Disconnect my Gmail", "disconnect google", "disconnect my google account", "remove access to gmail", "revoke gmail.", "please unlink my gmail"]) assert(isGoogleDisconnect(t), t);
  for (const t of ["disconnect linkedin", "should I disconnect gmail?", "how do I disconnect gmail", "connect gmail", "disconnect gmail and then apply to Stripe", "don't disconnect gmail"]) assert(!isGoogleDisconnect(t), t);
});

Deno.test("GV/10 the legacy finance consent is off for Trainee; the career grant ends on its own page and its own redirect", async () => {
  eq([startAllowed("career", env()), startAllowed("gmail", env()), startAllowed("gmail", env({ UPMORE_LEGACY_GMAIL_CONNECT: "on" }))], [true, false, true], "legacy only by the owner's switch");
  assert(/switched off/.test(LEGACY_OFF_MESSAGE), "and the refusal says so");
  const page = await careerLanding(true).text();
  assert(/Gmail connected/.test(page) && !/upmore/i.test(page), "the landing is Trainee's, with no Upmore link");
  eq(careerLanding(false).status, 400, "a failed grant says so");
  eq(redirectUriFrom(env({ SUPABASE_URL: "https://ref.supabase.co/" })), "https://ref.supabase.co/functions/v1/gmail-oauth", "default");
  eq(redirectUriFrom(env({ SUPABASE_URL: "https://ref.supabase.co", GOOGLE_OAUTH_REDIRECT_URI: "https://trainee.example/connect/google" })), "https://trainee.example/connect/google", "Trainee's domain");
  eq(redirectUriFrom(env({ SUPABASE_URL: "https://ref.supabase.co", GOOGLE_OAUTH_REDIRECT_URI: "http://evil.example/x" })), "https://ref.supabase.co/functions/v1/gmail-oauth", "never a non-https one");
});

const TEMPLATES = { privacy: read("docs/launch/legal-pages/privacy.template.html"), terms: read("docs/launch/legal-pages/terms.template.html"), home: read("site/index.html") };
const SAMPLE = { LEGAL_NAME: "Sample Test Entity", SUPPORT_EMAIL: "help@trainee.example", GOVERNING_STATE: "Sample State" };
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");

Deno.test("GV/11 the legal pages are never published with a placeholder: the build refuses until the owner fills every input", async () => {
  const inputs = JSON.parse(read("docs/launch/legal-pages/owner-inputs.json"));
  eq(OWNER_INPUTS, ["LEGAL_NAME", "SUPPORT_EMAIL", "GOVERNING_STATE"], "the owner inputs");
  eq(missingInputs(inputs), ["LEGAL_NAME", "SUPPORT_EMAIL", "GOVERNING_STATE"], "today every one is unfilled (no value invented)");
  eq(buildLegal(inputs, TEMPLATES), { ok: false, missing: ["LEGAL_NAME", "SUPPORT_EMAIL", "GOVERNING_STATE"], left: [] }, "so the build refuses");
  eq(missingInputs({ ...SAMPLE, SUPPORT_EMAIL: "not an email" }), ["SUPPORT_EMAIL"], "a malformed email is refused");
  eq(missingInputs({ ...SAMPLE, LEGAL_NAME: "{{LEGAL_NAME}}" }), ["LEGAL_NAME"], "a placeholder as a value is refused");
  eq(missingInputs({ ...SAMPLE, GOVERNING_STATE: "  " }), ["GOVERNING_STATE"], "blank is refused");
  // The command itself: exit 1, nothing written.
  const out = await Deno.makeTempDir();
  const run = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", "scripts/launch/build-legal-pages.ts", "--out", out], cwd: ROOT.pathname, stdout: "piped", stderr: "piped" }).output();
  eq(run.code, 1, "the build exits 1");
  assert(/REFUSED: owner inputs missing or invalid: LEGAL_NAME, SUPPORT_EMAIL, GOVERNING_STATE/.test(new TextDecoder().decode(run.stderr)), new TextDecoder().decode(run.stderr));
  eq([...Deno.readDirSync(out)].length, 0, "and writes nothing");
  // Nothing under site/ carries a placeholder, and the pages are not published yet.
  const walk = (dir: URL): string[] => [...Deno.readDirSync(dir)].flatMap((e) => e.isDirectory ? walk(new URL(`${e.name}/`, dir)) : /\.(html|js|json|txt)$/.test(e.name) ? [new URL(e.name, dir).pathname] : []);
  for (const f of walk(new URL("site/", ROOT))) assert(!/\{\{(LEGAL_NAME|SUPPORT_EMAIL|GOVERNING_STATE|DOMAIN)\}\}/.test(Deno.readTextFileSync(f)), `${f} carries a placeholder`);
  for (const f of ["site/privacy.html", "site/terms.html", "site/google.html"]) assert(!(() => { try { Deno.statSync(new URL(f, ROOT)); return true; } catch { return false; } })(), `${f} is not published before the owner's inputs`);
});

Deno.test("GV/12 once filled, the pages say only what the code does, with Google's Limited Use statement", async () => {
  const r = buildLegal(SAMPLE, TEMPLATES);
  assert(r.ok, JSON.stringify(r));
  const f = (r as any).built.files as Record<string, string>;
  for (const [n, html] of Object.entries(f)) eq(placeholdersIn(html), [], `${n}: no placeholder, bracketed instruction or template note left`);
  const t = text(f["privacy.html"]);
  assert(t.includes("Trainee's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements."), "Limited Use, verbatim");
  assert(/never used to create, train or improve a machine learning or artificial intelligence model/.test(t), "AI/ML statement");
  for (const s of ["openid", "email", "gmail.readonly"]) assert(f["privacy.html"].includes(`<code>${s}</code>`), `names ${s}`);
  for (const s of ["gmail.send", "calendar", "gmail.modify", "mail.google.com"]) assert(!f["privacy.html"].includes(`<code>${s}`), `does not claim ${s}`);
  assert(/Say "disconnect gmail" to Trainee at any time\. Trainee revokes its access at Google, deletes the stored tokens, and deletes the tracked email results, drafts and read time described above\. If Google doesn't confirm the revoke, or anything can't be deleted, Trainee tells you so in its reply\./.test(t),
    "the disconnect promise GV/6 and flow-google-disconnect keep");
  assert(t.includes("Sample Test Entity") && t.includes("help@trainee.example"), "the owner's inputs filled in");
  const home = f["index.html"];
  assert(!/#product\/privacy|#product\/terms/.test(home) && (home.match(/href="\/privacy"/g) ?? []).length >= 3 && (home.match(/href="\/terms"/g) ?? []).length >= 2, "homepage links /privacy and /terms");
  assert(!/\[Describe how connections are authorized|\[Name, phone number, resume contents|support@example\.com/.test(home), "and no template text or example address is left");
  eq(f["google.html"], buildNoticePage(f["privacy.html"]), "the notice page is the notice");
  const n = consentNotice([OPENID, EMAIL, GMAIL_READONLY], { modelCheck: true });
  for (const line of [...n.reads, ...n.never, ...n.undo]) assert(text(f["google.html"]).includes(line), `notice: ${line}`);
  assert(/<h1>Trainee Terms of Service<\/h1>/.test(f["terms.html"]) && t.length > 0, "terms built");
  // The command writes the same files when the inputs are given.
  const dir = await Deno.makeTempDir(), inputs = `${dir}/inputs.json`;
  Deno.writeTextFileSync(inputs, JSON.stringify(SAMPLE));
  const run = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", "scripts/launch/build-legal-pages.ts", "--inputs", inputs, "--out", dir], cwd: ROOT.pathname, stdout: "piped", stderr: "piped" }).output();
  eq(run.code, 0, new TextDecoder().decode(run.stderr));
  for (const name of Object.keys(f)) eq(Deno.readTextFileSync(`${dir}/${name}`), f[name], `${name} written`);
});

// Review of #196, blocker 1: a successful build ships no placeholder of any kind, and a template that still has one is refused by name.
Deno.test("GV/11b the built pages carry no bracketed placeholder or template note; the check finds each kind, and the build names what it refuses", () => {
  // The detector finds what the review found in the unbuilt homepage (so a build that left them would be refused).
  const raw = placeholdersIn(TEMPLATES.home);
  for (const w of ["[YOUR PRICE]", "[Plan name]", "[What's included]", "[Launch timing]", "[Confirm which connections are live at launch and remove the rest.]", "[Your name]", "[One-line bio]", "[DATE]",
    "Template. Only publish claims that are true of your actual systems.", "support@example.com",
    // Round 3: any "Template." note, any @example address.
    "Template. Carriers review this page when you register your texting number, so keep it accurate.", "Template only. Have a lawyer review this before launch.",
    "careers@example.com", "you@example.com"]) assert(raw.includes(w), `the check finds ${w}: ${JSON.stringify(raw)}`);
  assert(raw.some((x) => x.startsWith("[Paragraph 1:")), "and the story paragraphs");
  // Code is not mistaken for a placeholder.
  eq(placeholdersIn('<script>const a = [0], re = /[A-Z]/, b = x[i]; const d = {k:[1,2]}</script><p>[x]</p><svg><text>[Not Counted Here]</text></svg>'), [], "array indexes, character classes and svg text");
  // A built homepage has none of them, in any file.
  const r = buildLegal(SAMPLE, TEMPLATES);
  assert(r.ok, JSON.stringify(r));
  for (const [n, html] of Object.entries((r as any).built.files as Record<string, string>)) eq(placeholdersIn(html), [], `${n}`);
  // Any one of them left by a template change refuses the build, and it says which.
  const bad: [string, string][] = [
    ["a price", TEMPLATES.home.replace("<h2>Reporting a problem</h2>", "<p>[YOUR PRICE]</p><h2>Reporting a problem</h2>")],
    ["a template note", TEMPLATES.home.replace("<h2>Reporting a problem</h2>", "<p>Template. Only publish claims that are true of your actual systems.</p><h2>Reporting a problem</h2>")],
    ["a {{name}}", TEMPLATES.home.replace("<h2>Reporting a problem</h2>", "<p>{{PRICE}}</p><h2>Reporting a problem</h2>")],
    ["an example address", TEMPLATES.home.replace("<h2>Reporting a problem</h2>", "<p>write to info@example.com</p><h2>Reporting a problem</h2>")],
    ["any example address", TEMPLATES.home.replace("<h2>Reporting a problem</h2>", "<p>write to jobs@example.net</p><h2>Reporting a problem</h2>")],
    ["any template note", TEMPLATES.home.replace("<h2>Reporting a problem</h2>", "<p>Template. Fill this in later.</p><h2>Reporting a problem</h2>")],
    ["a template-only note", TEMPLATES.home.replace("<h2>Reporting a problem</h2>", "<p>Template only. Ask a lawyer.</p><h2>Reporting a problem</h2>")],
  ];
  for (const [what, home] of bad) {
    const x = buildLegal(SAMPLE, { ...TEMPLATES, home });
    assert(!x.ok && (x as any).left.length >= 1, `${what}: the build refuses`);
  }
  const x = buildLegal(SAMPLE, { ...TEMPLATES, home: TEMPLATES.home.replace("<h2>Reporting a problem</h2>", "<p>[YOUR PRICE]</p><h2>Reporting a problem</h2>") });
  eq([x.ok, (x as any).left], [false, ["[YOUR PRICE]"]], "refused, naming the placeholder");
  // The privacy and terms templates themselves carry none once the three owner inputs are filled.
  for (const k of ["privacy", "terms"] as const) eq(placeholdersIn((r as any).built.files[`${k}.html`]), [], k);
});

// Review of #196, blocker 2: with openid, email and gmail.readonly submitted, no page says Trainee sends from the person's
// Gmail or touches a calendar. When Google approves gmail.send (a later submission), the send patterns stop applying.
Deno.test("GV/14 the site never claims sending from Gmail or Calendar while those scopes are not submitted", () => {
  const sends = SUBMITTED_SCOPES.includes(GMAIL_SEND), calendar = SUBMITTED_SCOPES.some((x) => x.includes("calendar"));
  eq([sends, calendar], [false, false], "today's submission");
  const SEND: RegExp[] = [/from your own (email|address|gmail|inbox)/i, /come from your own/i, /sent from you\b/i, /sends? (them|it|emails?|the email|messages?) (from|in) your/i,
    /connect gmail or outlook/i, /sends? (a |the )?(follow-?ups?|notes?|intro|introduction)s? (from|through) your/i];
  const CAL: RegExp[] = [/calendar/i, /books? (the|a) (time|call|chat|slot)/i, /outlook/i, /suggest times/i, /add interviews/i];
  const claims = (html: string) => {
    const t = text(html.replace(/<svg[\s\S]*?<\/svg>/g, " "));
    return [...(sends ? [] : SEND), ...(calendar ? [] : CAL)].flatMap((re) => t.match(new RegExp(re.source, "gi")) ?? []);
  };
  // The check does find the claims the review found, in the unpatched homepage: it is not vacuous.
  const before = claims(TEMPLATES.home);
  for (const w of ["come from your own", "Connect Gmail or Outlook", "suggest times", "Calendar", "books the time"]) assert(before.some((c) => c.toLowerCase().includes(w.toLowerCase())), `found "${w}" in the unpatched homepage: ${JSON.stringify(before)}`);
  const r = buildLegal(SAMPLE, TEMPLATES);
  assert(r.ok, JSON.stringify(r));
  const files = (r as any).built.files as Record<string, string>;
  for (const [n, html] of Object.entries(files)) eq(claims(html), [], `${n} claims sending or Calendar`);
  // Round 3: no people-finding, no tool strip, no job-site connections, anywhere in the built homepage (help pages, tour,
  // home conversations, logo strip). The product answers NO_FINDER (career_networking.ts, D-018a) and connects none of them.
  const FALSE: RegExp[] = [/alumni/i, /team members/i, /finds? (the right )?people/i, /works across the tools/i, /class="wrap logos/,
    /(LinkedIn|Handshake|Indeed)<\/span>/, /\b(use|uses|connect|connects|works with|profile details)\b[^.<]{0,40}\b(LinkedIn|Handshake|Indeed)\b(?! connections export)/i, /(books?|lines? up|sets? up) coffee chats/i];
  const falseIn = (html: string) => { const t = html.replace(/<svg[\s\S]*?<\/svg>/g, " "); return FALSE.flatMap((re) => t.match(new RegExp(re.source, re.flags.includes("i") ? "gi" : "g")) ?? []); };
  const was = falseIn(TEMPLATES.home);
  for (const w of ["alumni", "Works across the tools", "LinkedIn</span>", "Indeed</span>", "Finds the right people", "Books coffee chats"]) assert(was.some((c) => c.toLowerCase() === w.toLowerCase()), `found "${w}" in the unpatched homepage: ${JSON.stringify(was)}`);
  eq(falseIn(files["index.html"]), [], "the built homepage claims people-finding, a tool strip or job-site connections");
  assert(/<code>who do I know at Stripe<\/code>/.test(files["index.html"]) && /It has no people database and never guesses names or email addresses\./.test(files["index.html"]), "and says what it does instead");
  // What the Connections page does say: read-only Gmail, and how to disconnect.
  const conn = text(files["index.html"].slice(files["index.html"].indexOf("slug:'connections'"), files["index.html"].indexOf("slug:'approvals'")));
  assert(/The permission is read-only: Trainee can't send, delete, label or change any email\./.test(conn) && /Say disconnect gmail to Trainee\./.test(conn), conn);
  assert(!/LinkedIn|Handshake|Indeed/.test(conn), "and promises no connection that does not exist");
});

// Review of #196, non-blocking: each public sentence about behavior is tied to the thing that makes it true.
Deno.test("GV/15 policy sentences are tied to their cause: the extension's agentSubmits flag, the erase that keeps the read time, the text-messaging sentence", () => {
  const privacy = text(((buildLegal(SAMPLE, TEMPLATES) as any).built.files as Record<string, string>)["privacy.html"]);
  // (a) "It never submits an application for you" holds only while extension/config.js has agentSubmits: false.
  const flag = (cfg: string) => { const m = [...cfg.matchAll(/^\s*agentSubmits:\s*(true|false)\s*,/gm)]; if (m.length !== 1) throw new Error(`expected one agentSubmits line, found ${m.length}`); return m[0][1] === "true"; };
  const policyBroken = (cfg: string, policy: string) => flag(cfg) && /It never submits an application for you/.test(policy);
  const CONFIG = read("extension/config.js");
  assert(/It never submits an application for you, solves a captcha, or checks a legal attestation\./.test(privacy), "the policy makes the claim");
  eq(flag(CONFIG), false, "extension/config.js ships agentSubmits: false; if the owner turns agent submits on, this fails until the policy sentence is changed");
  eq(policyBroken(CONFIG, privacy), false, "so the claim is true");
  eq(policyBroken(CONFIG.replace("agentSubmits: false,", "agentSubmits: true,"), privacy), true, "and the same check refuses the claim once the flag is on");
  // (b) The policy and the erase agree on the read time: "forget everything" keeps it, a disconnect deletes it.
  assert(/The time it last read up to is kept until you disconnect Google or delete your account: "forget everything" does not delete it/.test(privacy), "the policy says the read time survives forget everything");
  assert(!/career_mail_cursors/.test(read("supabase/migrations/20261021090000_career_mail_erase.sql").replace(/--[^\n]*/g, "")), "and the erase migration really leaves the cursor (tests/db/career_mail_erase.test.sql asserts it on a database)");
  assert(/career_mail_cursors where user_id = old\.user_id/.test(MIGRATION), "while the disconnect trigger deletes it");
  // (c) A mail check running during a disconnect.
  assert(/If a mail check was already running when you disconnected, it can save what it had read just before; Trainee stops it from saving anything it reads after, and saying "disconnect gmail" again deletes whatever it saved\./.test(privacy), "the window is stated as it is");
  assert(/stillConnected/.test(read("supabase/functions/_shared/career_proactive_run.ts")), "and the run really checks (google-disconnect-race.test.ts runs it)");
  // (d) The text-messaging sentence the old Privacy help page had is kept in the policy.
  assert(privacy.includes("No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Text messaging opt-in data and consent will not be shared with any third parties."), "the SMS sentence");
});

// Review of #196, round 3 (architect decision): the tour and the home conversations claim no result the product cannot
// show. Trainee prepares, the person approves the exact card, and a status is said only as the product observes it.
Deno.test("GV/16 the tour claims no counts of sent or under-review applications, no invented results, and shows the approval", () => {
  const conv = (html: string) => {
    const a = html.indexOf("var TOUR = ["), b = html.indexOf("\n};\n", html.indexOf("var THREADS = {"));
    assert(a > 0 && b > a, "the tour and the conversations are found");
    return html.slice(a, b);
  };
  const CLAIMS: RegExp[] = [
    /\b\d+\b[^'\n]{0,40}\b(sent|submitted|applied|applications?|roles?|alumni|people|repl(y|ied|ies)|more|under review|interviews?)\b/gi,
    /\b(all|every)\b[^'\n]{0,20}\bsent\b/gi, /under review/gi, /already (replied|moved)/gi, /one of the first applicants/gi, /\bsent\. /gi,
  ];
  const claims = (t: string) => CLAIMS.flatMap((re) => t.match(new RegExp(re.source, re.flags)) ?? []);
  const before = claims(conv(TEMPLATES.home));
  for (const w of ["all 24 sent", "under review", "found 6 alumni", "one of the first applicants"]) assert(before.some((c) => c.includes(w) || w.includes(c)), `the check finds "${w}" in the unpatched tour: ${JSON.stringify(before)}`);
  const built = conv(((buildLegal(SAMPLE, TEMPLATES) as any).built.files as Record<string, string>)["index.html"]);
  eq(claims(built), [], "the built tour and conversations");
  // The real flow: the exact card is approved before anything is sent, and the status comes from the employer's email.
  assert(/here is exactly what I’ll send'\},\n\s*\{f:'card', side:'you', icon:'check-circle', title:'Summer Analyst – Chicago', sub:'Your answers and resume, ready to approve'\},\n\s*\{f:'me', t:'yes'\},\n\s*\{f:'you', t:'submitted\. I’ll tell you when the employer’s confirmation email arrives'\}/.test(built), "apply: card, yes, then submitted");
  assert(/'ready\. check what I’ll send and say yes'/.test(built), "an alert prepares; it does not send");
});

Deno.test("GV/13 the launch doc states the same scope set the code requests", () => {
  for (const s of SUBMITTED_SCOPES) assert(DOC.includes(s === OPENID || s === EMAIL ? `\`${s}\`` : s), `the doc names ${s}`);
  assert(/gmail\.send[^\n]*Deferred/i.test(DOC), "and records gmail.send as deferred");
  assert(/agent-exec[^\n]*finance/i.test(DOC), "and names agent-exec as the finance leftover");
});
