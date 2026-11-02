// The approval code's lockout on real Postgres (review 3 of #370): 20 wrong codes sent at once must each count, so that the
// right code is refused afterwards. A read-then-write counter loses all but one of them; the store must count atomically.
// Real Postgres (tests/flow/pg.ts) behind the PostgREST double, the production supabaseCodeStore over supabase-js.
// Run: CI=true deno test -A --no-check [--import-map=tests/flow/supabase-npm.json] tests/architect/approval-code-lockout-pg.test.ts
import assertNode from "node:assert/strict";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { approvalCodes, MAX_TRIES, supabaseCodeStore } from "../../supabase/functions/_shared/approval_code.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const PERSON = "7b0f8f8e-6a43-4a49-9d2c-0000000a2001";
const SCOPE = { items: [{ ref: "aaaaaaaaaaaa", tag: "1111111111111111", label: "Acme Web — Frontend Engineering Intern" }] };

Deno.test({ name: "lockout (Postgres): 20 wrong codes at once all count; the right code is refused afterwards, and no new code is sent", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) {
    if (CI) throw Error("the lockout test needs Postgres 16 in CI");
    console.log("NOT_RUN locally: no Postgres binaries");
    return;
  }
  const pg = await startPg();
  try {
    await supabaseParity(pg);
    await pg.sql(`insert into auth.users (id, email) values ('${PERSON}', 'lock@example.test'); insert into public.profiles (id) values ('${PERSON}');`);
    await careerHandler(pg, { "tok-lock": PERSON }); // installs the PostgREST double over this database
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const sent: string[] = [];
    const codes = approvalCodes(supabaseCodeStore(admin), async (_u, m) => { sent.push(m.text); return true; });
    const now = Date.parse("2026-11-01T15:00:00Z");
    eq(await codes.send(PERSON, "session-1", now, SCOPE), { ok: true });
    const right = /code is (\d{6})/.exec(sent[0])![1], wrong = String((Number(right) + 1) % 1000000).padStart(6, "0");
    const results = await Promise.all(Array.from({ length: 20 }, () => codes.check(PERSON, "session-1", wrong, now + 1000, SCOPE)));
    assert(results.every((r) => r === "wrong" || r === "locked"), JSON.stringify(results));
    assert(results.filter((r) => r === "wrong").length <= MAX_TRIES - 1, `at most ${MAX_TRIES - 1} wrong before the lock: ${JSON.stringify(results)}`);
    eq(await codes.check(PERSON, "session-1", right, now + 2000, SCOPE), "locked", "the right code is refused after 20 wrong ones");
    const again = await codes.send(PERSON, "session-2", now + 3000, SCOPE);
    eq(again, { ok: false, why: "locked" }, "no new code while locked");
    eq(sent.length, 1);
  } finally {
    await pg.stop?.();
  }
} });
