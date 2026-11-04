// Launch readiness B1 (2026-10-26): every migration that makes a SECURITY DEFINER function revokes EXECUTE on that
// exact function from PUBLIC and anon in the same file, and never grants it back (scripts/launch/definer-revoke-scan.cjs).
// Supabase grants EXECUTE on each new public function to anon by default, so a definer function without that revoke can
// be called with the anon key, which ships in the web page; that is how exec_vault_read came to decrypt Vault secrets
// for anyone on production. The authoritative guard is tests/db/definer_lockdown.test.sql on the real schema; this is
// the early, file-level warning.
// The findings below predate the rule. Each is covered at run time by 20261026230500_definer_execute_lockdown.sql and
// checked on the applied schema by tests/db/definer_lockdown.test.sql. The list may only shrink: a new file must carry
// its revoke. Most are CREATE OR REPLACE of a function an earlier file revoked (Postgres keeps the grants on replace);
// the last is the cloud runner's generated claim (dynamic SQL), whose result definer_lockdown.test.sql checks.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { scan, scanText, definerKeys, definersIn, argTypes, hasReviewedMarker, stripLiterals, REVIEWED_MARKER } = require("../scripts/launch/definer-revoke-scan.cjs");

// FROZEN (2026-10-26): the exact set, not a count. An entry may only be removed, when the scan no longer finds it
// (the test then requires its removal); nothing may be added; swapping one entry for another fails (the swap test).
const GRANDFATHERED = Object.freeze([
  "20260927_000001_referral_program.sql generate_referral_code()",
  "20260927_000001_referral_program.sql assign_referral_code()",
  "20260927_000001_referral_program.sql is_eligible_referrer(uuid)",
  "20260927_000001_referral_program.sql qualify_referral(text)",
  "20260927_000001_referral_program.sql get_referral_stats(uuid)",
  "20260927_000005_referral_pending_credit.sql qualify_referral(text)",
  "20260927_000005_referral_pending_credit.sql credit_pending_referral(uuid)",
  "20260927_000005_referral_pending_credit.sql get_referral_stats(uuid)",
  "20260927_000006_plaid_spend_governor.sql plaid_month_spend(uuid)",
  "20260927_000006_plaid_spend_governor.sql report_ai_anomaly(uuid,integer,integer)",
  "20260928_000007_lesson_upsert_rpc.sql record_agent_lesson(text,text,text,text,text,text,text)",
  "20261010010000_agent_permissions_ledger.sql agent_settings_audit()",
  "20261010030000_obligation_workflows.sql agent_workflow_stop_guard()",
  "20261010040000_financial_evidence.sql agent_financial_disconnect_guard()",
  "20261010060000_payment_execution.sql agent_workflow_store_plan(uuid,uuid,integer,jsonb,text)",
  "20261020050000_career_apply_daily_limit.sql career_apply_card_answer_for(uuid,uuid,int[],timestamp with time zone)",
  "20261021070000_channel_parity.sql career_outbox_claim(timestamp with time zone,integer)",
  "20261021070000_channel_parity.sql career_outbox_claim_key(uuid,text,timestamp with time zone)",
  "20261021075000_career_apply_ops.sql career_apply_claim_own(integer)",
  "20261021075000_career_apply_ops.sql career_apply_card_push_for(uuid,uuid[],text,timestamp with time zone)",
  "20261025100000_career_apply_one_ledger.sql career_apply_email_reserve_for(uuid,jsonb,text,timestamp with time zone)",
  "20261025100000_career_apply_one_ledger.sql career_apply_cloud_refusal(career_apply_jobs,timestamp with time zone)",
  "20261025100000_career_apply_one_ledger.sql career_apply_claim_own(integer,text)",
  "20261025110000_career_apply_bridge_reconcile.sql (dynamic)",
  "20261025140000_career_apply_no_volume_ceiling.sql career_apply_daily_limit(uuid)",
  "20261025140000_career_apply_no_volume_ceiling.sql career_apply_ledger_refusal(uuid,text,text,timestamp with time zone,integer)",
  "20261025140000_career_apply_no_volume_ceiling.sql career_apply_prepare_candidates(timestamp with time zone,integer,integer)",
  "20261025140000_career_apply_no_volume_ceiling.sql (dynamic)",
  "20261025150000_career_apply_pace_parse.sql career_apply_daily_limit(uuid)",
  "20261025160000_career_apply_pace_state.sql career_apply_daily_limit(uuid)",
  "20261025160000_career_apply_pace_state.sql career_apply_ledger_refusal(uuid,text,text,timestamp with time zone,integer)",
  "20261025160000_career_apply_pace_state.sql career_apply_cloud_refusal_own_pace()",
  "20261025160000_career_apply_pace_state.sql (dynamic)",
  "20261025170000_career_apply_card_yes_window.sql career_apply_card_answer_for(uuid,uuid,int[],timestamp with time zone)",
  "20261025180000_career_outbox_card_id.sql career_apply_card_push_for(uuid,uuid[],text,timestamp with time zone)",
  "20261026100000_career_apply_cloud_runner.sql (dynamic)",
]);
const FROZEN_COUNT = 36;
// STRUCTURAL FREEZE: the lockdown migration is the line. A file that sorts at or after it can never be grandfathered, whatever
// this list says or its length is: it must carry its own revoke. The list holds only files that sort before the line.
const LOCKDOWN_FILE = "20261026230500_definer_execute_lockdown.sql";
const MIGRATIONS = path.join(__dirname, "../supabase/migrations");
// The findings of a migrations directory against the frozen set: new ones (never allowed) and listed ones no longer found.
function againstFrozen(dir) {
  const all = scan(dir).map((x) => `${x.file} ${x.key}`);
  return { fresh: all.filter((m) => !GRANDFATHERED.includes(m)), stale: GRANDFATHERED.filter((g) => !all.includes(g)) };
}
// The structural rule, one function for the real directory and for every fixture: grandfathered files that sort at or after
// the lockdown (late), grandfathered files that do not exist (missing), and findings in any file at or after the lockdown,
// whatever the list says (after).
function structuralViolations(grandfathered, dir) {
  const files = grandfathered.map((g) => g.split(" ")[0]);
  return {
    late: files.filter((f) => !(f < LOCKDOWN_FILE)),
    missing: [...new Set(files)].filter((f) => !fs.existsSync(path.join(dir, f))),
    after: scan(dir).filter((x) => !(x.file < LOCKDOWN_FILE)).map((x) => `${x.file} ${x.key}`),
  };
}
const findings = (sql) => scanText("fixture.sql", sql).map((x) => [x.key, x.why]);
const DEF = (name = "public.f", args = "p_user uuid") =>
  `create or replace function ${name}(${args}) returns void language plpgsql security definer set search_path = public as $$ begin end $$;\n`;

