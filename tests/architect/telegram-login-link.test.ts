// FEATURE 16 (owner decision, 2026-10-26, in writing): a Telegram chat is linked to a Trainee account with Telegram's own
// login (the "Link your Trainee account" login_url button), verified server-side with the bot token (hash, auth_date
// freshness); one Telegram user to exactly one account; a replay refused; unlinking supported. Fake signed payloads,
// signed here exactly as Telegram signs them, through the real edge handler (trainee-telegram-link/handler.ts) and the
// real database functions (20261026220016) on the flow harness's Postgres; and the chat side (the button, "unlink telegram").
import assertNode from "node:assert/strict";
import { LOGIN_REPLY, loginHash, verifyTelegramLogin } from "../../supabase/functions/_shared/telegram_login.ts";
import { handleTelegramLink } from "../../supabase/functions/trainee-telegram-link/handler.ts";
import { LINK_BUTTON, runInbound, TELEGRAM_LINK_REPLY, TELEGRAM_UNLINKED_REPLY } from "../../supabase/functions/_shared/channel_inbound.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { pgBinDir, startPg } from "../flow/pg.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const TOKEN = "123456:TEST-login-bot-token";
const NOW = Date.parse("2026-10-26T18:00:00Z");
const sec = (ms: number) => Math.floor(ms / 1000);
// A payload as Telegram signs it: the fields, then hash = hex HMAC-SHA-256(data-check string, SHA-256(bot token)).
async function signed(fields: Record<string, string | number>, token = TOKEN) {
  const f = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)]));
  return { ...f, hash: await loginHash(f, token) };
}

Deno.test("F16 login verify: Telegram's hash with the bot token, at most 10 minutes old; bad hash, stale, future, missing or unsigned fields refused", async () => {
  const good = await signed({ id: 555000111, first_name: "Alex", username: "alex_test", auth_date: sec(NOW) - 30 });
  const v = await verifyTelegramLogin(good, TOKEN, NOW);
  eq([v.ok, v.ok && v.telegramId, v.ok && v.name], [true, "555000111", "Alex"]);
  // Independently computed (the documented algorithm, spelled out): sorted "k=v" lines, HMAC keyed by SHA-256(token).
  const dcs = `auth_date=${sec(NOW) - 30}\nfirst_name=Alex\nid=555000111\nusername=alex_test`;
  const key = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", new TextEncoder().encode(TOKEN)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(dcs)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  eq(good.hash, want);
  eq((await verifyTelegramLogin({ ...good, first_name: "Mallory" }, TOKEN, NOW)), { ok: false, why: "bad_hash" }, "a changed field");
  eq((await verifyTelegramLogin(await signed({ id: 555000111, auth_date: sec(NOW) - 30 }, "999:other-bot"), TOKEN, NOW)), { ok: false, why: "bad_hash" }, "signed for another bot");
  eq((await verifyTelegramLogin(await signed({ id: 555000111, auth_date: sec(NOW) - 601 }), TOKEN, NOW)), { ok: false, why: "stale" });
  eq((await verifyTelegramLogin(await signed({ id: 555000111, auth_date: sec(NOW) + 3600 }), TOKEN, NOW)), { ok: false, why: "future" });
  eq((await verifyTelegramLogin({ id: "555000111", auth_date: String(sec(NOW)) }, TOKEN, NOW)), { ok: false, why: "missing" }, "no hash");
  eq((await verifyTelegramLogin({ ...good, role: "admin" }, TOKEN, NOW)), { ok: false, why: "missing" }, "a field Telegram never signs");
  eq((await verifyTelegramLogin(good, "", NOW)), { ok: false, why: "not_configured" });
});

