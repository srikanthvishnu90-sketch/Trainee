// Direct regressions of the file page web-security round (scenarios-file-websec-battery.ts), registered by
// scenarios-file-websec.test.ts: the pieces the battery cannot see through the handler alone — the /file proxy that passes the
// browser's origin headers through, the deployed dependencies that pace the phone steps and keep the text alive, real time on
// the phone steps, the cross-site rule itself, the link's span, and the per-account caps agreeing across the code, the
// memory twin and the migration.
import assertNode from "node:assert/strict";
import { crossSite, handleFile, MAX_BODY_BYTES, type FileDeps } from "../../supabase/functions/trainee-file/handler.ts";
import { buildFileDeps, edgeBackground } from "../../supabase/functions/trainee-file/deps.ts";
import { ACCOUNT_MAX_SENDS, ACCOUNT_MAX_TRIES, ACCOUNT_WINDOW_MS, MAX_CODE_SENDS, MAX_CODE_TRIES, phonePace, PHONE_STEP_FLOOR_MS } from "../../supabase/functions/_shared/file_session.ts";
import { MAX_LINK_SPAN_MS, mintFileToken, verifyFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { fakePhone, memSessions } from "./file-session-fakes.ts";
import { ANSWER_DEADLINE_MS, answeredWhileHeld, generate, memEnv, newReport, POLICY, printReport, runScenario, SECRET } from "./scenarios-file-websec-battery.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const ROOT = new URL("../../", import.meta.url);
const env = (o: Record<string, string> = {}) => ({ get: (k: string) => ({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: "https://trainee.example/file", ...o } as Record<string, string>)[k] });

Deno.test("file websec: the per-account caps are the same numbers in the code, the memory twin, the migration and the battery's oracle", async () => {
  eq([ACCOUNT_MAX_SENDS, ACCOUNT_MAX_TRIES, ACCOUNT_WINDOW_MS], [POLICY.accountSendsPerHour, POLICY.accountTriesPerHour, 3600_000]);
  ok(ACCOUNT_MAX_SENDS > MAX_CODE_SENDS && ACCOUNT_MAX_TRIES > MAX_CODE_TRIES, "one link alone never hits the account's cap");
  const sql = await Deno.readTextFile(new URL("supabase/migrations/20261031100000_trainee_file_signin_limits.sql", ROOT));
  ok(sql.includes(`case when p_what = 'send' then ${ACCOUNT_MAX_SENDS} else ${ACCOUNT_MAX_TRIES} end`), "the migration's caps");
  ok(/x\.created_at > r\.created_at - interval '1 hour' and x\.created_at < r\.created_at \+ interval '1 hour'/.test(sql), "the migration's window");
  ok(/revoke all on function public\.trainee_file_login_count\(text, text, int\) from public, anon, authenticated/.test(sql), "service role only");
  eq(MAX_BODY_BYTES, POLICY.bodyCap); eq(MAX_LINK_SPAN_MS, POLICY.linkSpanMs);
  // the memory twin: 4 links of one account, the account's number typed on each: 10 texts and 15 tries in all, then none
  const m = memSessions();
  const U = "11111111-1111-4111-8111-111111111111", T = Date.parse("2026-11-02T10:00:00Z");
  let sends = 0, tries = 0;
  for (let i = 0; i < 6; i++) {
    const j = `00000000000000${String(i).padStart(2, "0")}`;
    await m.store.beginLogin({ jti: j, userId: U, list: "0123456789", at: T + i * 60_000, expiresAt: T + i * 60_000 + 900_000 });
    await m.store.setPhone(j, "+15125550100", true);
    for (let k = 0; k < 5; k++) if (await m.store.countSend(j, MAX_CODE_SENDS)) sends++;
    for (let k = 0; k < 9; k++) if (await m.store.countTry(j, MAX_CODE_TRIES)) tries++;
  }
  eq([sends, tries], [ACCOUNT_MAX_SENDS, ACCOUNT_MAX_TRIES]);
  // a stranger's number (not matched) checks nothing and texts nothing, so it does not use the account's tries up
  const j = "00000000000000ff";
  await m.store.beginLogin({ jti: j, userId: U, list: "0123456789", at: T, expiresAt: T + 900_000 });
  await m.store.setPhone(j, "+14155550123", false);
  ok(await m.store.countTry(j, MAX_CODE_TRIES), "a try on a stranger's number still counts against its own link only");
  // an hour on, the account's budget is whole again
  const later = "00000000000000ee";
  await m.store.beginLogin({ jti: later, userId: U, list: "0123456789", at: T + 3 * 3600_000, expiresAt: T + 3 * 3600_000 + 900_000 });
  await m.store.setPhone(later, "+15125550100", true);
  ok(await m.store.countSend(later, MAX_CODE_SENDS) && await m.store.countTry(later, MAX_CODE_TRIES));
});

Deno.test("file websec: the cross-site rule (Sec-Fetch-Site, then Origin, then Referer; the site's own address counts as this page)", () => {
  const e = env();
  const at = (h: Record<string, string>, url = "https://abc.supabase.co/functions/v1/trainee-file") => crossSite(new Request(url, { method: "POST", headers: h }), e);
  // the page's own posts, directly or through the /file proxy (the browser's origin is the site's)
  for (const h of [{ "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "same-origin", origin: "https://trainee.example" }, { origin: "https://trainee.example" },
    { "sec-fetch-site": "same-origin", origin: "null" }, { "sec-fetch-site": "none" }, { referer: "https://trainee.example/file" }, {}]) eq(at(h), false, JSON.stringify(h));
  eq(at({ origin: "https://abc.supabase.co" }), false, "the function's own origin");
  // another site, a sibling subdomain, an old browser's null, a downgraded or look-alike origin
  for (const h of [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: "https://evil.example" }, { origin: "null" }, { origin: "http://trainee.example" },
    { origin: "https://trainee.example.evil.example" }, { origin: "https://trainee.example:8443" }, { referer: "https://evil.example/x" }, { referer: "not a url" },
    { "sec-fetch-site": "same-origin", origin: "https://evil.example" }]) eq(at(h), true, JSON.stringify(h));
  // a base address that is not https is not trusted as this page
  eq(crossSite(new Request("https://abc.supabase.co/x", { method: "POST", headers: { origin: "http://trainee.example" } }), env({ TRAINEE_FILE_BASE_URL: "http://trainee.example/file" })), true);
});

Deno.test("file websec: the /file proxy passes the browser's Origin, Referer and Sec-Fetch-Site to the function, and its Allow back", async () => {
  // deno-lint-ignore no-explicit-any
  const proc = (globalThis as any).process;
  const before = proc.env.TRAINEE_FILE_UPSTREAM;
  proc.env.TRAINEE_FILE_UPSTREAM = "https://upstream.test/functions/v1/trainee-file";
  const real = globalThis.fetch;
  const seen: Request[] = [];
  try {
    const mod = await import(`../../api/file.js?websec=${Date.now()}`);
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      seen.push(new Request(u, init));
      return new Response("<p>x</p>", { status: 403, headers: { "content-security-policy": "default-src 'none'; frame-ancestors https://web.telegram.org", "cache-control": "no-store", allow: "GET, HEAD, POST" } });
    }) as typeof fetch;
    const res = await mod.POST(new Request("https://trainee.example/file", { method: "POST", headers: { origin: "https://evil.example", referer: "https://evil.example/x", "sec-fetch-site": "cross-site", cookie: "tf_l=abc", "content-type": "application/x-www-form-urlencoded" }, body: "action=phone_reset" }));
    eq(seen.length, 1);
    const h = seen[0].headers;
    eq([h.get("origin"), h.get("referer"), h.get("sec-fetch-site"), h.get("cookie")], ["https://evil.example", "https://evil.example/x", "cross-site", "tf_l=abc"]);
    eq(res.status, 403);
    eq(res.headers.get("allow"), "GET, HEAD, POST");
    ok(/frame-ancestors/.test(res.headers.get("content-security-policy") ?? "") && res.headers.get("cache-control") === "no-store");
  } finally {
    globalThis.fetch = real;
    if (before === undefined) delete proc.env.TRAINEE_FILE_UPSTREAM; else proc.env.TRAINEE_FILE_UPSTREAM = before;
  }
});

