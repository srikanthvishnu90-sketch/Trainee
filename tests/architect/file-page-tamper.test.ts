// The "link states" test in file-page.test.ts checks that a tampered session token is refused (403). Session ids are
// "fs1." plus 64 random hex characters (_shared/file_session.ts newSessionId). Its old tamper, t.slice(0, -3) + "aaa",
// changed nothing when the id already ended in "aaa" (1 in 4,096 runs): the valid session then answered 200 and the
// test failed at random (#354 CI, 2026-11-02). The tamper now always changes the token. This file proves both halves.
import assertNode from "node:assert/strict";
import { newSessionId } from "../../supabase/functions/_shared/file_session.ts";

const OLD = (t: string) => t.slice(0, -3) + "aaa";
const NEW = (t: string) => t.slice(0, -1) + (t.endsWith("a") ? "b" : "a");

Deno.test("the old tamper was a no-op on a token ending in 'aaa'; the new one always changes the token", () => {
  const endsAaa = "fs1." + "0".repeat(61) + "aaa";
  assertNode.equal(OLD(endsAaa), endsAaa, "the old tamper left this token unchanged");
  assertNode.notEqual(NEW(endsAaa), endsAaa);
  for (const t of [endsAaa, "fs1." + "f".repeat(64), "fs1." + "0".repeat(63) + "a", "fs1." + "0".repeat(63) + "b"]) {
    assertNode.notEqual(NEW(t), t, t);
    assertNode.equal(NEW(t).length, t.length, "same shape");
  }
  for (let i = 0; i < 2000; i++) { const t = newSessionId(); assertNode.notEqual(NEW(t), t, t); }
});

Deno.test("file-page.test.ts uses the tamper that always changes the token", () => {
  const src = Deno.readTextFileSync(new URL("./file-page.test.ts", import.meta.url));
  assertNode.ok(src.includes('t.slice(0, -1) + (t.endsWith("a") ? "b" : "a")'), "the new tamper is in place");
  assertNode.ok(!src.includes('t.slice(0, -3) + "aaa"'), "the old tamper is gone");
});
