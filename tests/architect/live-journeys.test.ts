// R3 of the test ladder (docs/architect/TEST-STRATEGY-2026-11-01.md): scripts/launch/live-journeys.ts, the LIVE synthetic journeys
// the production deploy runs as S6 after go-live. Here, at $0 and with no network:
//   - its dry mode: every journey over real HTTP (the real secret header) to the real trainee-telegram handler on a throwaway
//     Postgres with every migration, the real agent-chat, a fake Bot API, the scripted model; every step passes or is a
//     KNOWN_GAP, every reply is delivered, nothing leaves the machine, and the clean-up leaves no row of the synthetic account;
//   - its guards, each shown to bite: an unscoped query and a write disguised as a read are refused; a sandbox employer on a
//     real ATS host is refused; a chat whose account lacks the synthetic marker is refused and never erased; missing live
//     inputs are NOT RUN (exit 2), never a pass;
//   - its KNOWN_GAP list stays inside the Telegram acceptance suite's (S4), so it can only shrink with it.
// Run: deno test -A --no-check [--import-map=tests/flow/supabase-npm.json] tests/architect/live-journeys.test.ts (unprivileged user).
import assertNode from "node:assert/strict";
import { pgBinDir } from "../flow/pg.ts";
import { type Db, KNOWN_GAP, liveInputs, MARKER_KEY, privateTokens, runJourneys, sandboxUrl, SANDBOX_HOST, scopedDb, STEPS, SYNTHETIC_CHAT, webhookPoster } from "../../scripts/launch/live-journeys.ts";
import { BYSTANDER_SEARCHES, runDry } from "../../scripts/launch/live-journeys-dry.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url);

Deno.test("live journeys: a query that names neither the synthetic account nor the run's posting is refused, and a read cannot write", async () => {
  const sent: string[] = [];
  const raw: Db = { sql: async (t) => { sent.push(t); return "1"; } };
  const uid = "00000000-0000-4000-8000-000000000001";
  const db = scopedDb(raw, { contact: "tg:42", email: "tg-42@users.trainee.invalid", postingKey: "trainee-sandbox-run1", userId: () => uid });
  await assertNode.rejects(db.read("select count(*) from public.career_apply_jobs"), /UNSCOPED/);
  await assertNode.rejects(db.write("delete from public.career_apply_jobs where state = 'queued'"), /UNSCOPED/);
  await assertNode.rejects(db.read(`delete from public.career_apply_jobs where user_id = '${uid}'`), /may not write/);
  await assertNode.rejects(db.read(`select 1; update public.profiles set id = id where id = '${uid}'`), /may not write/);
  eq(sent, [], "nothing refused reached the database");
  eq(await db.read(`select count(*) from public.career_apply_jobs where user_id = '${uid}'`), "1");
  eq(await db.read(`select 'delete' as word from public.channel_contacts where contact = 'tg:42'`), "1", "a quoted word is not a write");
});

Deno.test("live journeys: the sandbox employer is a reserved .invalid host, never a real ATS", () => {
  const u = new URL(sandboxUrl("run1"));
  eq(u.hostname, SANDBOX_HOST);
  ok(u.hostname.endsWith(".invalid"));
  const src = Deno.readTextFileSync(new URL("scripts/launch/live-journeys.ts", ROOT));
  ok(!/boards\.greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com/.test(src.replace(/EMPLOYER_HOSTS = .*$/m, "")), "no real ATS URL in the journeys");
});

Deno.test("live journeys: the sandbox posting's searchable words are private nonsense tokens, one pair per run", () => {
  const a = privateTokens("gh123"), b = privateTokens("gh124");
  for (const t of [a.company, a.title, a.place]) ok(/^Zq[a-z]{8}$/.test(t), t);
  eq(privateTokens("gh123"), a, "deterministic");
  ok(a.company !== a.title && a.company !== b.company && a.title !== b.title, "distinct per word and per run");
  // What is actually stored (and so searched) is asserted on the row itself, in the dry run below.
});

Deno.test("live journeys: missing live inputs are NOT RUN; the owner's chat makes delivery VERIFIED, none makes it UNVERIFIED on SYNTHETIC_CHAT", () => {
  const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
  eq(liveInputs(env({})).missing, ["LIVE_JOURNEY_ENABLED=true", "SUPABASE_PROJECT_REF", "TELEGRAM_WEBHOOK_SECRET", "SUPABASE_DB_URL"]);
  const base = { LIVE_JOURNEY_ENABLED: "true", SUPABASE_PROJECT_REF: "abcd", TELEGRAM_WEBHOOK_SECRET: "s", SUPABASE_DB_URL: "postgres://x" };
  eq(liveInputs(env({ ...base, LIVE_JOURNEY_ENABLED: "yes" })).missing, ["LIVE_JOURNEY_ENABLED=true"], "the owner's switch is exactly true: off by default, so no deploy rolls back before the chat may sign up");
  const none = liveInputs(env(base));
  eq([none.missing, none.chat, none.delivery, none.webhook], [[], SYNTHETIC_CHAT, "unverified", "https://abcd.supabase.co/functions/v1/trainee-telegram"]);
  const mine = liveInputs(env({ ...base, LIVE_JOURNEY_TELEGRAM_CHAT_ID: "123456789" }));
  eq([mine.chat, mine.delivery], [123456789, "verified"]);
  ok(liveInputs(env({ ...base, LIVE_JOURNEY_TELEGRAM_CHAT_ID: "-100123" })).missing.length === 1, "a group or channel id is refused");
  ok(SYNTHETIC_CHAT > 2 ** 51 && Number.isSafeInteger(SYNTHETIC_CHAT), "the synthetic chat is far above any assigned Telegram id");
});