test("every migration that makes a SECURITY DEFINER function revokes it from public and anon in the same file", () => {
  const { fresh, stale } = againstFrozen(path.join(__dirname, "../supabase/migrations"));
  assert.deepEqual(fresh, [], `add "revoke all on function <name>(<types>) from public, anon[, authenticated];" to: ${fresh.join("; ")}`);
  assert.deepEqual(stale, [], `these now pass; take them off GRANDFATHERED: ${stale.join("; ")}`);
  assert.ok(GRANDFATHERED.length <= FROZEN_COUNT && new Set(GRANDFATHERED).size === GRANDFATHERED.length, "the frozen set only shrinks");
});

test("the frozen set is structurally closed: every grandfathered file sorts before the lockdown migration, and no later file has a finding", () => {
  assert.ok(fs.existsSync(path.join(MIGRATIONS, LOCKDOWN_FILE)), "the lockdown migration is the line the freeze is drawn at");
  assert.deepEqual(structuralViolations(GRANDFATHERED, MIGRATIONS), { late: [], missing: [], after: [] });
});

test("the structural rule refuses a late or missing grandfathered file, and finds a late leak whatever the list says", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "definer-late-"));
  for (const f of fs.readdirSync(MIGRATIONS)) if (f.endsWith(".sql")) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "20991231000000_late_leaky.sql"), DEF("public.late_leaky", "p text") + "revoke all on function public.late_leaky(text) from public;\n");
  // What an editor of the list would do to admit the leak, plus an entry naming a file that is not there.
  const grandfathered = [...GRANDFATHERED, "20991231000000_late_leaky.sql late_leaky(text)", "20200101000000_gone.sql g()"];
  assert.deepEqual(structuralViolations(grandfathered, dir), {
    late: ["20991231000000_late_leaky.sql"],
    missing: ["20200101000000_gone.sql"],
    after: ["20991231000000_late_leaky.sql late_leaky(text)"],
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the frozen set cannot be gamed: swapping a grandfathered file for a new leaky one fails", () => {
  const src = path.join(__dirname, "../supabase/migrations");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "definer-swap-"));
  for (const f of fs.readdirSync(src)) if (f.endsWith(".sql")) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  assert.deepEqual(againstFrozen(dir), { fresh: [], stale: [] }, "the copy matches the frozen set");
  fs.rmSync(path.join(dir, "20260928_000007_lesson_upsert_rpc.sql"));
  fs.writeFileSync(path.join(dir, "20991231000000_leaky.sql"), DEF("public.leaky", "p text") + "revoke all on function public.leaky(text) from public;\n");
  const r = againstFrozen(dir);
  assert.deepEqual(r.fresh, ["20991231000000_leaky.sql leaky(text)"], "the new leak is caught though the count is unchanged");
  assert.deepEqual(r.stale, ["20260928_000007_lesson_upsert_rpc.sql record_agent_lesson(text,text,text,text,text,text,text)"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the forms migrations use pass", () => {
  assert.deepEqual(findings(DEF() + "revoke all on function public.f(uuid) from public, anon, authenticated;"), []);
  assert.deepEqual(findings(DEF() + "revoke execute on function f(uuid) from public;\nrevoke execute on function f(uuid) from anon;"), [], "two revokes");
  assert.deepEqual(findings(DEF() + "revoke all on function public.f from public, anon;"), [], "no argument list: every overload, as in Postgres");
  assert.deepEqual(findings(DEF("public.f", "p_limit int default 5, out total bigint") + "revoke all on function public.f(integer) from public, anon;"), [],
    "int is integer; OUT parameters are not in the signature");
  assert.deepEqual(findings(DEF() + "grant execute on function public.f(uuid) to anon;\nrevoke all on function public.f(uuid) from public, anon;"), [],
    "a grant before the revoke is undone by it");
  assert.deepEqual(findings("create function y() returns int language sql security invoker as $$ select 1 $$;\n-- create function x() security definer"), []);
});

