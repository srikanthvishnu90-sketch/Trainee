// Regressions for the file page sign-in round 4 fixes (scenarios-file-signin-r4-battery.ts found each one):
//   1. the per-account cap told numbers apart: with four forwarded links of one account, the fourth answered "Too many wrong
//      codes" for the account's number and "That code didn't work" for any other (handler.ts phone_verify, store.ts accountTries);
//   2. an erase ("forget everything") left the file page's sessions live, pending sign-ins finishable and typed numbers stored
//      (20261105150000_trainee_file_erase_r4.sql; the Postgres half is flow-scenarios-file-signin-r4.test.ts);
//   3. the /file proxy read every logo as text and served it as text/html (api/file.js): every logo was mangled;
//   4. a logo was cacheable for a day after sign-out, and a refused logo answer had none of the page's security headers.
import assertNode from "node:assert/strict";
import { handleFile, type FileDeps } from "../../supabase/functions/trainee-file/handler.ts";
import { mintFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { ACCOUNT_MAX_TRIES, MAX_CODE_TRIES, type PhoneAuth } from "../../supabase/functions/_shared/file_session.ts";
import { supabaseSessionStore } from "../../supabase/functions/trainee-file/store.ts";
import { jobViewOf, refOf } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { memSessions, sessionFor } from "./file-session-fakes.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const ROOT = new URL("../../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, ROOT));
const SECRET = ["file", "link", "r4-regress", "0123456789", "abcdef"].join("-");
const HOST = "https://trainee.example";
const U = "aaaaaaaa-1111-4111-8111-000000000401", V = "aaaaaaaa-1111-4111-8111-000000000402";
const PHONE = { [U]: "+15125557421", [V]: "+14695558263" } as Record<string, string>;
const T = Date.parse("2026-11-05T16:00:00Z");
const env = { get: (k: string) => ({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: `${HOST}/file` } as Record<string, string>)[k] };

