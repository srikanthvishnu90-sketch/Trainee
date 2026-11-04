// Account deletion (delete-account), in one place: the order, the provider revokes, what the person is told.
// ERASE SCENARIOS, ROUND 2 (2026-10-30; tests/architect/scenarios-erase-r2.test.ts, flow-scenarios-erase-r2.test.ts): the
// function deleted the rows and the Vault entries (they cascade from auth.users), but the person's Google grant stayed valid
// AT GOOGLE: Trainee never asked Google to revoke it, so "my account is deleted" left Trainee holding access in Google's
// eyes (the person's Google security page still listed it). And it answered {deleted: true} whatever happened on the way.
// Now, in this order:
//   1. every Google grant the person holds (google_career, and the legacy finance grant gmail) is revoked at Google with its
//      stored refresh token, else its access token (revokeAtGoogle: only Google's 200 counts). Microsoft has no endpoint that
//      revokes one app's grant, so an Outlook grant is said, with where to remove the app. A revoke Google does not confirm
//      never blocks the deletion: the person is told, and it is recorded (account_deletion_log);
//   2. the connection rows are deleted, which cancels every email still waiting on those mailboxes (the disconnect triggers),
//      before anything slower runs; a worker already holding one asks career_send_go before it sends and is told to stop;
//   3. the Vault secrets, the saved resume files (Storage has no cascade) and the rows with no cascade, as before;
//   4. the action ledger, then the auth user (everything else cascades from it), then read back: the account is gone and
//      no Vault entry of the person's is left. What the person is told (deletionWords) is only what that read-back shows.
// BILLING ROUND 2 (2026-10-30; tests/architect/scenarios-billing-r2.test.ts, flow-scenarios-billing-r2.test.ts): a person
// with a live Trainee plan who deleted their account kept being charged. The subscription row went with the account (it
// cascades), Stripe kept renewing, and stripe-webhook then ignored every event for a person who no longer exists, so
// nothing could ever cancel it by text again. Now, first of all (endBilling, when the edge function wires Stripe): a live
// subscription on the person's row is cancelled at Stripe at once (no proration, no refund promised), and only Stripe's
// "canceled" counts. When Stripe does not confirm it, nothing is deleted and the person is told why: deleting would leave
// them paying for an account that no longer exists.
// The steps run against the project's REST API (restDeps) in the edge function, and against real Postgres in the tests.
// deno-lint-ignore-file no-explicit-any
import { GOOGLE_PROVIDERS, type RevokeDeps, type RevokeOutcome, revokeAtGoogle } from "./google_disconnect.ts";
import { MICROSOFT_NOTE } from "./outlook_connector.ts";

export interface AccountDeleteDeps extends RevokeDeps {
  grants(uid: string): Promise<string[] | null>; // the providers connected (null: could not be read)
  vaultRead(name: string): Promise<{ ok: boolean; secret: string | null }>;
  disconnect(uid: string): Promise<boolean>; // delete the connection rows (the disconnect triggers cancel what waits)
  purgeSecrets(uid: string): Promise<boolean>; // every Vault secret the person has
  removeFiles(uid: string): Promise<boolean>; // the career-resumes folder
  purgeRows(uid: string): Promise<boolean>; // rows with no cascade
  purgeLedger(uid: string): Promise<{ ok: boolean; detail?: string }>;
  deleteUser(uid: string): Promise<{ ok: boolean; status: number; detail?: string }>;
  userExists(uid: string): Promise<boolean | null>;
  secretsLeft(uid: string): Promise<string[] | null>;
  record(entry: DeletionRecord): Promise<boolean>;
  // Billing round 2: cancel a live Trainee subscription at Stripe before anything is deleted. "none": no live plan;
  // "cancelled": Stripe says it is canceled; "failed": not confirmed (nothing may be deleted). Optional: absent, no step.
  endBilling?(uid: string): Promise<BillingEnd>;
}
export type BillingEnd = "none" | "cancelled" | "failed";
export interface DeletionRecord { deleted: boolean; google: Record<string, RevokeOutcome>; outlook: boolean; failures: string[] }
export interface AccountDeleteResult extends DeletionRecord {
  had: string[]; // the providers connected before
  disconnected: boolean; // the connection rows were deleted (what waited on those mailboxes is cancelled)
  grantsRead: boolean;
  recorded: boolean;
  billing?: BillingEnd;
}

