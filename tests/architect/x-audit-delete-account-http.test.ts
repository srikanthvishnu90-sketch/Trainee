// x-audit (2026-11-10), E.11 "account deletion": the delete-account HTTP step (supabase/functions/delete-account/handler.ts)
// run directly. The deletion itself is proven on real Postgres by flow-scenarios-erase-r2.test.ts; this proves the door in
// front of it: only POST, only a signed-in account, and only an explicit confirmation posted for THAT account deletes.
// Counted: how many requests reached deleteAccount, and for which account.
// Run: deno test -A --no-check tests/architect/x-audit-delete-account-http.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { handleDeleteAccount } from "../../supabase/functions/delete-account/handler.ts";
import type { AccountDeleteResult } from "../../supabase/functions/_shared/account_delete.ts";

const A = "00000000-0000-4000-8000-0000000000a1", B = "00000000-0000-4000-8000-0000000000b2";
const JWT: Record<string, string> = { "jwt-a": A, "jwt-b": B };

function harness(outcome: Partial<AccountDeleteResult> = {}) {
  const deleted: string[] = [];
  const deps = {
    userOf: (jwt: string) => Promise.resolve(JWT[jwt] ?? null),
    deleteAccount: (uid: string) => {
      deleted.push(uid);
      return Promise.resolve({ deleted: true, google: {}, outlook: false, failures: [], ...outcome } as AccountDeleteResult);
    },
    words: (r: AccountDeleteResult) => (r.deleted ? "Your account is deleted." : "Not deleted."),
  };
  const call = (o: { method?: string; jwt?: string; body?: unknown; raw?: string }) => handleDeleteAccount(new Request("https://x.test/functions/v1/delete-account", {
    method: o.method ?? "POST",
    headers: o.jwt ? { Authorization: `Bearer ${o.jwt}`, "content-type": "application/json" } : { "content-type": "application/json" },
    body: (o.method ?? "POST") === "POST" ? (o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body))) : undefined,
  }), deps);
  return { deleted, call };
}

Deno.test("a GET, no session, or a session GoTrue does not know: refused, nothing deleted", async () => {
  const h = harness();
  assertEquals((await h.call({ method: "GET", jwt: "jwt-a" })).status, 405);
  assertEquals((await h.call({ body: { confirm: "DELETE", user_id: A } })).status, 401);
  assertEquals((await h.call({ jwt: "forged", body: { confirm: "DELETE", user_id: A } })).status, 401);
  assertEquals(h.deleted, []);
});

Deno.test("no explicit confirmation for this account: 400, nothing deleted (6 shapes)", async () => {
  const h = harness();
  const shapes: { body?: unknown; raw?: string }[] = [
    {}, // no body at all (the frozen Upmore client's call)
    { raw: "not json" },
    { body: {} },
    { body: { confirm: "delete", user_id: A } }, // the phrase is exact
    { body: { confirm: "DELETE" } }, // no account named
    { body: { confirm: "DELETE", user_id: B } }, // another account's id under A's session
  ];
  const statuses = [];
  for (const s of shapes) statuses.push((await h.call({ jwt: "jwt-a", ...s })).status);
  assertEquals(statuses, [400, 400, 400, 400, 400, 400]);
  assertEquals(h.deleted, []);
});

Deno.test("the exact confirmation for the signed-in account deletes that account only; a failed read-back is 502", async () => {
  const h = harness();
  const r = await h.call({ jwt: "jwt-a", body: { confirm: "DELETE", user_id: A } });
  assertEquals(r.status, 200);
  assertEquals((await r.json()).user_id, A);
  assertEquals(h.deleted, [A]);
  const f = harness({ deleted: false, failures: ["auth user still present"] });
  assertEquals((await f.call({ jwt: "jwt-b", body: { confirm: "DELETE", user_id: B } })).status, 502);
  assertEquals(f.deleted, [B]);
});
