// delete-account's HTTP step, apart from the server so a test runs it (tests/architect/x-audit-delete-account-http.test.ts).
// x-audit (2026-11-10): the account is deleted only on an explicit confirmation posted for THAT account:
// { confirm: "DELETE", user_id: <the signed-in account's id> }. An empty body, another phrase, a lowercase "delete" or
// another account's id answers 400 and deletes nothing (the body used to be optional: any signed-in POST deleted).
import type { AccountDeleteResult } from "../_shared/account_delete.ts";

export interface DeleteAccountDeps {
  userOf(jwt: string): Promise<string | null>; // the account a JWT belongs to (GoTrue /auth/v1/user), or null
  deleteAccount(uid: string): Promise<AccountDeleteResult>;
  words(r: AccountDeleteResult): string;
}

export async function handleDeleteAccount(req: Request, d: DeleteAccountDeps): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return new Response("missing auth", { status: 401 });
  const uid = await d.userOf(jwt).catch(() => null);
  if (!uid) return new Response("invalid session", { status: 401 });
  // deno-lint-ignore no-explicit-any
  let body: any = null;
  try { body = await req.json(); } catch { body = null; }
  if (!body || body.confirm !== "DELETE" || body.user_id !== uid) {
    return new Response(JSON.stringify({ deleted: false, error: "confirmation required", message: "Nothing was deleted. Confirm by sending {confirm: \"DELETE\", user_id} for this account." }),
      { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const r = await d.deleteAccount(uid);
  return new Response(JSON.stringify({
    deleted: r.deleted, user_id: uid, google: r.google, outlook: r.outlook, failures: r.failures, message: d.words(r),
  }), { status: r.deleted ? 200 : 502, headers: { "Content-Type": "application/json" } });
}