const SAID = {
  grants: "check which Google and Microsoft accounts were connected",
  vault: "read the stored Google access to revoke it",
  files: "delete your saved resume files",
  secrets: "delete the stored access tokens",
  ledger: "delete your account",
  user: "delete your account",
  check: "check that everything was deleted",
  billing: "cancel your Trainee plan at Stripe",
} as const;

export async function deleteAccount(d: AccountDeleteDeps, uid: string): Promise<AccountDeleteResult> {
  const failures: string[] = [], google: Record<string, RevokeOutcome> = {};
  // 0. The plan: a live subscription is cancelled at Stripe first; unconfirmed, nothing at all is deleted.
  const billing: BillingEnd | undefined = d.endBilling ? await d.endBilling(uid).catch(() => "failed" as const) : undefined;
  if (billing === "failed") {
    const out = { deleted: false, google, outlook: false, failures: [SAID.billing] };
    const recorded = await d.record(out).catch(() => false);
    return { ...out, had: [], disconnected: false, grantsRead: true, recorded, billing };
  }
  // 1. Revoke at Google, while the stored tokens can still be read.
  const read = await d.grants(uid).catch(() => null);
  const had = read ?? [];
  if (read === null) failures.push(SAID.grants);
  for (const p of had.filter((x) => (GOOGLE_PROVIDERS as readonly string[]).includes(x))) {
    const v = await d.vaultRead(`oauth_${p}_${uid}`).catch(() => ({ ok: false, secret: null }));
    if (!v.ok) { google[p] = "not_confirmed"; failures.push(SAID.vault); continue; }
    google[p] = await revokeAtGoogle(d, v.secret);
  }
  const outlook = had.includes("microsoft");
  // 2. The connection rows: every email still waiting on those mailboxes is cancelled now.
  const disconnected = await d.disconnect(uid).catch(() => false);
  // 3. Secrets, files, rows with no cascade.
  if (!(await d.purgeSecrets(uid).catch(() => false))) failures.push(SAID.secrets);
  if (!(await d.removeFiles(uid).catch(() => false))) failures.push(SAID.files);
  await d.purgeRows(uid).catch(() => false);
  // 4. The ledger, then the account. Either failing leaves the account in place, and the person is told so.
  let gotrue = false; // the auth API said the account is deleted (or was already gone: 404)
  const ledger = await d.purgeLedger(uid).catch((e) => ({ ok: false, detail: String(e?.message ?? e) }));
  if (ledger.ok) {
    const del = await d.deleteUser(uid).catch((e) => ({ ok: false, status: 0, detail: String(e?.message ?? e) }));
    gotrue = del.ok || del.status === 404;
  }
  // Read back: the person is told what is true, not what was attempted. The account is gone when the read-back says so,
  // or, when the read-back cannot be made, when the auth API itself confirmed the delete.
  const exists = await d.userExists(uid).catch(() => null);
  const deleted = exists === false || (exists === null && gotrue);
  if (!deleted) failures.push(ledger.ok ? SAID.user : SAID.ledger);
  const left = await d.secretsLeft(uid).catch(() => null);
  if (left === null) failures.push(SAID.check);
  else if (left.length) failures.push(SAID.secrets);
  const out = { deleted, google, outlook, failures: [...new Set(failures)] };
  const recorded = await d.record(out).catch(() => false);
  return { ...out, had, disconnected, grantsRead: read !== null, recorded, ...(billing ? { billing } : {}) };
}

