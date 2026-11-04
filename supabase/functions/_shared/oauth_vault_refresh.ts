// A refreshed OAuth token is written back only while its connection exists (ERASE SCENARIOS ROUND 2, 2026-10-30).
// Every refresh wrote with oauth_vault_store, which writes whatever it is given: a refresh that read the grant before a
// disconnect (or an account deletion) committed wrote a fresh Vault entry after it, refresh token included, for a
// connection that no longer existed, and nothing ever removed it. oauth_vault_refresh (20261030050000) writes only while
// the connection row is there and holds that row while it does; false means the row is gone: nothing was written and the
// token must not be used (careerTokenFor and outlookToken then answer as for a grant that is not connected).
// On a project where that migration is not applied yet, the old write is used, so the code and the migration can be
// deployed in either order.
// deno-lint-ignore-file no-explicit-any
const MISSING = /oauth_vault_refresh|PGRST202|could not find the function/i;

export async function vaultRefreshWrite(admin: { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: any }> }, name: string, secret: string, what: string): Promise<boolean> {
  const r = await admin.rpc("oauth_vault_refresh", { p_name: name, p_secret: secret });
  if (!r.error) return r.data !== false;
  if (MISSING.test(`${r.error?.code ?? ""} ${r.error?.message ?? ""}`) && /exist|find|no function|PGRST202/i.test(`${r.error?.code ?? ""} ${r.error?.message ?? ""}`)) {
    const s = await admin.rpc("oauth_vault_store", { p_name: name, p_secret: secret });
    if (s.error) throw new Error(what);
    return true;
  }
  throw new Error(what);
}