Deno.test("file websec: the deployed dependencies pace every phone step and keep the text alive in the background", () => {
  const stub = new Proxy({}, { get: () => () => stub }) as never;
  const d = buildFileDeps(stub, env(), () => 0);
  ok(typeof d.pace === "function" && typeof d.background === "function", "pace and background are wired");
  ok(PHONE_STEP_FLOOR_MS >= 1000, "the floor covers a provider's usual answer time");
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any, had = g.EdgeRuntime;
  const kept: Promise<unknown>[] = [];
  g.EdgeRuntime = { waitUntil: (p: Promise<unknown>) => { kept.push(p); } };
  try { edgeBackground(Promise.resolve(1)); eq(kept.length, 1); } finally { if (had === undefined) delete g.EdgeRuntime; else g.EdgeRuntime = had; }
  edgeBackground(Promise.reject(new Error("x")).catch(() => {})); // no runtime: nothing thrown
});

Deno.test({ name: "file websec: in real time, the account's number and any other number take the same time (texts and code checks are slow, the floor hides them)", sanitizeOps: false, sanitizeResources: false, async fn() {
  const U = "11111111-1111-4111-8111-111111111111", FLOOR = 300;
  const s = memSessions(), P = fakePhone({ [U]: "+15125550100" });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const phone = { ...P.auth, async send(p: string) { const r = await P.auth.send(p); await sleep(220); return r; }, async check(p: string, c: string) { await sleep(180); return await P.auth.check(p, c); } };
  let now = Date.parse("2026-11-02T15:00:00Z");
  const kept: Promise<unknown>[] = [];
  const d = { store: {} as never, cards: {} as never, tap: {} as never, now: () => now, env: env(), sessions: s.store, phone, pace: phonePace(FLOOR), background: (p: Promise<unknown>) => { kept.push(p); } } as unknown as FileDeps;
  const open = async () => {
    const t = (await mintFileToken({ secret: SECRET, userId: U, list: "0123456789", now, kind: "l" }))!;
    const r = await handleFile(new Request(`https://trainee.example/file?t=${encodeURIComponent(t)}`), d);
    return `tf_l=${r.headers.getSetCookie()[0].split(";")[0].split("=").slice(1).join("=")}`;
  };
  const timed = async (cookie: string, form: Record<string, string>) => {
    const t0 = performance.now();
    const r = await handleFile(new Request("https://trainee.example/file", { method: "POST", headers: { cookie, origin: "https://trainee.example", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }), d);
    await r.text();
    return { ms: performance.now() - t0, status: r.status };
  };
  const a = await open(), b = await open();
  const own = await timed(a, { action: "phone_start", phone: "+15125550100" }), other = await timed(b, { action: "phone_start", phone: "+14155550123" });
  eq([own.status, other.status], [200, 200]);
  eq(P.texts.length, 1, "the account's number was texted");
  const ownV = await timed(a, { action: "phone_verify", code: "000000" }), otherV = await timed(b, { action: "phone_verify", code: "000000" });
  eq([ownV.status, otherV.status], [401, 401]);
  for (const x of [own, other, ownV, otherV]) ok(x.ms >= FLOOR - 5 && x.ms < FLOOR + 120, `every phone step takes the floor: ${x.ms.toFixed(0)} ms`);
  ok(Math.abs(own.ms - other.ms) < 100 && Math.abs(ownV.ms - otherV.ms) < 100, `the same time either way: ${own.ms.toFixed(0)}/${other.ms.toFixed(0)}, ${ownV.ms.toFixed(0)}/${otherV.ms.toFixed(0)} ms`);
  eq(kept.length, 1, "the text was handed to the background");
  await Promise.all(kept);
  now += 1;
} });

Deno.test("file websec: a link lives at most 72 hours from its issue; a longer or backwards span is not a link the bot made", async () => {
  const U = "11111111-1111-4111-8111-111111111111", now = Date.parse("2026-11-02T15:00:00Z");
  const t = (await mintFileToken({ secret: SECRET, userId: U, list: "0123456789", now, kind: "l", ttlMs: 10 * 365 * 24 * 3600_000 }))!;
  const c = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  eq(c.e - c.i, MAX_LINK_SPAN_MS, "minting caps the span");
  ok((await verifyFileToken(t, SECRET, now + MAX_LINK_SPAN_MS - 1)).ok, "a 72-hour link works until its end");
});

// PR #420's CI (architect shard 3/6) failed the Postgres sample on "#325 enum: own": the battery's oracle asked the account's
// number to be answered within 25 ms. Over real Postgres on a loaded runner that number's answer is slower (it alone does one
// more store round trip, countSend), and it waited for nothing: the text is handed to the background. The oracle now asks
// whether the answer came while its text was still held by the provider; this pins both halves of that.
Deno.test({ name: "file websec: a slow store is not an answer that waits for the text (enum scenarios with the account's count 80 ms slow)", sanitizeOps: false, sanitizeResources: false, async fn() {
  const enums = generate().filter((s) => s.cat === "enum");
  const picked = [enums.find((s) => s.id === 325)!, ...enums.filter((s) => s.id !== 325).slice(0, 11)];
  const rep = newReport();
  for (const s of picked) {
    const e = memEnv();
    const base = e.sessions;
    // the round trip only the account's own number makes, as slow as a loaded runner's Postgres made it
    e.sessions = { ...base, countSend: async (j, m) => { await new Promise((r) => setTimeout(r, 80)); return await base.countSend(j, m); } };
    await runScenario(s, e, rep);
  }
  eq(printReport("enum, slow account count", rep), 0, "a slow store is no violation");
  ok((rep.liveness["enum: answered while the text was held"] ?? 0) > 0, "some answers came while their text was held");
  ok((rep.liveness["enum: same answer, same pacing"] ?? 0) === picked.length, "every enum scenario checked the answers");
} });

Deno.test("file websec: the enum oracle still catches an answer that waits for its text, and passes one that is only slow", async () => {
  // an answer that waits for the text: it comes only once the held text is released
  let release = () => {};
  const held = new Promise<void>((r) => { release = r; });
  const waits = held.then(() => "answer");
  const w = await answeredWhileHeld(waits, () => release(), 60);
  eq([w.answered, w.value], [false, "answer"], "waiting for the held text is caught, and the scenario still ends");
  // an answer that is slow (a store round trip of 200 ms) but waits for nothing: never released, still answered
  const slow = new Promise<string>((r) => setTimeout(() => r("answer"), 200));
  let released = false;
  const s = await answeredWhileHeld(slow, () => { released = true; });
  eq([s.answered, s.value, released], [true, "answer", false], "a slow answer that waits for nothing passes");
  ok(ANSWER_DEADLINE_MS >= 1000, "the deadline is far past any honest round trip");
});