export const GOOGLE_PERMISSIONS = "myaccount.google.com/permissions";
// CONNECTORS ROUND 3 (2026-10-31): what a deletion keeps, said exactly (the person was told only about the opt-out hashes):
// the opt-out and bounce hashes (no link to the person), the deletion's own record (when, and what Google answered, nothing
// that names them, account_deletion_log) when it was written, and, when they had a Trainee plan, Stripe's own record of
// their payments (Stripe keeps it for tax law; Trainee keeps nothing linking it to them).
export const KEPT = {
  hashes: "Hashed addresses of people who asked never to be emailed again, or whose address bounced, are kept with no link to you, so they stay protected.",
  record: "A record that an account was deleted (when, and what Google answered to the revoke), with nothing that names you, is kept.",
  stripe: "Stripe keeps its own record of your past payments, as tax law requires.",
} as const;
export function keptWords(r: Pick<AccountDeleteResult, "recorded" | "billing">): string {
  return ["What is kept:", KEPT.hashes, r.recorded ? KEPT.record : "", r.billing === "cancelled" ? KEPT.stripe : ""].filter(Boolean).join(" ");
}
// What the person is told: only what the read-back and Google's answers show.
export function deletionWords(r: AccountDeleteResult): string {
  const outcomes = Object.values(r.google);
  const googleSaid = !outcomes.length ? ""
    : outcomes.every((o) => o === "revoked") ? "Google confirmed Trainee's access to your Google account is revoked."
    : `Google didn't confirm that Trainee's access is revoked, so please remove Trainee at ${GOOGLE_PERMISSIONS} to be sure.`;
  const unknown = !r.grantsRead
    ? `I couldn't check which Google or Microsoft accounts were connected, so please remove Trainee at ${GOOGLE_PERMISSIONS} and in your Microsoft account if you had connected them.`
    : "";
  const ms = r.outlook ? MICROSOFT_NOTE : "";
  const notes = [googleSaid, unknown, ms].filter(Boolean).join(" ");
  if (r.billing === "failed") {
    return "Your Trainee account was not deleted: your Trainee plan is still live at Stripe and I couldn't confirm cancelling it, so deleting now would leave you paying for an account that no longer exists. Nothing was deleted. Please try again in a minute.";
  }
  const plan = r.billing === "cancelled" ? "Your Trainee plan is cancelled at Stripe, so you won't be charged again." : "";
  if (!r.deleted) {
    const why = r.failures.filter((f) => f !== SAID.user && f !== SAID.ledger);
    return [`Your Trainee account was not deleted: something failed on my side${why.length ? ` (I wasn't able to ${why.join(", or ")})` : ""}, so you can still sign in. Please try again.`,
      r.disconnected && r.had.length ? `I had already disconnected your connected mail${r.had.length > 1 ? " accounts" : ""}, so emails that hadn't gone yet won't be sent.` : "",
      plan, notes].filter(Boolean).join(" ");
  }
  const rest = r.failures.filter((f) => f !== SAID.grants);
  return [
    "Your Trainee account is deleted: your profile, chats, applications, drafts, contacts and connections are gone, and emails that hadn't gone yet won't be sent.",
    plan,
    notes,
    rest.length ? `What I couldn't confirm: I wasn't able to ${rest.join(", or ")}. Email the privacy contact in the privacy policy and it will be finished by hand.` : "",
    keptWords(r),
  ].filter(Boolean).join(" ");
}

// ------------------------------------------------------------------------------------------------ the project's REST API
// The steps over PostgREST, GoTrue's admin API and Storage, with the service key (the edge function's wiring).
// o.billing (the edge function passes it): the Stripe key (absent: a live plan cannot be cancelled, so nothing is deleted)
// and the fetch Stripe is reached with.
export function restDeps(SUPABASE_URL: string, SERVICE_KEY: string, f: typeof fetch, o: { sleep?: (ms: number) => Promise<void>; googleFetch?: typeof fetch;
  billing?: { stripeKey: string | null | undefined; fetch?: typeof fetch } } = {}): AccountDeleteDeps {
  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
  const J = { ...H, "Content-Type": "application/json" };
  const rpc = (name: string, args: unknown) => f(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: "POST", headers: J, body: JSON.stringify(args) });
  const drain = async (r: Response) => { await r.body?.cancel().catch(() => {}); return r.ok; };
  const billing = o.billing;
  return {
    fetch: o.googleFetch ?? f,
    sleep: o.sleep,
    ...(billing ? { endBilling: (uid: string) => endBillingAtStripe(SUPABASE_URL, H, f, billing.fetch ?? f, billing.stripeKey, uid) } : {}),
    async grants(uid) {
      const r = await f(`${SUPABASE_URL}/rest/v1/user_oauth_connections?user_id=eq.${uid}&select=provider`, { headers: H });
      if (!r.ok) { await r.body?.cancel().catch(() => {}); return null; }
      return ((await r.json()) ?? []).map((x: any) => String(x.provider));
    },
    async vaultRead(name) {
      const r = await rpc("oauth_vault_read", { p_name: name });
      if (!r.ok) { await r.body?.cancel().catch(() => {}); return { ok: false, secret: null }; }
      const v = await r.json();
      return { ok: true, secret: typeof v === "string" ? v : null };
    },
    async disconnect(uid) {
      return drain(await f(`${SUPABASE_URL}/rest/v1/user_oauth_connections?user_id=eq.${uid}`, { method: "DELETE", headers: H }));
    },
    async purgeSecrets(uid) {
      let ok = true;
      // FIX (QA-B 2026-09-27): the vaulted SimpleFIN Access URL (connection rows cascade; the Vault has none).
      ok = (await drain(await f(`${SUPABASE_URL}/rest/v1/rpc/simplefin_vault_delete`, { method: "POST", headers: J, body: JSON.stringify({ p_name: `simplefin_access_url_${uid}` }) }))) && ok;
      // FIX (QA-D 2026-09-27): vaulted merchant credentials (exec_cred_{uid}_{merchant_key}), named by their refs rows.
      const refsRes = await f(`${SUPABASE_URL}/rest/v1/exec_credential_refs?user_id=eq.${uid}&select=vault_name`, { headers: H });
      if (refsRes.ok) {
        for (const r of (await refsRes.json()) || []) {
          if (!r.vault_name) continue;
          ok = (await drain(await f(`${SUPABASE_URL}/rest/v1/rpc/exec_vault_delete`, { method: "POST", headers: J, body: JSON.stringify({ p_name: r.vault_name }) }))) && ok;
        }
      } else { await refsRes.body?.cancel().catch(() => {}); ok = false; }
      // FIX (QA-D2 2026-09-27): the vaulted Plaid access token has no refs row: named explicitly.
      ok = (await drain(await f(`${SUPABASE_URL}/rest/v1/rpc/exec_vault_delete`, { method: "POST", headers: J, body: JSON.stringify({ p_name: `exec_cred_${uid}_plaid` }) }))) && ok;
      // The OAuth tokens: the connection rows' delete removes them (20261012060000); named here too, so a project without
      // that trigger, or a token written after its row went, is still removed.
      ok = (await drain(await f(`${SUPABASE_URL}/rest/v1/rpc/oauth_vault_delete`, { method: "POST", headers: J, body: JSON.stringify({ p_name: `oauth_gmail_${uid}` }) }))) && ok;
      for (const p of ["google_career", "microsoft"]) {
        ok = (await drain(await f(`${SUPABASE_URL}/rest/v1/rpc/oauth_vault_delete`, { method: "POST", headers: J, body: JSON.stringify({ p_name: `oauth_${p}_${uid}` }) }))) && ok;
      }
      return ok;
    },
    // WO-028: tailored resumes (career-resumes/<uid>/<sha256>.pdf, with the person's name and email). Storage objects have
    // no cascade from auth.users: list the folder and remove every file before the auth user goes.
    async removeFiles(uid) {
      for (let round = 0; round < 50; round++) {
        const listRes = await f(`${SUPABASE_URL}/storage/v1/object/list/career-resumes`, {
          method: "POST",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ prefix: `${uid}/`, limit: 1000, offset: 0 }),
        });
        if (!listRes.ok) { await listRes.body?.cancel().catch(() => {}); return false; }
        const objects = await listRes.json();
        const prefixes = (objects || []).filter((x: any) => x && x.name).map((x: any) => `${uid}/${x.name}`);
        if (!prefixes.length) return true;
        const rmRes = await f(`${SUPABASE_URL}/storage/v1/object/career-resumes`, {
          method: "DELETE",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ prefixes }),
        });
        if (!(await drain(rmRes))) return false;
      }
      return false;
    },
    // FIX (QA-D2 2026-09-27): plaid_requests has no foreign key to the account, so its rows do not cascade.
    async purgeRows(uid) {
      return drain(await f(`${SUPABASE_URL}/rest/v1/plaid_requests?user_id=eq.${uid}`, { method: "DELETE", headers: H }));
    },
    // FIX (QA-B2 2026-09-28): the action ledger's append-only trigger blocks the cascade (purge_user_action_ledger).
    async purgeLedger(uid) {
      const r = await rpc("purge_user_action_ledger", { p_uid: uid });
      if (r.ok) { await r.body?.cancel().catch(() => {}); return { ok: true }; }
      return { ok: false, detail: (await r.text().catch(() => "")).slice(0, 200) };
    },
    // The auth user (cascades to profiles, threads, messages and every career table).
    async deleteUser(uid) {
      const delRes = await f(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: H });
      const detail = delRes.ok ? undefined : (await delRes.text().catch(() => "")).slice(0, 200);
      if (delRes.ok) await delRes.body?.cancel().catch(() => {});
      return { ok: delRes.ok, status: delRes.status, detail };
    },
    async userExists(uid) {
      const r = await f(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, { headers: H });
      await r.body?.cancel().catch(() => {});
      return r.status === 404 ? false : r.ok ? true : null;
    },
    async secretsLeft(uid) {
      const left: string[] = [];
      for (const p of ["google_career", "gmail", "microsoft"]) {
        const r = await rpc("oauth_vault_read", { p_name: `oauth_${p}_${uid}` });
        if (!r.ok) { await r.body?.cancel().catch(() => {}); return null; }
        if (await r.json()) left.push(`oauth_${p}`);
      }
      return left;
    },
    async record(e) {
      return drain(await f(`${SUPABASE_URL}/rest/v1/account_deletion_log`, { method: "POST", headers: { ...J, Prefer: "return=minimal" },
        body: JSON.stringify({ deleted: e.deleted, google: e.google, outlook: e.outlook, failures: e.failures.slice(0, 20) }) }));
    },
  };
}