test("a revoke from public only, or none, fails", () => {
  assert.deepEqual(findings(DEF() + "revoke all on function public.f(uuid) from public;"), [["f(uuid)", "no revoke from public and anon"]]);
  assert.deepEqual(findings("create function f() returns int language sql as $$ select 1 $$ security definer;"), [["f()", "no revoke from public and anon"]],
    "definer after the body");
});

test("bypass 1: granting back to anon or PUBLIC after the revoke fails", () => {
  assert.deepEqual(findings(DEF() + "revoke all on function public.f(uuid) from public, anon;\ngrant execute on function public.f(uuid) to authenticated, anon;"),
    [["f(uuid)", "granted back to public or anon after the revoke"]]);
  assert.deepEqual(findings(DEF() + "revoke all on function public.f(uuid) from public, anon;\ngrant all on function public.f to public;"),
    [["f(uuid)", "granted back to public or anon after the revoke"]], "to PUBLIC, every overload");
  assert.deepEqual(findings(DEF() + "revoke all on function public.f(uuid) from public, anon;\ngrant execute on function public.f(uuid) to authenticated, service_role;"), [],
    "to signed-in people: fine");
});

test("bypass 2: ALTER FUNCTION ... SECURITY DEFINER is a definer function too", () => {
  const plain = "create function public.g(p text) returns text language sql security invoker as $$ select p $$;\n";
  assert.deepEqual(findings(plain + "alter function public.g(text) security definer;"), [["g(text)", "no revoke from public and anon"]]);
  assert.deepEqual(findings(plain + "alter function public.g(text) security definer;\nrevoke all on function public.g(text) from public, anon;"), []);
  assert.deepEqual(findings(plain + "alter function public.g(text) security invoker;"), [], "back to invoker is not a definer");
});

