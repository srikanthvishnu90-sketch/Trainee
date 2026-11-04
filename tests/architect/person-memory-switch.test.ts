// ROOT CAUSE 3: when the person's profile and tracker are the account's (accountMemoryOn, _shared/career_account_memory.ts).
// Default (CAREER_ACCOUNT_MEMORY unset): once they have a texting contact linked, or once the account holds their memory.
// "on" always; "off" never (the owner's kill switch back to per-thread).
import assertNode from "node:assert/strict";
import { accountMemoryOn } from "../../supabase/functions/_shared/career_account_memory.ts";

const env = (v: string | undefined) => ({ get: (k: string) => (k === "CAREER_ACCOUNT_MEMORY" ? v : undefined) });
const P = (textingLinked: boolean | null, accountHasMemory: boolean) => ({ textingLinked, accountHasMemory });

Deno.test("person memory switch: by default, a person with a texting contact linked has account scope", () => {
  for (const v of [undefined, "", "auto"]) assertNode.equal(accountMemoryOn(env(v), P(true, false)), true, `CAREER_ACCOUNT_MEMORY=${v}`);
});
Deno.test("person memory switch: by default, once the account holds the memory it stays the account's", () => {
  for (const linked of [true, false, null]) assertNode.equal(accountMemoryOn(env(undefined), P(linked, true)), true, `linked ${linked}`);
});
Deno.test("person memory switch: by default, a web-only person (or an unreadable contact) keeps per-thread scope", () => {
  assertNode.equal(accountMemoryOn(env(undefined), P(false, false)), false);
  assertNode.equal(accountMemoryOn(env(undefined), P(null, false)), false);
});
Deno.test("person memory switch: on is always, off is never", () => {
  for (const v of ["on", "ON", " on "]) assertNode.equal(accountMemoryOn(env(v), P(false, false)), true, `CAREER_ACCOUNT_MEMORY=${JSON.stringify(v)}`);
  for (const v of ["off", "OFF", " off "]) for (const p of [P(true, true), P(true, false), P(false, true)]) assertNode.equal(accountMemoryOn(env(v), p), false, `CAREER_ACCOUNT_MEMORY=${JSON.stringify(v)}`);
});