Deno.test("live journeys: a chat whose account lacks the synthetic marker is refused, posts nothing and erases nothing", async () => {
  const sent: string[] = [];
  const someone = "00000000-0000-4000-8000-0000000000aa";
  const raw: Db = {
    sql: async (t) => {
      sent.push(t);
      if (/select coalesce\(\(select user_id::text from public\.channel_contacts where contact/.test(t)) return someone; // the chat has an account
      if (/join auth\.users/.test(t)) return ""; // without the marker
      return "0";
    },
  };
  const posts: unknown[] = [];
  const logs: string[] = [];
  const r = await runJourneys({ post: async (u) => { posts.push(u); return { status: 200, body: "" }; }, db: raw, chat: 42, delivery: "unverified", runId: "guard1", resume: "x", log: (l) => logs.push(l) });
  ok(!r.pass);
  eq(r.results.find((x) => x.id === "preflight-synthetic-only")?.outcome, "FAIL");
  ok(/without the synthetic marker/.test(r.results[0].why ?? ""), r.results[0].why);
  eq(posts, [], "no update was posted");
  ok(!sent.some((t) => /delete from auth\.users|do \$erase\$|insert into/i.test(t)), `nothing written or erased: ${sent.filter((t) => /delete|insert/i.test(t)).join(" || ").slice(0, 300)}`);
  ok(sent.every((t) => t.includes("tg:42") || t.includes("tg-42@") || t.includes("trainee-sandbox-guard1")), "every statement was scoped");
});

Deno.test("live journeys: KNOWN_GAP names real steps and stays inside the Telegram acceptance suite's (S4)", () => {
  for (const g of KNOWN_GAP) ok((STEPS as readonly string[]).includes(g), g);
  const acc = Deno.readTextFileSync(new URL("tests/architect/telegram-acceptance.test.ts", ROOT));
  const block = /export const KNOWN_GAP: readonly string\[\] = \[([\s\S]*?)\] as const;/.exec(acc)?.[1] ?? "";
  const theirs = [...block.replace(/\/\/.*$/gm, "").matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
  for (const g of KNOWN_GAP) ok(theirs.includes(g), `${g} is a KNOWN_GAP here but not in the acceptance suite (the lists only shrink together)`);
});

Deno.test("live journeys: deploy-production runs them inside S6 (the smoke step) after the smoke, so their FAIL rolls back; NOT RUN only warns", () => {
  const wf = Deno.readTextFileSync(new URL(".github/workflows/deploy-production.yml", ROOT));
  const smoke = /- name: S6 live smoke after deploy\n\s+id: smoke\n([\s\S]*?)\n\s+# Rollback:/.exec(wf)?.[1] ?? "";
  ok(smoke, "the S6 step");
  const run = smoke.slice(smoke.indexOf("run: |"));
  ok(run.indexOf("--only-smoke") >= 0 && run.indexOf("--only-smoke") < run.indexOf("scripts/launch/live-journeys.ts --live"), "the journeys run after the smoke, in the same step");
  ok(/code=\$\{PIPESTATUS\[0\]\}/.test(run) && /if \[ "\$code" = 2 \]; then echo "::warning[^\n]*exit 0; fi\n[\s\S]*\n\s+exit "\$code"\s*$/.test(run) && !/"\$code" = 1/.test(run), "NOT RUN (2) and clean-up-only (3) warn; FAIL (1) is the step's own exit, so it rolls back");
  ok(/LIVE_JOURNEY_TELEGRAM_CHAT_ID: \$\{\{ secrets\.LIVE_JOURNEY_TELEGRAM_CHAT_ID \}\}/.test(smoke), "the owner's chat id from its secret");
  for (const v of ["LIVE_JOURNEY_ENABLED", "SUPABASE_PROJECT_REF", "TELEGRAM_WEBHOOK_SECRET", "SUPABASE_DB_URL"]) ok(new RegExp(`${v}: \\$\\{\\{ secrets\\.${v} \\}\\}`).test(smoke), v);
  ok(/MASK_\d+: \$\{\{ secrets\.LIVE_JOURNEY_TELEGRAM_CHAT_ID \}\}/.test(wf), "masked in the artifacts");
});

Deno.test({
  name: "live journeys (dry): every journey over HTTP to the real webhook on Postgres passes, every reply is delivered, nothing leaves, nothing is left",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw new Error("the live journeys' dry mode needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const resume = await Deno.readTextFile(new URL("packages/career-data/fixtures/test-resume.txt", ROOT));
    const lines: string[] = [];
    const r = await runDry({ resume, runId: "drytest1", crashedRunFirst: true, log: (l) => { lines.push(l); console.log(l); } }, { runJourneys, webhookPoster, SYNTHETIC_CHAT });
    // A killed earlier run left its account and its sandbox posting; this run's preflight erased both, and nothing anywhere
    // still points at that posting.
    ok(r.crash, "the killed run ran");
    eq([r.crash!.leftPosting, r.crash!.leftAccount], [1, true], "the killed run left its posting and its account behind");
    eq([r.crash!.postingAfter, r.crash!.accountRowsAfter, r.crash!.pointingAfter], [0, "", ""], "the next run swept them, and everything that pointed at the posting");
    eq(r.results.find((x) => x.id === "preflight-stale-postings-swept")?.outcome, "PASS");
    // The posting as stored while it was live: every searchable field and every lexeme of its search vector is a token.
    ok(r.postingRow, "the posting was read while live");
    for (const f of ["title", "company", "location", "description"] as const) ok(/^Zq[a-z]{8}$/.test(r.postingRow![f]), `${f} is a private token: ${JSON.stringify(r.postingRow![f])}`);
    ok(r.postingRow!.lexemes.length >= 1 && r.postingRow!.lexemes.every((l) => /^zq[a-z]{8}$/.test(l)), `only private tokens are searchable: ${r.postingRow!.lexemes.join(" ")}`);
    for (const s of STEPS) ok(r.results.some((x) => x.id === s), `step ${s} ran`);
    const bad = r.results.filter((x) => !(x.outcome === "PASS" || x.outcome === "KNOWN_GAP still fails"));
    eq(bad, [], "every step passes (a KNOWN_GAP that now passes must be removed)");
    eq(r.delivery, "verified");
    eq(r.outbound, [], "nothing left the machine");
    eq(r.botViolations, [], "every message valid for Telegram");
    ok(r.botMessages >= 10, `Telegram got the replies: ${r.botMessages}`);
    eq(r.badSecretStatus, 403, "a wrong secret header is refused");
    ok(r.webhookRequests >= 15, `the journeys went over HTTP: ${r.webhookRequests}`);
    // Two real-looking people in the same database: the Telegram one searched while the sandbox posting was live and never
    // saw it; neither had a single row, contact or chat message changed by the run or its clean-up.
    eq(r.bystander.searched, BYSTANDER_SEARCHES.length, "the bystander searched");
    ok(r.bystander.sawDecoy >= 2, `the bystander's searches do list postings (the decoy): ${r.bystander.sawDecoy}`);
    eq(r.bystander.sawSandbox, [], "no other person's search lists the sandbox posting");
    eq(r.bystander.rowsChanged, [], "no row of another person changed");
    eq(r.bystander.messagesAfterSearch, 0, "no message reached another person's chat");
    ok(r.bystander.contactsIntact, "the other people's contacts are theirs");
    eq(r.results.find((x) => x.id === "sandbox-posting-private")?.outcome, "PASS", "no other account points at the sandbox posting");
    ok(r.pass && r.cleanedUp);
    ok(lines.some((l) => /^LIVE_JOURNEY PASS delivery=VERIFIED/.test(l)), "the summary line");
    ok(!lines.join("\n").includes(MARKER_KEY + "\"") , "no raw marker JSON in the log");
  },
});

Deno.test({
  name: "live journeys (dry): when another account holds a row pointing at the sandbox posting, sandbox-posting-private FAILS the run",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw new Error("the live journeys' dry mode needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const resume = await Deno.readTextFile(new URL("packages/career-data/fixtures/test-resume.txt", ROOT));
    const r = await runDry({ resume, runId: "drytest2", leakToBystander: true, log: () => {} }, { runJourneys, webhookPoster, SYNTHETIC_CHAT });
    const priv = r.results.find((x) => x.id === "sandbox-posting-private");
    eq(priv?.outcome, "FAIL", `the leak is caught: ${JSON.stringify(priv)}`);
    ok(/career_watch_kv:1/.test(priv?.why ?? ""), `it names where: ${priv?.why}`);
    eq(r.pass, false, "and the run fails (so the deploy would roll back)");
    eq(r.results.filter((x) => x.outcome === "FAIL").map((x) => x.id), ["sandbox-posting-private"], "nothing else failed");
    ok(r.cleanedUp, "the clean-up still ran");
  },
});
