// R10 WO-F fixes 10 and 11 in a real Chromium (spec C.23, C.24, E.7 items 55-61, E.11): every entry, recovery and connection state,
// served the way production serves it: the edge function's handler -> its policy relayed in x-trainee-csp (page_csp.ts) -> the
// Supabase gateway's own `default-src 'none'; sandbox` policy and text/plain label -> the site's /file and /connect proxies
// (api/file.js, api/connect.js) -> the browser. Measured at 390x844 (a phone) and 1280x800:
//   - the heading and the recovery or primary action sit inside the first screen (no scrolling), the mark is compact (<= 32 px),
//     and nothing scrolls sideways;
//   - the same holds where no style applies at all (the gateway's sandbox policy reaching the browser): the mark's size is in the
//     markup, so it can no longer fill the screen (the observed failure: a 350 px "T" above the recovery);
//   - the code step's "Signing you in" state: the button disabled and relabelled, the status shown, nothing private.
// Synthetic content only (fictional employers and a fictional address). R10_SNAPSHOTS=1 writes every screenshot (deviceScaleFactor 2)
// to tests/architect/snapshots/r10-entry/. No network: every request that is not the site is aborted (system fonts render).
import assertNode from "node:assert/strict";
import { createRequire } from "node:module";
import process from "node:process";
import { mintFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { mintConnectToken } from "../../supabase/functions/_shared/connect_link.ts";
import { relayPageCsp } from "../../supabase/functions/_shared/page_csp.ts";
import { connectLanding } from "../../supabase/functions/_shared/connect_landing.ts";
import { jobViewOf, refOf } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { handleConnect, type ConnectDeps, type ProviderId, type ProviderState } from "../../supabase/functions/trainee-connect/handler.ts";
import { fakePhone, memSessions } from "./file-session-fakes.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const OUT = `${ROOT}/tests/architect/snapshots/r10-entry`;
const WRITE = Deno.env.get("R10_SNAPSHOTS") === "1";
const SITE = "https://trainee.test", GATEWAY = "https://gateway.test/functions/v1";
const U = "8c0f8f8e-6a43-4a49-9d2c-0000000f3e01", U_PHONE = "+15125550160", LIST = "0c0c0c0c0c";
const SECRET = "r10-browser-link-secret-0123456789-abcdef", BOT_URL = "https://t.me/TraineeTestBot";
const COMPANY = "Lakefront Analytics (fictional)", ADDR = "ada.fictional@example.test";
const NOW = Date.parse("2026-11-09T15:00:00Z");
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

function playwright(): any {
  const req = createRequire(import.meta.url);
  for (const p of [Deno.env.get("UPMORE_PLAYWRIGHT_PATH"), `${ROOT}/tools/node_modules/playwright`]) {
    if (!p) continue;
    try { return req(p); } catch { /* next */ }
  }
  return null;
}

// ---------------------------------------------------------------- the two functions, over memory fakes
async function fileWorld(o: { textingOn?: boolean } = {}) {
  const s = memSessions();
  const P = fakePhone({ [U]: U_PHONE }, { configured: o.textingOn !== false });
  const kv = new Map<string, unknown>();
  const v = jobViewOf({ job_id: "greenhouse:r10:1", company: COMPANY, title: "Data Analyst (fictional)", url: "https://boards.greenhouse.io/r10/jobs/1" }, null);
  const ref = await refOf(U, v.job_id); kv.set(`${U}|${ref}`, { job: v, shownAs: "text" }); kv.set(`${U}|list|${LIST}`, [ref]);
  const store = { async recall(u: string, r: string) { return kv.get(`${u}|${r}`) ?? null; }, async recallList(u: string, id: string) { return kv.get(`${u}|list|${id}`) ?? null; },
    async postings() { return []; }, async prepared() { return null; }, async appRow() { return null; }, async wanted() { return false; } } as unknown as FileStore;
  const d: FileDeps = { store, sessions: s.store, phone: P.auth, now: () => NOW, env: { get: (k) => ({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_BOT_URL: BOT_URL } as Record<string, string>)[k] }, cards: {} as never, tap: {} as never };
  return { d, P };
}
function connectWorld() {
  const conn: Record<ProviderId, ProviderState> = { google: { state: "not_connected", email: null }, microsoft: { state: "not_connected", email: null } };
  const d: ConnectDeps = {
    env: { get: (k) => ({ TRAINEE_CONNECT_LINK_SECRET: SECRET, TRAINEE_BOT_URL: BOT_URL, TRAINEE_CONNECT_BASE_URL: `${SITE}/connect` } as Record<string, string>)[k] },
    now: () => NOW,
    providers: () => ({ google: { configured: true, scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"] }, microsoft: { configured: true, scopes: ["openid", "email", "offline_access", "User.Read", "Mail.Read", "Mail.Send"] } }),
    status: async (u) => (u === U ? conn : { google: { state: "not_connected", email: null }, microsoft: { state: "not_connected", email: null } }),
    start: async (p) => `https://accounts.example/${p}/consent?state=s1`,
    disconnect: async (p) => { conn[p] = { state: "not_connected", email: null }; return { ok: true, reply: "Gmail is disconnected. Trainee's access is removed." }; },
    claimLink: async () => true,
  };
  return { d, conn };
}

// The Supabase gateway in front of a function: its own sandbox policy and text/plain, the page's policy left in x-trainee-csp.
async function gateway(res: Response): Promise<Response> {
  const r = relayPageCsp(res);
  const h = new Headers(r.headers);
  h.set("content-security-policy", "default-src 'none'; sandbox");
  h.set("content-type", "text/plain");
  return new Response(r.status >= 300 && r.status < 400 ? null : await r.text(), { status: r.status, headers: h });
}
// Wire the site's proxies to the handlers: api/*.js fetch their upstream with the global fetch.
let fileDeps: FileDeps, connectDeps: ConnectDeps;
const realFetch = globalThis.fetch;
async function proxies() {
  process.env.TRAINEE_FILE_UPSTREAM = `${GATEWAY}/trainee-file`;
  process.env.TRAINEE_CONNECT_UPSTREAM = `${GATEWAY}/trainee-connect`;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    if (u.origin !== new URL(GATEWAY).origin) return await realFetch(input as Request, init);
    const site = new Request(`${SITE}/${u.pathname.endsWith("trainee-file") ? "file" : "connect"}${u.search}`, { method: req.method, headers: req.headers, body: req.method === "POST" ? await req.text() : undefined });
    return await gateway(u.pathname.endsWith("trainee-file") ? await handleFile(site, fileDeps) : await handleConnect(site, connectDeps));
  }) as typeof fetch;
  const file = await import("../../api/file.js");
  const connect = await import("../../api/connect.js");
  return { file: file.GET as (r: Request) => Promise<Response>, connect: connect.GET as (r: Request) => Promise<Response> };
}

// ---------------------------------------------------------------- measuring a page
interface Shot { name: string; viewport: { width: number; height: number } }
const VIEWPORTS = [{ width: 390, height: 844 }, { width: 1280, height: 800 }];
async function measure(page: any, actionSel: string) {
  return await page.evaluate((sel: string) => {
    const box = (e: Element | null) => (e ? e.getBoundingClientRect() : null);
    const visible = (e: Element | null) => { const r = box(e); return !!r && r.width > 0 && r.height > 0 && getComputedStyle(e as Element).visibility !== "hidden"; };
    const h1 = document.querySelector("h1"), mark = document.querySelector("svg.mark");
    const act = [...document.querySelectorAll(sel)].find(visible) ?? null;
    return { h1: box(h1)?.bottom ?? null, h1Text: h1?.textContent ?? "", mark: box(mark)?.height ?? null, action: box(act)?.bottom ?? null, actionText: act?.textContent?.trim() ?? "",
      sideways: document.documentElement.scrollWidth > window.innerWidth + 1, text: document.body.innerText };
  }, actionSel);
}

Deno.test({ name: "R10 fixes 10-11 in Chromium: every entry, recovery and connection state keeps its heading and action in the first phone screen, the mark compact, nothing private", sanitizeResources: false, sanitizeOps: false, async fn() {
  const pw = playwright();
  if (!pw) { if (CI) throw new Error("Playwright is missing in CI"); console.log("NOT_RUN locally: no Playwright"); return; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)"); return; }
  if (WRITE) await Deno.mkdir(OUT, { recursive: true });
  const px = await proxies();
  const browser = await pw.chromium.launch({ args: ["--no-proxy-server"] }); // every request is answered or aborted here, never sent
  const problems: string[] = [];
  const shots: string[] = [];
  try {
    // Opens a page in a context whose every site request goes through the proxies (or, `raw`, straight from the gateway).
    const session = async (viewport: { width: number; height: number }) => {
      // a person's browser (the connect page gives anything that looks automated, "HeadlessChrome" included, only the preview card)
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, userAgent: UA });
      await ctx.route("**/*", (route: any) => answer(route).catch((e: Error) => { problems.push(`route ${route.request().url().slice(0, 60)}: ${e?.message ?? e}`); return route.abort(); }));
      const answer = async (route: any) => {
        const r = route.request(), url = new URL(r.url());
        if (url.origin === new URL(GATEWAY).origin) {
          // the gateway answering the browser itself: what a page looks like with no style at all
          // labelled as a page (the gateway itself says text/plain), so the sandbox policy is the only difference
          const res = await gateway(await handleFile(new Request(`${SITE}/file${url.search}`), fileDeps));
          return route.fulfill({ status: res.status, headers: { ...Object.fromEntries(res.headers), "content-type": "text/html; charset=utf-8" }, body: await res.text() });
        }
        if (url.origin !== SITE) return route.abort();
        const body = r.method() === "POST" ? r.postData() ?? "" : undefined;
        const via = (u: URL) => (u.pathname === "/connect" ? px.connect : px.file);
        let res = await via(url)(new Request(r.url(), { method: r.method(), headers: r.headers(), body }));
        // A redirect is followed here, as the browser would (a fulfilled redirect is not routed again): its cookies go with the next
        // request and back to the browser. Only the site's own clean URL is followed (the proxies never send another).
        const jar = new Map((r.headers().cookie ?? "").split(/;\s*/).filter(Boolean).map((c: string) => [c.split("=")[0], c] as [string, string]));
        const cookies: string[] = [];
        for (let hop = 0; res.status >= 300 && res.status < 400 && hop < 3; hop++) {
          const to = new URL(res.headers.get("location") ?? "", SITE);
          if (to.origin !== SITE) problems.push(`a redirect off the site: ${to.origin}`);
          for (const c of res.headers.getSetCookie()) { cookies.push(c); const kv = c.split(";")[0]; jar.set(kv.split("=")[0], kv); }
          res = await via(to)(new Request(to, { headers: { ...r.headers(), cookie: [...jar.values()].join("; ") } }));
        }
        cookies.push(...res.headers.getSetCookie());
        const headers: Record<string, string> = {};
        res.headers.forEach((v: string, k: string) => { if (k !== "set-cookie") headers[k] = v; });
        if (cookies.length) headers["set-cookie"] = cookies.join("\n");
        return route.fulfill({ status: res.status, headers, body: await res.text() });
      };
      const page = await ctx.newPage();
      return { ctx, page };
    };
    const check = async (page: any, name: string, viewport: { width: number; height: number }, o: { action: string; title: RegExp; secret?: string[] }) => {
      await page.waitForLoadState("load");
      const m = await measure(page, o.action);
      const where = `${name} @${viewport.width}x${viewport.height}`;
      if (!o.title.test(m.h1Text)) problems.push(`${where}: heading "${m.h1Text}"`);
      if (m.mark === null || m.mark > 32) problems.push(`${where}: the mark is ${m.mark} px tall`);
      if (m.h1 === null || m.h1 > viewport.height) problems.push(`${where}: the heading ends at ${m.h1}`);
      if (m.action === null || m.action > viewport.height) problems.push(`${where}: the action (${o.action}) ends at ${m.action} (viewport ${viewport.height})`);
      if (m.sideways) problems.push(`${where}: scrolls sideways`);
      for (const s of o.secret ?? []) if (m.text.includes(s)) problems.push(`${where}: shows ${s}`);
      const file = `${name}-${viewport.width}x${viewport.height}.png`;
      const png = await page.screenshot({ fullPage: false });
      if (WRITE) await Deno.writeFile(`${OUT}/${file}`, png);
      shots.push(file);
      return m;
    };
    const PRIVATE = [COMPANY, U_PHONE, ADDR, "Sign out"];
    for (const vp of VIEWPORTS) {
      // ---- /file: bare, expired, invalid, used; the same bare page with no style at all (the gateway's policy in the browser)
      fileDeps = (await fileWorld()).d; connectDeps = connectWorld().d;
      const recovery = "p.recovery a, p.recovery strong";
      const expired = (await mintFileToken({ secret: SECRET, userId: U, list: LIST, now: NOW - 3 * 86_400_000, kind: "l" }))!;
      for (const [name, q, title] of [["file-bare-invalid", "", /isn.t valid/], ["file-expired", `?t=${encodeURIComponent(expired)}`, /expired/], ["file-tampered", `?t=${encodeURIComponent(expired.slice(0, -5) + "AAAAA")}`, /isn.t valid/]] as const) {
        const s = await session(vp); await s.page.goto(`${SITE}/file${q}`);
        await check(s.page, name, vp, { action: recovery, title, secret: PRIVATE }); await s.ctx.close();
      }
      {
        const s = await session(vp); await s.page.goto(`${GATEWAY}/trainee-file`);
        const sty = await s.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        if (sty !== "rgba(0, 0, 0, 0)") problems.push(`no-style check: the sandboxed page still has a style (${sty})`);
        await check(s.page, "file-bare-no-style", vp, { action: "p.recovery a, p.recovery strong", title: /isn.t valid/, secret: PRIVATE }); await s.ctx.close();
      }
      // ---- the phone sign-in, step by step, through the proxy (cookies as the browser keeps them)
      {
        const w = await fileWorld(); fileDeps = w.d;
        const link = (await mintFileToken({ secret: SECRET, userId: U, list: LIST, now: NOW, kind: "l" }))!;
        const s = await session(vp);
        await s.page.goto(`${SITE}/file?t=${encodeURIComponent(link)}`);
        await check(s.page, "signin-1-phone-entry", vp, { action: "form.login button.apply", title: /^Sign in$/, secret: PRIVATE });
        await s.page.fill("#phone", "512-555-0160"); await s.page.click("form.login button.apply");
        await check(s.page, "signin-2-code-sent", vp, { action: "#codeform button.apply", title: /^Check your phone$/, secret: PRIVATE });
        await s.page.fill("#code", "000000"); await s.page.click("#codeform button.apply");
        await check(s.page, "signin-3-wrong-code", vp, { action: "#codeform button.apply", title: /^That code did not work$/, secret: PRIVATE });
        await s.page.fill("#code", w.P.lastCode());
        // Verifying: the form's submit event fires (the page's own script draws the state) with the post deferred, so the state can
        // be measured; then the same form is posted for real.
        await s.page.evaluate(() => { const f = document.getElementById("codeform") as HTMLFormElement; const hold = (e: Event) => e.preventDefault(); f.addEventListener("submit", hold); f.requestSubmit(); f.removeEventListener("submit", hold); });
        const v = await s.page.evaluate(() => { const b = document.querySelector("#codeform button") as HTMLButtonElement; const st = document.getElementById("verifying")!; return { disabled: b.disabled, label: b.textContent, status: st.hidden ? "" : st.textContent, h1: document.querySelector("h1")!.textContent, masked: (document.getElementById("code") as HTMLInputElement).type === "password" }; });
        if (!v.masked || !v.disabled || v.label !== "Signing in..." || v.status !== "Checking this sign-in. Private content remains hidden." || v.h1 !== "Signing you in") problems.push(`verifying @${vp.width}: ${JSON.stringify(v)}`);
        await check(s.page, "signin-4-verifying", vp, { action: "#codeform button", title: /^Signing you in$/, secret: PRIVATE });
        await Promise.all([s.page.waitForNavigation(), s.page.evaluate(() => (document.getElementById("codeform") as HTMLFormElement).submit())]);
        await s.page.waitForSelector("li.row");
        const signed = await measure(s.page, "li.row");
        if (!signed.text.includes(COMPANY)) problems.push(`signed in @${vp.width}: the person's own list is not shown`);
        const png = await s.page.screenshot(); shots.push(`signin-5-signed-in-${vp.width}x${vp.height}.png`);
        if (WRITE) await Deno.writeFile(`${OUT}/signin-5-signed-in-${vp.width}x${vp.height}.png`, png);
        await s.ctx.close();
      }
      // ---- texting switched off: "We could not send the code", never that it was sent
      {
        fileDeps = (await fileWorld({ textingOn: false })).d;
        const s = await session(vp);
        await s.page.goto(`${SITE}/file?t=${encodeURIComponent((await mintFileToken({ secret: SECRET, userId: U, list: LIST, now: NOW, kind: "l" }))!)}`);
        await s.page.fill("#phone", "512-555-0160"); await s.page.click("form.login button.apply");
        const m = await check(s.page, "signin-code-not-sent", vp, { action: "p.recovery a", title: /^We could not send the code$/, secret: PRIVATE });
        if (/texted it a code|code was sent/i.test(m.text.replace(/no code was sent/i, ""))) problems.push("code-not-sent: says a code was sent");
        await s.ctx.close();
      }
      // ---- the Telegram entry, opened outside Telegram (no signed data): stays here, shows nothing
      {
        fileDeps = (await fileWorld()).d;
        const s = await session(vp); await s.page.goto(`${SITE}/file?list=${LIST}`);
        await s.page.waitForSelector("#nodata:not([hidden])");
        if (await s.page.isVisible("p.status")) problems.push(`telegram entry @${vp.width}: still says it is signing in after it found no Telegram data`);
        await check(s.page, "telegram-entry", vp, { action: "#nodata a.apply", title: /^Open from your Trainee chat$/, secret: PRIVATE });
        await s.ctx.close();
      }
      // ---- /connect: bare, expired; consent; connected; disconnected
      {
        const cw = connectWorld(); connectDeps = cw.d;
        const s = await session(vp); await s.page.goto(`${SITE}/connect`);
        await check(s.page, "connect-bare-invalid", vp, { action: ".recovery a.primary", title: /isn.t valid/, secret: PRIVATE }); await s.ctx.close();
        const old = (await mintConnectToken({ secret: SECRET, userId: U, reason: "confirmations", channel: "telegram", now: NOW - 2 * 3600_000, kind: "l" }))!;
        const s2 = await session(vp); await s2.page.goto(`${SITE}/connect?t=${encodeURIComponent(old)}`);
        await check(s2.page, "connect-expired", vp, { action: ".recovery a.primary", title: /expired/, secret: PRIVATE }); await s2.ctx.close();
        const t = (await mintConnectToken({ secret: SECRET, userId: U, reason: "confirmations", channel: "telegram", now: NOW, kind: "l" }))!;
        const s3 = await session(vp); await s3.page.goto(`${SITE}/connect?t=${encodeURIComponent(t)}`);
        const m = await check(s3.page, "connect-consent", vp, { action: "form.go button.primary", title: /^Connect your email$/, secret: PRIVATE });
        if (!/Exact permissions requested: openid email https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly/.test(m.text.replace(/\s+/g, " "))) problems.push(`consent @${vp.width}: the exact scopes are not shown`);
        await s3.page.screenshot({ fullPage: true }).then((png: Uint8Array) => WRITE ? Deno.writeFile(`${OUT}/connect-consent-full-${vp.width}x${vp.height}.png`, png) : undefined);
        shots.push(`connect-consent-full-${vp.width}x${vp.height}.png`);
        // a consent started (Continue tapped) that never came back: the page remembers it and offers Resume or Cancel
        await s3.ctx.addCookies([{ name: "tc_p", value: "google", url: SITE, httpOnly: true, secure: true }]);
        await s3.page.goto(`${SITE}/connect`);
        await check(s3.page, "connect-unfinished", vp, { action: "form.go button.primary", title: /^Connecting didn.t finish$/, secret: PRIVATE });
        cw.conn.google = { state: "connected", email: ADDR };
        await s3.page.goto(`${SITE}/connect`);
        await check(s3.page, "connect-connected", vp, { action: "form.disc button", title: /^Your email is connected$/ });
        await s3.page.click("form.disc button");
        await check(s3.page, "connect-disconnected", vp, { action: "a.primary", title: /^Gmail disconnected$/, secret: [ADDR] });
        if (cw.conn.google.state !== "not_connected") problems.push("Disconnect on the page did not disconnect");
        await s3.ctx.close();
      }
      // ---- the OAuth callback's landings (served from the function's own origin; drawn here as the browser gets them)
      const env = { get: (k: string) => ({ TRAINEE_CONNECT_LINK_SECRET: SECRET, TRAINEE_BOT_URL: BOT_URL, TRAINEE_CONNECT_BASE_URL: `${SITE}/connect` } as Record<string, string>)[k] };
      const landings: [string, Parameters<typeof connectLanding>[1], string, RegExp][] = [
        ["landing-connected", { provider: "google", ok: true, denied: false, email: ADDR, userId: U, scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"], now: NOW }, "form button.lnk", /^Gmail connected$/],
        ["landing-cancelled", { provider: "google", ok: false, denied: true, email: null }, "a.primary", /^Nothing was connected$/],
        ["landing-incomplete", { provider: "microsoft", ok: false, denied: true, email: null, why: "incomplete" }, "a.primary", /^That didn.t work$/],
        ["landing-failed", { provider: "google", ok: false, denied: false, email: null }, "a.primary", /^That didn.t work$/],
        ["landing-wrong-account", { provider: "google", ok: false, denied: false, email: "someone.else@example.test", why: "other_account" }, "a.primary", /^A different account was used$/],
      ];
      for (const [name, o, action, title] of landings) {
        const res = await connectLanding(env, o)!;
        const body = await res.text();
        const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
        await ctx.route("**/*", (r: any) => r.request().url() === `${GATEWAY}/gmail-oauth` ? r.fulfill({ status: res.status, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": res.headers.get("content-security-policy")! }, body }) : r.abort());
        const page = await ctx.newPage(); await page.goto(`${GATEWAY}/gmail-oauth`);
        const m = await check(page, name, vp, { action, title, secret: name === "landing-connected" ? [] : [ADDR, "Connected as"] });
        if (name !== "landing-connected" && !/Connection not finished\s+No access saved\./.test(m.text)) problems.push(`${name}: no "Connection not finished / No access saved."`);
        await ctx.close();
      }
    }
  } catch (e) {
    throw new Error(`${(e as Error).message}\n${problems.join("\n")}`);
  } finally {
    await browser.close();
    globalThis.fetch = realFetch;
  }
  if (WRITE) console.log(`wrote ${shots.length} screenshots to ${OUT}`);
  assert(!problems.length, problems.join("\n"));
} });