test("bypass 3: a revoke on a different overload does not cover the definer one", () => {
  assert.deepEqual(findings(DEF("public.f", "p_limit integer") + "revoke all on function public.f(integer, text) from public, anon;"),
    [["f(integer)", "no revoke from public and anon"]]);
  assert.deepEqual(findings(DEF("public.f", "p_limit integer, p_source text") + "revoke all on function public.f(integer, text) from public, anon;"), []);
  assert.equal(argTypes("p_now timestamptz, p_ok bool, p_n int4, p_s varchar(40)"), "timestamp with time zone,boolean,integer,character varying");
});

test("bypass 4: a quoted name, with spaces, is the same function only when spelled the same", () => {
  assert.deepEqual(definersIn(DEF('public."f g"', "")).map((d) => d.key), ["f g()"]);
  assert.deepEqual(findings(DEF('public."f g"', "") + 'revoke all on function public."f g"() from public, anon;'), []);
  assert.deepEqual(findings(DEF('public."f g"', "") + "revoke all on function public.f() from public, anon;"), [["f g()", "no revoke from public and anon"]], "f is not \"f g\"");
  assert.deepEqual(findings(DEF('"Mixed"', "") + "revoke all on function mixed() from public, anon;"), [["Mixed()", "no revoke from public and anon"]],
    "a quoted name keeps its case");
});

test("bypass 5: dynamic SQL that creates a function is refused unless the file says it was reviewed", () => {
  const dyn = "do $$ declare n text := 'leaky'; begin\n" +
    "  execute 'create function public.' || n || '() returns int language sql security definer as ''select 1''';\nend $$;\n";
  assert.deepEqual(findings(dyn), [["(dynamic)", "dynamic SQL creates or alters a function"]]);
  assert.deepEqual(findings("-- definer-scan: dynamic function DDL reviewed (it builds no definer function)\n" + dyn), []);
  assert.ok(REVIEWED_MARKER.test("-- definer-scan: dynamic function DDL reviewed"));
  assert.deepEqual(findings("do $$ begin execute format('revoke all on function %s from public, anon', 'public.f()'); end $$;"), [],
    "a dynamic revoke is not function DDL");
});