Deno.test("F16 login, Telegram side: an unlinked chat gets the login button (not a code); 'link my account' too; 'unlink telegram' lets the chat go", async () => {
  const sent: any[] = [], unlinked: string[] = [];
  const env = new Map([["TELEGRAM_LOGIN_URL", "https://trainee.example.test/telegram-link"]]);
  const d: any = {
    env: { get: (k: string) => env.get(k) }, now: () => NOW, render: (t: string) => [t],
    store: { claimMessage: async () => true, person: async (c: string) => (c === "tg:1" ? { userId: "u1", threadId: "t1", contact: c } : null), refusedBefore: async () => false,
      createPerson: async () => { throw new Error("no sign-up here"); }, setThread: async () => {}, setOptOut: async () => {}, enqueueReply: async () => true,
      unlinkTelegram: async (u: string) => { unlinked.push(u); return 1; } },
    reply: async (_c: string, b: string[], opts?: any) => { sent.push({ b, opts }); return { ok: true }; },
    chat: async () => { throw new Error("no turn"); }, deliver: async () => {},
  };
  const msg = (contact: string, text: string, extra: Record<string, unknown> = {}) => ({ provider: "telegram", channel: "telegram", messageId: String(Math.random()), contact, address: contact.slice(3), kind: "text", text, ...extra });
  await runInbound(msg("tg:9", "/start", { command: "start" }) as any, d);
  eq(sent.at(-1), { b: [TELEGRAM_LINK_REPLY], opts: { buttons: [[{ text: LINK_BUTTON, loginUrl: "https://trainee.example.test/telegram-link" }]] } });
  await runInbound(msg("tg:1", "link my account") as any, d);
  eq(sent.at(-1).opts.buttons[0][0].text, LINK_BUTTON);
  await runInbound(msg("tg:1", "unlink telegram") as any, d);
  eq([unlinked, sent.at(-1).b], [["u1"], [TELEGRAM_UNLINKED_REPLY]]);
  // The Bot API button: login_url, never callback data.
  const calls: any[] = [];
  const a = telegramAdapter({ token: "T", fetch: (async (_u: string, i: RequestInit) => { calls.push(JSON.parse(String(i.body))); return Response.json({ ok: true, result: { message_id: 1 } }); }) as any, sleep: async () => {} });
  await a.send("9", ["x"], { buttons: [[{ text: LINK_BUTTON, loginUrl: "https://trainee.example.test/telegram-link" }]] });
  eq(calls[0].reply_markup.inline_keyboard, [[{ text: LINK_BUTTON, login_url: { url: "https://trainee.example.test/telegram-link", request_write_access: true } }]]);
});

Deno.test("F16 login web page module: only Telegram's fields are posted, with the person's own session; signed out is said", async () => {
  await import("../../src/telegram-link.js");
  // deno-lint-ignore no-explicit-any
  const W = (globalThis as any).TraineeTelegramLink;
  eq(W.authFrom("?id=5&auth_date=1&hash=" + "a".repeat(64) + "&evil=1"), { id: "5", auth_date: "1", hash: "a".repeat(64) });
  eq(W.authFrom("?id=5"), null);
  const posts: any[] = [];
  const o = { backend: "https://x.test", anonKey: "anon", token: async () => "jwt-1", fetch: async (u: string, i: any) => { posts.push([u, i.headers.authorization, JSON.parse(i.body)]); return Response.json({ outcome: "linked", reply: LOGIN_REPLY.linked }); } };
  eq((await W.link(o, "?id=5&auth_date=1&hash=" + "a".repeat(64))).outcome, "linked");
  eq(posts[0], ["https://x.test/functions/v1/trainee-telegram-link", "Bearer jwt-1", { action: "link", auth: { id: "5", auth_date: "1", hash: "a".repeat(64) } }]);
  eq((await W.link({ ...o, token: async () => null }, "?id=5&auth_date=1&hash=" + "a".repeat(64))).outcome, "signed_out");
  eq(posts.length, 1, "signed out: nothing is posted");
  // Before anything is posted the page asks which Telegram account goes to which Trainee account.
  eq(W.question({ id: "5", first_name: "Alex", username: "alex_test", auth_date: "1", hash: "a".repeat(64) }, "alex@example.test"),
    "Link the Telegram account Alex (@alex_test) to the Trainee account alex@example.test? Only do this if that Telegram account is yours.");
  eq(W.question(null, "x"), null);
});

