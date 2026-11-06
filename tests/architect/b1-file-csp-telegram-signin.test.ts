// BETA B1 (live beta, 2026-11-05, build eaa5a3f): a File link from Telegram opened to an unstyled sign-in (Times New Roman, a
// 1,889 px logo over the form) whose form could not be sent; the live answer carried `Content-Security-Policy: default-src 'none';
// sandbox`. Cause: Supabase's gateway puts that policy on an edge function's page on *.supabase.co, and the /file proxy (api/file.js)
// copied the upstream Content-Security-Policy onto the site's page, so the function's own policy never reached the browser. And a
// person who uses Trainee only in Telegram has no confirmed phone, so the link's phone sign-in could never finish: the File was
// sent as a plain link only, never with Telegram's own sign-in (the Mini App button). And the prep File's reply claimed "1
// confirmed fact" as the basis of a page whose questions and plan are general.
//
// These run the real proxies, the real page handler, the real Telegram adapter over a fake fetch, and the deployed router bundle.
// No network, no database, no model.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/b1-file-csp-telegram-signin.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { handleFile, type FileDeps } from "../../supabase/functions/trainee-file/handler.ts";
import { PAGE_CSP_HEADER, relayPageCsp } from "../../supabase/functions/_shared/page_csp.ts";
import { feedUrlsFor, fileAppFor, mintFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { FILE_APP_BUTTON, telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { memSessions, signedInit } from "./file-session-fakes.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const SECRET = "file-link-secret-0123456789-abcdef", BASE = "https://trainee.example/file", BOT = "123456:TEST-BOT-TOKEN";
const GATEWAY_CSP = "default-src 'none'; sandbox";
const U = "33333333-3333-4333-8333-333333333333", OTHER = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-11-05T18:00:00Z");
const env = (o: Record<string, string | undefined> = {}) => ({ get: (k: string) => ({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: BASE, TELEGRAM_BOT_TOKEN: BOT, ...o } as Record<string, string | undefined>)[k] });

// What Supabase's gateway does to an edge function's page on *.supabase.co: its own sandbox policy over the function's, and
// text/plain. Every other header (x-trainee-csp among them) as the function sent it.
const gateway = (res: Response) => {
  const h = new Headers(res.headers);
  h.set("content-security-policy", GATEWAY_CSP);
  if (/text\/html/.test(h.get("content-type") ?? "")) h.set("content-type", "text/plain");
  return new Response(res.body, { status: res.status, headers: h });
};
// The proxy module with its upstream set, over a fake upstream (no network).
async function withProxy<T>(name: "file" | "connect", upstream: (req: Request) => Promise<Response> | Response, run: (mod: any) => Promise<T>): Promise<T> {
  // deno-lint-ignore no-explicit-any
  const proc = (globalThis as any).process;
  const key = name === "file" ? "TRAINEE_FILE_UPSTREAM" : "TRAINEE_CONNECT_UPSTREAM";
  const before = proc.env[key];
  proc.env[key] = `https://abc.supabase.co/functions/v1/trainee-${name}`;
  const real = globalThis.fetch;
  try {
    const mod = await import(`../../api/${name}.js?b1=${Math.random()}`);
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => await upstream(new Request(u, init))) as typeof fetch;
    return await run(mod);
  } finally {
    globalThis.fetch = real;
    if (before === undefined) delete proc.env[key]; else proc.env[key] = before;
  }
}
const deps = (o: Partial<FileDeps> = {}): FileDeps => ({ env: env(), now: () => NOW, sessions: memSessions().store, ...o } as unknown as FileDeps);

Deno.test("B1 CSP: the page's own policy reaches the browser through /file; the gateway's sandbox policy never does", async () => {
  // The bot's link, then the phone sign-in it opens, and the Mini App page: the real handler through the deployed wrapper
  // (relayPageCsp), the gateway and the proxy, as the browser receives them.
  const d = deps();
  const fn = async (req: Request) => { const u = new URL(req.url); return gateway(relayPageCsp(await handleFile(new Request(`https://abc.supabase.co/functions/v1/trainee-file${u.search}`, { method: req.method, headers: req.headers }), d))); };
  const { url } = await feedUrlsFor(env(), U, "0123456789", NOW);
  await withProxy("file", fn, async (mod) => {
    const opened = await mod.GET(new Request(`https://trainee.example/file${url!.slice(BASE.length)}`));
    eq([opened.status, opened.headers.get("location")], [303, "/file"]);
    const cookie = opened.headers.getSetCookie().map((c: string) => c.split(";")[0]).join("; ");
    for (const [path, has] of [["/file", "<form"], ["/file?list=0123456789", "data-list"]]) {
      const own = (await handleFile(new Request(`https://abc.supabase.co/functions/v1/trainee-file${path.slice(5)}`, { headers: { cookie } }), d)).headers.get("content-security-policy") ?? "";
      ok(/^default-src 'none'; script-src 'sha256-/.test(own) && /style-src 'unsafe-inline'/.test(own) && /form-action 'self'/.test(own) && /frame-ancestors https:\/\/web\.telegram\.org/.test(own), own);
      const res = await mod.GET(new Request(`https://trainee.example${path}`, { headers: { cookie } }));
      const csp = res.headers.get("content-security-policy") ?? "";
      eq(csp, own, `${path}: the browser gets the page's own policy`);
      ok(!/sandbox/.test(csp), "no sandbox: forms can be sent");
      eq([res.status, res.headers.get("content-type"), res.headers.get(PAGE_CSP_HEADER)], [200, "text/html; charset=utf-8", null], "an HTML page; the carrier header is not passed on");
      const body = await res.text();
      ok(body.includes(has), `${path}: ${body.slice(0, 200)}`);
    }
  });
});

Deno.test("B1 CSP: without the page's policy (an older function), the proxy uses its own strict one, never the gateway's", async () => {
  await withProxy("file", () => new Response("<p>x</p>", { status: 200, headers: { "content-type": "text/plain", "content-security-policy": GATEWAY_CSP } }), async (mod) => {
    const csp = (await mod.GET(new Request("https://trainee.example/file"))).headers.get("content-security-policy") ?? "";
    ok(/^default-src 'none';/.test(csp) && /style-src 'unsafe-inline'/.test(csp) && /form-action 'self'/.test(csp) && /base-uri 'none'/.test(csp) && /frame-ancestors https:\/\/web\.telegram\.org https:\/\/\*\.telegram\.org/.test(csp), csp);
    ok(!/sandbox|script-src|unsafe-eval/.test(csp), `no sandbox and no script at all: ${csp}`);
  });
  // A carrier value that is not the shape the function sends (loose, two policies joined, no frame-ancestors) is not trusted.
  for (const bad of ["default-src *", "default-src 'none'; frame-ancestors *, default-src 'none'; sandbox", "default-src 'none'; style-src 'unsafe-inline'", "script-src * ; default-src 'none'; frame-ancestors 'none'"]) {
    await withProxy("file", () => new Response("<p>x</p>", { status: 200, headers: { "content-security-policy": GATEWAY_CSP, [PAGE_CSP_HEADER]: bad } }), async (mod) => {
      const csp = (await mod.GET(new Request("https://trainee.example/file"))).headers.get("content-security-policy") ?? "";
      ok(csp !== bad && /form-action 'self'/.test(csp) && !/sandbox/.test(csp), `${bad} -> ${csp}`);
    });
  }
});

Deno.test("B1 CSP: a logo stays a sandboxed image; a redirect and its cookies still carry the page's policy", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  await withProxy("file", () => new Response(png, { status: 200, headers: { "content-type": "image/png", "content-security-policy": GATEWAY_CSP } }), async (mod) => {
    const r = await mod.GET(new Request("https://trainee.example/file?logo=example.com"));
    eq([r.headers.get("content-type"), r.headers.get("content-security-policy")], ["image/png", "default-src 'none'; sandbox"]);
    eq(new Uint8Array(await r.arrayBuffer()), png);
  });
  const own = "default-src 'none'; script-src 'sha256-x'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org";
  const fn = () => {
    const h = new Headers({ "content-type": "text/html; charset=utf-8", "content-security-policy": own, location: "/file" });
    h.append("set-cookie", "tf_s=abc; Path=/; HttpOnly"); h.append("set-cookie", "tf_l=; Max-Age=0");
    return new Response("", { status: 303, headers: h });
  };
  const relayed = relayPageCsp(fn());
  eq([relayed.status, relayed.headers.get(PAGE_CSP_HEADER), relayed.headers.getSetCookie().length], [303, own, 2], "the wrapper changes nothing else");
  await withProxy("file", () => gateway(relayPageCsp(fn())), async (mod) => {
    const r = await mod.POST(new Request("https://trainee.example/file", { method: "POST", body: "action=phone_verify&code=123456", headers: { "content-type": "application/x-www-form-urlencoded" } }));
    eq([r.status, r.headers.get("location"), r.headers.get("content-security-policy"), r.headers.getSetCookie().length], [303, "/file", own, 2]);
  });
  const plain = new Response("x", { status: 200 });
  eq(relayPageCsp(plain), plain, "no policy: the same response");
});

Deno.test("B1 CSP: /connect gets the same treatment", async () => {
  const own = "default-src 'none'; script-src 'sha256-y' https://telegram.org; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; base-uri 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org";
  await withProxy("connect", () => gateway(relayPageCsp(new Response("<form></form>", { status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": own } }))), async (mod) => {
    const r = await mod.GET(new Request("https://trainee.example/connect?w=replies"));
    eq([r.headers.get("content-type"), r.headers.get("content-security-policy")], ["text/html; charset=utf-8", own]);
  });
  await withProxy("connect", () => new Response("<form></form>", { status: 200, headers: { "content-security-policy": GATEWAY_CSP } }), async (mod) => {
    const csp = (await mod.GET(new Request("https://trainee.example/connect"))).headers.get("content-security-policy") ?? "";
    ok(!/sandbox/.test(csp) && /form-action 'self'/.test(csp), csp);
  });
});

Deno.test("B1 URL base: File links point at the site's /file (the proxy), and the Mini App URL is only ever made from our own link", async () => {
  const links = await feedUrlsFor(env(), U, "0123456789", NOW);
  ok(links.url!.startsWith(`${BASE}?t=v1.`) && links.webApp === `${BASE}?list=0123456789`, JSON.stringify(links));
  eq(await fileAppFor(env(), links.url!, NOW), `${BASE}?list=0123456789`);
  eq(await fileAppFor(env(), `  ${links.url!}\n`, NOW), `${BASE}?list=0123456789`, "the link alone, whitespace aside");
  // Not ours, not alone, tampered, expired, not a link token, Telegram sign-in off, no https base: no button.
  const forged = links.url!.replace(/\.([A-Za-z0-9_-]{43})$/, (_m, s: string) => `.${s[0] === "A" ? "B" : "A"}${s.slice(1)}`);
  const sTok = await mintFileToken({ secret: SECRET, userId: U, list: "0123456789", now: NOW, kind: "s" });
  for (const [why, text, e] of [["another site", `https://evil.example/file?t=${links.url!.split("?t=")[1]}`, env()], ["words around it", `Open it: ${links.url}`, env()], ["forged", forged, env()],
    ["a session-kind token", `${BASE}?t=${sTok}`, env()], ["no bot token", links.url!, env({ TELEGRAM_BOT_TOKEN: undefined })], ["http base", links.url!.replace("https:", "http:"), env({ TRAINEE_FILE_BASE_URL: "http://trainee.example/file" })]] as const) {
    eq(await fileAppFor(e, text, NOW), null, why);
  }
  eq(await fileAppFor(env(), links.url!, NOW + 73 * 3600_000), null, "expired");
});

Deno.test("B1 sign-in: on Telegram a File link carries Telegram's own sign-in button (sendLink and a reply part alike); other text does not", async () => {
  const calls: { method: string; body: any }[] = [];
  const f = (async (u: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: String(u).split("/").pop()!, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const a = telegramAdapter({ token: BOT, fetch: f, sleep: async () => {}, fileApp: (t) => fileAppFor(env(), t, NOW) });
  const { url } = await feedUrlsFor(env(), U, "0123456789", NOW);
  ok((await a.sendLink!("42", url!)).ok);
  ok((await a.send("42", ["Your one-page interview prep File: 5 questions and a 30-minute plan.", url!])).ok);
  ok((await a.send("42", ["No link here."])).ok);
  ok((await a.send("42", [url!], { buttons: [[{ text: "Approve", data: "c:1:yes" }]] })).ok);
  const app = { inline_keyboard: [[{ text: FILE_APP_BUTTON, web_app: { url: `${BASE}?list=0123456789` } }]] };
  eq(calls.map((c) => [c.body.text === url, c.body.reply_markup ?? null]), [[true, app], [false, null], [true, app], [false, null], [true, { inline_keyboard: [[{ text: "Approve", callback_data: "c:1:yes" }]] }]],
    "the link's own message gets the button; a card's own buttons stay as they were");
  // Without the lookup (or when it fails) the message is exactly as before.
  calls.length = 0;
  const plain = telegramAdapter({ token: BOT, fetch: f, sleep: async () => {} });
  await plain.sendLink!("42", url!);
  const broken = telegramAdapter({ token: BOT, fetch: f, sleep: async () => {}, fileApp: () => Promise.reject(new Error("x")) });
  await broken.sendLink!("42", url!);
  eq(calls.map((c) => c.body.reply_markup ?? null), [null, null]);
});

Deno.test("B1 sign-in: the Mini App opens a File for a Telegram-only account (no phone); a forwarded button opens nothing of the sender's", async () => {
  const store = memoryFileStore();
  const files = createFileService({ store, env: env(), now: () => NOW });
  const made = await files.create(U, "draft", { title: "Thank-you note", type: "message", body: "Thank you for your time today.", basis: [] });
  ok(made.ok && made.url && made.webApp, JSON.stringify(made));
  const app = await fileAppFor(env(), (made as any).url, NOW);
  eq(app, (made as any).webApp, "the button opens the same File the link names");
  const list = new URL(app!).searchParams.get("list")!;
  const linked: Record<string, string> = { "777": U, "888": OTHER };
  const s = memSessions();
  // No phone at all: the phone sign-in is not even wired, as for an account with no confirmed phone.
  const d = deps({ sessions: s.store, files, userOfTelegram: async (tg: string) => linked[tg] ?? null, phone: undefined });
  const boot = await handleFile(new Request(app!), d);
  eq(boot.status, 200);
  ok((await boot.text()).includes(`data-list="${list}"`), "the Mini App page");
  const open = async (tg: string) => await handleFile(new Request(BASE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://trainee.example" },
    body: new URLSearchParams({ init: await signedInit(tg, NOW / 1000 - 30, BOT), list }).toString() }), d);
  const mine = await open("777");
  const page = await mine.text();
  eq(mine.status, 200, page.slice(0, 300));
  ok(page.includes("Thank-you note") && page.includes("Thank you for your time today."), "the owner, signed in by Telegram, sees the File");
  const theirs = await open("888");
  const other = await theirs.text();
  ok(!other.includes("Thank you for your time today.") && !other.includes("Thank-you note"), "another linked Telegram account sees nothing of it");
  const stranger = await open("999");
  eq(stranger.status, 403, "a Telegram account linked to no one opens nothing");
  ok(!(await stranger.text()).includes("Thank you for your time today."));
  eq((await handleFile(new Request(BASE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ init: await signedInit("777", NOW / 1000 - 30, "999:OTHER-BOT"), list }).toString() }), d)).status, 403, "forged Telegram data");
});

Deno.test("B1 reply: the interview prep File's reply makes no claim about the person's record", () => {
  const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
  const turn = (text: string, profile: unknown) => {
    const snapshot = profile ? { v: 1, scope: { userId: U }, stores: { profile } } : null;
    return host.runTurn(text, host.createTurnCtx({ userId: U, threadId: "t-b1", now: NOW, snapshot, accountPersistence: true }));
  };
  const ask = "Make me a one-page interview prep checklist file with five questions and a 30-minute plan";
  const withFact = { basics: { name: "Jordan Lee" }, facts: [{ id: "F1", kind: "experience", text: "Cashier at a grocery store, 2 years; trained 4 new hires on the register.", source: "resume-ingest", needs_confirmation: false }] };
  for (const [why, profile] of [["no profile", null], ["one confirmed fact", withFact]] as const) {
    const out = turn(ask, profile);
    ok(out.result?.file?.kind === "plan_review", `${why}: a File was made: ${out.reply}`);
    ok(!/confirmed (?:profile )?facts?|your record|comes only from|fills in nothing about you/i.test(out.reply), `${why}: no claim about the record: ${out.reply}`);
    ok(/5 practice questions/.test(out.reply) && /Nothing was sent\./.test(out.reply), out.reply);
  }
  // The page itself still says what it lists from the record, under its own heading, and only confirmed facts.
  const data = turn(ask, withFact).result.file.data;
  const rec = data.sections.find((s: any) => /^From your record/.test(s.heading));
  eq(rec.items.map((i: any) => i.source), ["From your resume"]);
});