test("a new migration file with a definer function and only 'revoke ... from public' fails the scan of a directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "definer-scan-"));
  fs.writeFileSync(path.join(dir, "20991231000000_new.sql"), DEF("public.leaky", "p text") + "revoke all on function public.leaky(text) from public;\n");
  assert.deepEqual(scan(dir).map((x) => [x.file, x.key, x.has]), [["20991231000000_new.sql", "leaky(text)", ["public"]]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("comments and strings are not statements: a definer or a revoke inside one does not count", () => {
  assert.deepEqual(findings("/* create function f() returns int language sql security definer as $$ select 1 $$; */"), [], "a definer in a block comment");
  assert.deepEqual(findings(DEF() + "/* revoke all on function public.f(uuid) from public, anon; */"), [["f(uuid)", "no revoke from public and anon"]], "a revoke in a block comment");
  assert.deepEqual(findings(DEF() + "select 'revoke all on function public.f(uuid) from public, anon;';"), [["f(uuid)", "no revoke from public and anon"]], "a revoke in a string");
  assert.deepEqual(findings("create function public.f(p uuid) returns void language plpgsql security definer set search_path = public as $$ begin\n" +
    "  revoke all on function public.f(uuid) from public, anon;\nend $$;"), [["f(uuid)", "no revoke from public and anon"]], "a revoke inside a function body never runs at apply time");
});

test("a quoted \"anon\" is anon; GRANTED BY and WITH GRANT OPTION are read past", () => {
  assert.deepEqual(findings(DEF() + 'revoke all on function public.f(uuid) from "public", "anon";'), [], "quoted role names");
  assert.deepEqual(findings(DEF() + "revoke all on function public.f(uuid) from public, anon granted by postgres;"), [], "GRANTED BY after the roles");
  assert.deepEqual(findings(DEF() + "revoke all on function public.f(uuid) from public, anon;\ngrant execute on function public.f(uuid) to anon granted by postgres;"),
    [["f(uuid)", "granted back to public or anon after the revoke"]]);
  assert.deepEqual(findings(DEF() + 'revoke all on function public.f(uuid) from public, anon;\ngrant execute on function public.f(uuid) to "anon" with grant option;'),
    [["f(uuid)", "granted back to public or anon after the revoke"]]);
  assert.deepEqual(findings(DEF() + 'revoke all on function public.f(uuid) from public, "Anon";'), [["f(uuid)", "no revoke from public and anon"]], "a quoted \"Anon\" is another role");
});

test("CREATE PROCEDURE ... SECURITY DEFINER is held to the same rule", () => {
  const proc = "create or replace procedure public.p(n integer) language plpgsql security definer set search_path = public as $$ begin end $$;\n";
  assert.deepEqual(findings(proc), [["p(integer)", "no revoke from public and anon"]]);
  assert.deepEqual(findings(proc + "revoke all on procedure public.p(integer) from public, anon;"), []);
  assert.deepEqual(findings("create procedure public.q() language sql as $$ select 1 $$;\nalter procedure public.q() security definer;"), [["q()", "no revoke from public and anon"]]);
});

test("a schema-wide grant of functions to anon or PUBLIC is refused", () => {
  assert.deepEqual(findings("grant execute on all functions in schema public to anon;").map((f) => f[0]), ["(schema-wide grant)"]);
  assert.deepEqual(findings("grant all on all routines in schema public to public;").map((f) => f[0]), ["(schema-wide grant)"]);
  assert.deepEqual(findings("alter default privileges in schema public grant execute on functions to anon;").map((f) => f[0]), ["(schema-wide grant)"]);
  assert.deepEqual(findings("grant execute on all functions in schema public to service_role;"), [], "to the service role: fine");
  assert.deepEqual(findings("revoke execute on all functions in schema public from anon;"), [], "taking it away: fine");
});

test("block comments: /* */ hides a definer, a revoke, a grant-back and a marker; nested ones too", () => {
  assert.deepEqual(findings(DEF() + "/* revoke all on function public.f(uuid) from public, anon; */"), [["f(uuid)", "no revoke from public and anon"]]);
  assert.deepEqual(findings(DEF() + "revoke all on function public.f(uuid) from public, anon;\n/* grant execute on function public.f(uuid) to anon; */"), [],
    "a grant in a comment never runs");
  assert.deepEqual(findings(DEF() + "/* outer /* inner */ revoke all on function public.f(uuid) from public, anon; */"), [["f(uuid)", "no revoke from public and anon"]],
    "nested: the revoke is still inside the outer comment");
  assert.deepEqual(findings("/* a */ create function f() returns int language sql security definer as $$ select 1 $$; /* b */"), [["f()", "no revoke from public and anon"]],
    "a definer between two comments is read");
  assert.equal(hasReviewedMarker("/* -- definer-scan: dynamic function DDL reviewed */ select 1"), true, "a marker in a comment counts");
});

test("strings: a revoke, a marker or a comment opener inside a string or a dollar-quoted body is text", () => {
  assert.deepEqual(findings(DEF() + "do $x$ begin revoke all on function public.f(uuid) from public, anon; end $x$;"), [["f(uuid)", "no revoke from public and anon"]],
    "a revoke in a dollar-quoted DO block");
  assert.deepEqual(findings(DEF() + "select $q$revoke all on function public.f(uuid) from public, anon;$q$;"), [["f(uuid)", "no revoke from public and anon"]], "tagged dollar quote");
  assert.deepEqual(findings(DEF() + "select 'it''s --' ; revoke all on function public.f(uuid) from public, anon;"), [],
    "a -- inside a string does not comment out the real revoke after it");
  assert.deepEqual(findings(DEF() + "select '/*'; select 1;\nrevoke all on function public.f(uuid) from public, anon;\nselect '*/';"), [],
    "a /* inside a string does not start a comment that swallows the revoke");
  assert.deepEqual(findings(DEF() + "select E'a\\'b'; revoke all on function public.f(uuid) from public, anon;"), [], "E'' strings take backslash escapes");
  assert.deepEqual(findings(DEF('public."f--g"', "") + 'revoke all on function public."f--g"() from public, anon;'), [], "-- inside a quoted name is part of the name");
  assert.deepEqual(findings("select '-- definer-scan: dynamic function DDL reviewed'; do $$ begin execute 'create function public.z() returns int language sql security definer as ''select 1'''; end $$;"),
    [["(dynamic)", "dynamic SQL creates or alters a function"]], "a marker inside a string is not a review");
  assert.equal(stripLiterals("select 'a -- b', $t$ c /* d $t$, \"e--f\" -- g\n h"), "select '', $t$$t$, \"e--f\"  \n h");
});

test("a SECURITY DEFINER function made inside a DO block, with no EXECUTE anywhere, is read and needs its revoke", () => {
  const inDo = "do $$ begin\n  create or replace function public.d(p text) returns text language sql security definer set search_path = public as $f$ select p $f$;\nend $$;\n";
  assert.doesNotMatch(inDo, /\bexecute\b/i);
  assert.deepEqual(findings(inDo), [["d(text)", "no revoke from public and anon"]]);
  assert.deepEqual(findings(inDo + "revoke all on function public.d(text) from public, anon;"), [], "a file-level revoke covers it");
  assert.deepEqual(findings("do $$ begin\n  create function public.d(p text) returns text language sql security definer as $f$ select p $f$;\n" +
    "  revoke all on function public.d(text) from public, anon;\nend $$;"), [["d(text)", "no revoke from public and anon"]], "a revoke inside the block does not count");
  assert.deepEqual(findings("do language plpgsql $b$ begin alter function public.g(text) security definer; end $b$;"), [["g(text)", "no revoke from public and anon"]],
    "DO LANGUAGE ... and ALTER ... SECURITY DEFINER inside it");
  assert.deepEqual(findings("do $$ begin if to_regprocedure('public.a(uuid)') is not null then alter function public.a(uuid) rename to a_base; end if; end $$;"), [],
    "a rename inside a DO block (as three migrations do) is not a definer");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "definer-do-"));
  fs.writeFileSync(path.join(dir, "20991231000000_do.sql"), inDo);
  assert.deepEqual(definerKeys(dir), [["20991231000000_do.sql", "public", "d", "text"]], "tests/db/run.sh's definer-keys list has it, so the suite must build it");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("function DDL inside a function body or a string is refused without an EXECUTE in the file", () => {
  const body = "create function public.maker() returns void language plpgsql set search_path = public as $m$ begin\n" +
    "  create function public.made() returns int language sql security definer as $i$ select 1 $i$;\nend $m$;\n";
  assert.doesNotMatch(body, /\bexecute\b/i);
  assert.deepEqual(findings(body), [["(dynamic)", "dynamic SQL creates or alters a function"]], "static DDL in a body runs when the function is called");
  assert.deepEqual(findings("select 'create function public.x() returns int language sql security definer as $$ select 1 $$';"),
    [["(dynamic)", "dynamic SQL creates or alters a function"]], "in a string");
  assert.deepEqual(findings("-- definer-scan: dynamic function DDL reviewed (maker builds made; checked)\n" + body), [], "the reviewed marker");
});