Deno.test({ name: "F16 login, real database: valid links once; bad hash, stale, replay and a second account refused; unlink; then relink", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg = await startPg();
  try {
    const A = "00000000-0000-4000-8000-0000000016f1", B = "00000000-0000-4000-8000-0000000016f2";
    await pg.sql(`insert into auth.users (id, email) values ('${A}', 'a@example.test'), ('${B}', 'b@example.test');`);
    const svc = pg.asService();
    let now = Date.now();
    const env = new Map([["TELEGRAM_BOT_TOKEN", TOKEN]]);
    const call = async (jwt: string | null, body: unknown) => {
      const res = await handleTelegramLink(new Request("http://x/trainee-telegram-link", { method: "POST", headers: { "content-type": "application/json", ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) }, body: JSON.stringify(body) }),
        { env: { get: (k) => env.get(k) }, now: () => now, userOf: async (t) => ({ "jwt-a": A, "jwt-b": B } as Record<string, string>)[t] ?? null, rpc: (n, a) => svc.rpc(n, a) });
      return { status: res.status, ...(await res.json()) };
    };
    const owner = async (tg: string) => await pg.sql(`select coalesce(user_id::text, '') from public.channel_contacts where contact = 'tg:${tg}'`);
    const good = await signed({ id: 555000111, first_name: "Alex", auth_date: sec(now) - 5 });
    const r1 = await call("jwt-a", { action: "link", auth: good });
    eq([r1.status, r1.outcome, r1.reply], [200, "linked", LOGIN_REPLY.linked]);
    eq(await owner("555000111"), A, "the chat is A's");
    eq(await pg.sql(`select count(*) from public.channel_telegram_logins where hash = '${good.hash}' and outcome = 'linked'`), "1", "the sign-in is recorded as used");
    const bad = await call("jwt-a", { action: "link", auth: { ...good, id: "555000222" } });
    eq([bad.status, bad.outcome], [400, "bad_hash"]);
    const stale = await call("jwt-a", { action: "link", auth: await signed({ id: 555000222, auth_date: sec(now) - 601 }) });
    eq([stale.status, stale.outcome], [400, "stale"]);
    eq(await owner("555000222"), "", "nothing linked by a bad or stale sign-in");
    const replay = await call("jwt-b", { action: "link", auth: good });
    eq([replay.status, replay.outcome], [409, "replay"], "the same signed payload, from anyone, is a replay");
    const second = await call("jwt-b", { action: "link", auth: await signed({ id: 555000111, auth_date: sec(now) - 2 }) });
    eq([second.status, second.outcome, second.reply], [409, "linked_elsewhere", LOGIN_REPLY.linked_elsewhere], "a second account cannot claim a linked Telegram user");
    eq(await owner("555000111"), A, "still A's");
    const out = await call(null, { action: "link", auth: await signed({ id: 555000333, auth_date: sec(now) }) });
    eq([out.status, out.outcome], [401, "signed_out"]);
    const un = await call("jwt-a", { action: "unlink" });
    eq([un.status, un.outcome], [200, "unlinked"]);
    eq(await owner("555000111"), "", "unlinked");
    eq((await call("jwt-a", { action: "unlink" })).outcome, "not_linked");
    // A channel-only account (its own chat's sign-up) is never unlinked from its chat.
    const C = "00000000-0000-4000-8000-0000000016f3";
    await pg.sql(`insert into auth.users (id, email) values ('${C}', 'tg-555000999@users.trainee.invalid');
      insert into public.channel_contacts (contact, user_id, created_at, updated_at) values ('tg:555000999', '${C}', now(), now());`);
    const tok: Record<string, string> = { "jwt-c": C };
    const res = await handleTelegramLink(new Request("http://x/l", { method: "POST", headers: { authorization: "Bearer jwt-c" }, body: JSON.stringify({ action: "unlink" }) }),
      { env: { get: (k) => env.get(k) }, now: () => now, userOf: async (t) => tok[t] ?? null, rpc: (n, a) => svc.rpc(n, a) });
    const body = await res.json();
    eq([res.status, body.outcome, body.reply], [409, "channel_only", LOGIN_REPLY.channel_only]);
    eq(await owner("555000999"), C, "the chat is still its account");
    now += 1000;
    const relink = await call("jwt-b", { action: "link", auth: await signed({ id: 555000111, auth_date: sec(now) }) });
    eq([relink.status, relink.outcome], [200, "linked"]);
    eq(await owner("555000111"), B, "after A unlinked, B links it");
    assert(Number(await pg.sql(`select count(*) from public.channel_telegram_logins`)) === 3, "only verified sign-ins reach the database (linked, linked_elsewhere, relinked)");
  } finally {
    await pg.stop();
  }
} });