// The attacker's script on one account: N forwarded links, the same number typed on each, `tries` wrong codes per link.
async function attack(account: string, typed: string, links: number, tries: number): Promise<string[]> {
  const m = memSessions();
  const phone: PhoneAuth = { async ready() { return true; }, async accountPhone(u) { return PHONE[u] ?? null; }, async send() { return { ok: true }; }, async check() { return null; } };
  const d = { store: {} as never, cards: {} as never, tap: {} as never, now: () => T, env, sessions: m.store, phone } as unknown as FileDeps;
  const out: string[] = [];
  for (let i = 0; i < links; i++) {
    const link = (await mintFileToken({ secret: SECRET, userId: account, list: "0123456789", now: T, kind: "l" }))!;
    const cookie = (await handleFile(new Request(`${HOST}/file?t=${encodeURIComponent(link)}`), d)).headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const post = async (f: Record<string, string>) => { const x = await handleFile(new Request(`${HOST}/file`, { method: "POST", headers: { cookie, origin: HOST, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(f).toString() }), d); return `${x.status} ${await x.text()}`; };
    await post({ action: "phone_start", phone: typed });
    for (let k = 0; k < tries; k++) out.push(await post({ action: "phone_verify", code: String(111111 + 7 * (i * 10 + k)) }));
  }
  return out;
}

Deno.test("file sign-in r4: with four forwarded links, the answers are the same whether the typed number is the account's or not", async () => {
  ok(4 * MAX_CODE_TRIES > ACCOUNT_MAX_TRIES, "four links hold more tries than the account's cap");
  const own = await attack(U, PHONE[U], 4, MAX_CODE_TRIES), other = await attack(V, "+14155550123", 4, MAX_CODE_TRIES);
  eq(own.length, other.length);
  for (let i = 0; i < own.length; i++) eq(own[i], other[i], `answer ${i}`);
  // and the cap still holds: after the account's 15 tries, every further answer is the lock
  eq(own.slice(ACCOUNT_MAX_TRIES).every((x) => x.startsWith("429 ")), true);
  eq(own.slice(0, ACCOUNT_MAX_TRIES).every((x) => x.startsWith("401 ")), true);
});

Deno.test("file sign-in r4: the deployed session store counts the account's tries over every sign-in in the hour (the database's window)", async () => {
  const calls: string[] = [];
  // a PostgREST stand-in that records the query and answers rows (no network)
  const rows: Record<string, unknown[]> = { me: [{ user_id: U, created_at: "2026-11-05T16:00:00.000Z" }], all: [{ tries: 5 }, { tries: 4 }, { tries: 2 }] };
  const q = (which: "me" | "all") => {
    const b: Record<string, unknown> = {};
    for (const f of ["select", "eq", "gt", "lt", "is", "limit", "order"]) b[f] = (...a: unknown[]) => { calls.push(`${which}.${f}(${a.map(String).join(",")})`); return b; };
    b.maybeSingle = async () => ({ data: rows.me[0], error: null });
    b.then = (res: (v: unknown) => unknown) => res({ data: rows.all, error: null });
    return b;
  };
  let n = 0;
  const admin = { from: (t: string) => { calls.push(`from(${t})`); return q(n++ === 0 ? "me" : "all"); } };
  const s = supabaseSessionStore(admin);
  eq(await s.accountTries!("00000000000004a1"), 11);
  ok(calls.includes("all.gt(created_at,2026-11-05T15:00:00.000Z)") && calls.includes("all.lt(created_at,2026-11-05T17:00:00.000Z)"), calls.join(" "));
  ok(calls.includes(`all.eq(user_id,${U})`) && !calls.some((c) => c.startsWith("all.eq(matched")), "every sign-in of the account, whatever number it holds");
});

Deno.test("file sign-in r4: the erase migration is wired everywhere a migration must be, with its rollback and its test", () => {
  const f = "20261105150000_trainee_file_erase_r4.sql", sql = read(`supabase/migrations/${f}`);
  ok(/create trigger trainee_file_erase_on_epoch after insert or update on public\.career_watch_kv/.test(sql));
  ok(/delete from public\.trainee_file_sessions where user_id = new\.user_id/.test(sql) && /set phone = null, done_at = coalesce\(done_at, now\(\)\)/.test(sql));
  ok(/revoke all on function public\.trainee_file_erase_on_epoch\(\) from public, anon, authenticated/.test(sql), "definer revoked in the same file");
  ok(/security definer set search_path = public, pg_temp/.test(sql));
  ok(read(`supabase/rollbacks/20261105150000_trainee_file_erase_r4.down.sql`).includes("drop function if exists public.trainee_file_erase_on_epoch()"));
  const golive = read("scripts/launch/trainee-go-live.sh");
  const migs = golive.slice(golive.indexOf("MIGRATIONS=("), golive.indexOf("MIGRATION_MARK=(")).match(/^\s+(\d{14}_[a-z0-9_]+\.sql)$/gm)!.map((x) => x.trim());
  eq(migs.at(-1), f, "the last migration go-live applies");
  ok(golive.includes("tgname = 'trainee_file_erase_on_epoch'"), "its live mark");
  const run = read("tests/db/run.sh");
  eq((run.match(/20261105150000_trainee_file_erase_r4\.sql"/g) ?? []).length, 3, "applied twice, then again after its rollback");
  ok(run.includes(`"$t" == "$HERE/trainee_file_erase_r4.test.sql"`) && run.includes(`-f "$HERE/trainee_file_erase_r4.test.sql"`));
  ok(/LIVE_MISSING_DEFAULT="[^"]*20261105150000_trainee_file_erase_r4\.sql"/.test(read("tests/db/rehearse_live_migrations.sh")));
});

Deno.test("file sign-in r4: the memory twin's erase does what the migration does (sessions gone, sign-ins used up, numbers cleared, counts kept)", async () => {
  const m = memSessions();
  await sessionFor(m.store, { userId: U, list: "0123456789", now: T });
  await sessionFor(m.store, { userId: V, list: "9876543210", now: T });
  await m.store.beginLogin({ jti: "00000000000004b1", userId: U, list: "0123456789", at: T, expiresAt: T + 900_000 });
  await m.store.setPhone("00000000000004b1", PHONE[U], true);
  await m.store.countTry("00000000000004b1", MAX_CODE_TRIES);
  m.store.eraseAccount(U, T);
  eq([...m.sessions.values()].map((x) => x.user_id), [V]);
  const l = m.logins.get("00000000000004b1")!;
  eq([l.phone, !!l.done_at, l.tries, l.matched], [null, true, 1, true]);
  eq(await m.store.finishLogin("00000000000004b1", T), false);
});

Deno.test("file sign-in r4: a logo is no-store, sandboxed and same-origin only; a refused logo carries the page's headers", async () => {
  const m = memSessions();
  const list = "0123456789";
  const job = jobViewOf({ job_id: "greenhouse:brindlequay:1", company: "Brindlequay", title: "Tariff Cartographer", url: "https://boards.greenhouse.io/brindlequay/jobs/1" }, { company_domain: "brindlequay.com" } as never);
  const ref = await refOf(U, job.job_id);
  const store = { async recall() { return { job, shownAs: "text" }; }, async recallList() { return [ref]; }, async postings() { return [{ job_id: job.job_id, company_domain: "brindlequay.com" }]; } } as never;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const phone: PhoneAuth = { async accountPhone(u) { return PHONE[u] ?? null; }, async send() { return { ok: true }; }, async check() { return null; } };
  const d = { store, cards: {} as never, tap: {} as never, now: () => T, env, sessions: m.store, phone, logoFetch: (async () => new Response(png, { headers: { "content-type": "image/png" } })) as typeof fetch,
    logoCache: (() => { const c = new Map(); return { get: (k: string) => c.get(k), set: (k: string, v: unknown) => c.set(k, v) }; })() } as unknown as FileDeps;
  const id = await sessionFor(m.store, { userId: U, list, now: T, phone: PHONE[U] });
  const get = (q: string) => handleFile(new Request(`${HOST}/file${q}`, { headers: { cookie: `tf_s=${id}` } }), d);
  const a = await get("?logo=brindlequay.com");
  eq([a.status, a.headers.get("content-type"), a.headers.get("cache-control")], [200, "image/png", "no-store"]);
  ok(/sandbox/.test(a.headers.get("content-security-policy") ?? "") && a.headers.get("cross-origin-resource-policy") === "same-origin");
  eq(new Uint8Array(await a.arrayBuffer()), png);
  for (const q of ["?logo=elsewhere.com", `?logo=${"a".repeat(300)}.com`]) {
    const b = await get(q);
    eq(b.status, 404);
    eq([b.headers.get("cache-control"), b.headers.get("referrer-policy"), b.headers.get("x-content-type-options")], ["no-store", "same-origin", "nosniff"]);
    ok(/default-src 'none'/.test(b.headers.get("content-security-policy") ?? "") && /frame-ancestors https:\/\/web\.telegram\.org/.test(b.headers.get("content-security-policy") ?? ""));
  }
});

Deno.test("file sign-in r4: the /file proxy passes a logo through as the same bytes with its image type; pages stay HTML", async () => {
  // deno-lint-ignore no-explicit-any
  const proc = (globalThis as any).process;
  const before = proc.env.TRAINEE_FILE_UPSTREAM;
  proc.env.TRAINEE_FILE_UPSTREAM = "https://upstream.test/functions/v1/trainee-file";
  const real = globalThis.fetch;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80, 0xc3]);
  try {
    const mod = await import(`../../api/file.js?r4=${Date.now()}`);
    let answer: () => Response = () => new Response("");
    globalThis.fetch = (async () => answer()) as typeof fetch;
    const SEC = { "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin" };
    answer = () => new Response(png, { status: 200, headers: { "content-type": "image/png", ...SEC } });
    const a = await mod.GET(new Request("https://trainee.example/file?logo=brindlequay.com", { headers: { cookie: "tf_s=x" } }));
    eq([a.status, a.headers.get("content-type"), a.headers.get("cache-control"), a.headers.get("cross-origin-resource-policy")], [200, "image/png", "no-store", "same-origin"]);
    ok(/sandbox/.test(a.headers.get("content-security-policy") ?? ""));
    eq(new Uint8Array(await a.arrayBuffer()), png, "the same bytes");
    // an answer that claims another type (or a page) under ?logo= is never passed on as that type
    answer = () => new Response("<script>alert(1)</script>", { status: 200, headers: { "content-type": "image/svg+xml", ...SEC } });
    eq((await mod.GET(new Request("https://trainee.example/file?logo=x.com"))).headers.get("content-type"), "text/html; charset=utf-8");
    // the page itself: HTML, as before
    answer = () => new Response("<p>x</p>", { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...SEC } });
    const p = await mod.GET(new Request("https://trainee.example/file"));
    eq([p.headers.get("content-type"), await p.text()], ["text/html; charset=utf-8", "<p>x</p>"]);
  } finally {
    globalThis.fetch = real;
    if (before === undefined) delete proc.env.TRAINEE_FILE_UPSTREAM; else proc.env.TRAINEE_FILE_UPSTREAM = before;
  }
});