// The person's live subscriptions, cancelled at Stripe at once (DELETE /v1/subscriptions/{id}: no proration, no refund):
// the one on their row and every other live one of theirs under the same customer (a double checkout: stripe-webhook keeps
// the newest live one on the row, so a row that is not live means none is). Only Stripe's "canceled" counts; a subscription
// Stripe says it does not have is nothing to cancel; anything else is "failed".
const LIVE_STATUSES = ["active", "trialing", "past_due", "unpaid"];
async function endBillingAtStripe(SUPABASE_URL: string, H: Record<string, string>, f: typeof fetch, sf: typeof fetch, key: string | null | undefined, uid: string): Promise<BillingEnd> {
  const r = await f(`${SUPABASE_URL}/rest/v1/user_subscriptions?user_id=eq.${uid}&select=status,stripe_subscription_id,stripe_customer_id`, { headers: H });
  if (!r.ok) { await r.body?.cancel().catch(() => {}); return "failed"; }
  const rows = await r.json().catch(() => null);
  if (!Array.isArray(rows)) return "failed";
  const row = rows[0];
  if (!row || !LIVE_STATUSES.includes(String(row.status)) || typeof row.stripe_subscription_id !== "string" || !row.stripe_subscription_id) return "none";
  // A live plan and no key: it cannot be cancelled, so nothing is deleted.
  const k = String(key ?? "").trim();
  if (!k) return "failed";
  const ids = new Set<string>([row.stripe_subscription_id]);
  const headers = { authorization: `Bearer ${k}`, "stripe-version": "2023-10-16" };
  const read = async (res: Response) => { try { return await res.json(); } catch { return null; } };
  const call = (url: string, init: RequestInit = {}) => sf(url, { ...init, headers, signal: AbortSignal.timeout(10_000) });
  try {
    if (typeof row.stripe_customer_id === "string" && row.stripe_customer_id) {
      const q = new URLSearchParams({ customer: row.stripe_customer_id, status: "all", limit: "100" });
      const list = await call(`https://api.stripe.com/v1/subscriptions?${q}`);
      if (!list.ok) { await list.body?.cancel().catch(() => {}); return "failed"; }
      const j = await read(list);
      if (!Array.isArray(j?.data)) return "failed";
      for (const s of j.data) {
        const owner = typeof s?.metadata?.supabase_user_id === "string" ? s.metadata.supabase_user_id : null;
        if (typeof s?.id === "string" && LIVE_STATUSES.includes(String(s.status)) && (owner === null || owner === uid)) ids.add(s.id);
      }
    }
    let cancelled = 0;
    for (const id of [...ids].sort()) {
      const url = `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`;
      const del = await call(url, { method: "DELETE" });
      if (del.ok) { if (String((await read(del))?.status) !== "canceled") return "failed"; cancelled++; continue; }
      await del.body?.cancel().catch(() => {});
      // Already cancelled, or Stripe has no such subscription: read it back to be sure.
      const now = await call(url);
      if (now.status === 404) { await now.body?.cancel().catch(() => {}); continue; }
      if (!now.ok) { await now.body?.cancel().catch(() => {}); return "failed"; }
      if (!["canceled", "incomplete_expired"].includes(String((await read(now))?.status))) return "failed";
      cancelled++;
    }
    return cancelled ? "cancelled" : "none";
  } catch {
    return "failed";
  }
}
