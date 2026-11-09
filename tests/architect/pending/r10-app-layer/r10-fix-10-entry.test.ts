// R10 fix 10 (spec E.10 10; E.7 55-60; C.23): the entry and recovery pages fit a phone and sign-in is real. The bare /file and
// /connect pages (no link) show their recovery text and action inside the first 390 x 844 screen (the audit saw an oversized
// T mark push it below the fold); an invalid or expired link opens nothing private and says how to recover; a File opens only
// after a real sign-in (Telegram's signed initData for the linked chat), and signing out makes it unavailable again.
// EXPECTED TO FAIL ON TRUNK (WO-F). Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json <this file>
const helper = (() => { let u = new URL(".", import.meta.url); for (let i = 0; i < 8; i++) { const c = new URL("tests/architect/helpers/", u); try { Deno.statSync(c); return c.href; } catch { u = new URL("..", u); } } throw new Error("tests/architect/helpers not found"); })();
const R = await import(`${helper}r10_world.ts`);
const T = await import(`${helper}r10_turns.ts`);
const { ok, check, deliveredFiles, internalHits, repeated, renderPhone } = R;
const FILE = "r10-fix-10-entry.test.ts", CHAT = 7_911_001;
const FOLD = `(() => {
  const h = document.querySelector("h1"), p = h ? (h.parentElement.querySelector("p") || document.querySelector("main p")) : null;
  const act = [...document.querySelectorAll("a[href],button")].find((e) => /telegram|open|new link|trainee|sign in|try again/i.test(e.textContent || ""));
  const marks = [...document.querySelectorAll("svg,img,.brand,.mark,[class*=logo],[class*=mark]")].map((e) => e.getBoundingClientRect().height);
  const b = (e) => e ? e.getBoundingClientRect().bottom : null;
  return { h1: h ? h.textContent.trim() : null, h1Bottom: b(h), pBottom: b(p), action: act ? act.textContent.trim().slice(0, 40) : null, actionBottom: b(act), markMax: marks.length ? Math.max(...marks) : 0 };
})()`;
R.suite(FILE, [10], [CHAT], async (t: Deno.TestContext, w: any) => {
  const { handleConnect } = await import(`${helper}../../../supabase/functions/trainee-connect/handler.ts`);
  const { supabaseConnectDeps } = await import(`${helper}../../../supabase/functions/trainee-connect/store.ts`);
  Deno.env.set("TRAINEE_CONNECT_BASE_URL", "https://trainee.test/connect");
  Deno.env.set("TRAINEE_CONNECT_LINK_SECRET", R.FILE_SECRET);
  const pages: Record<string, () => Promise<any>> = {
    "bare /file": async () => await w.open(R.FILE_BASE, CHAT),
    "bare /connect": async () => {
      const { relayPageCsp } = await import(`${helper}../../../supabase/functions/_shared/page_csp.ts`);
      const { pageCsp } = await import(`${helper}../../../api/_page_csp.js`);
      const res = relayPageCsp(await handleConnect(new Request("https://trainee.test/connect", { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } }), supabaseConnectDeps(w.admin, Deno.env)));
      return { status: res.status, type: res.headers.get("content-type") ?? "", html: await res.text(), csp: pageCsp(res.headers) };
    },
    "invalid /file link": async () => await w.open(`${R.FILE_BASE}?t=v1.not-a-real-token`, CHAT),
  };
  for (const [name, get] of Object.entries(pages)) {
    await check(t, FILE, 10, `${name}: the recovery heading, text and action are inside the first phone screen (390 x 844)`, async (ev: any) => {
      const got: any = await get();
      ok(/html/.test(got.type) && got.html, `${name} is a page (HTTP ${got.status})`);
      ok(got.csp, `${name}: rendered under the policy production serves it with`);
      const r = await R.renderOpened(got, `f10-${name}`, FOLD);
      ev.screenshots.push(r.screenshot);
      ev.reply = r.text.slice(0, 400);
      ok(r.probe.h1, `${name}: a recovery heading`);
      ok(r.probe.h1Bottom !== null && r.probe.h1Bottom <= 844 * 0.6, `${name}: the heading sits in the upper screen (bottom ${r.probe.h1Bottom})`);
      ok(r.probe.pBottom !== null && r.probe.pBottom <= 844, `${name}: the recovery text is above the fold (bottom ${r.probe.pBottom})`);
      ok(r.probe.action && r.probe.actionBottom <= 844, `${name}: a recovery action above the fold (${r.probe.action} at ${r.probe.actionBottom})`);
      ok(r.probe.markMax <= 120, `${name}: the brand mark is compact (${r.probe.markMax}px tall)`);
      ok(r.scrollWidth <= r.innerWidth, `${name}: no sideways scroll`);
    }, w);
  }
  const person = await w.observedPerson(CHAT);
  await check(t, FILE, 10, "a File opens only after a real sign-in; signing out makes it unavailable; an invalid link shows nothing private", async (ev: any) => {
    const again = await w.say(CHAT, T.OLD_SEARCH);
    const urls = { url: again.links.find((l: string) => l.startsWith(`${R.FILE_BASE}?t=`)) };
    ok(urls.url, `the list reply carries its File link: ${JSON.stringify(again.links)}`);
    const unsigned = await w.open(`${R.FILE_BASE}?t=v1.forged.${"a".repeat(40)}`, CHAT);
    ok(!/Machine Learning|reddit|Northwind/i.test(unsigned.html ?? ""), "an invalid link shows no private content");
    const signed = await w.open(urls.url, CHAT);
    ok(signed.status === 200 && /Machine Learning/i.test(signed.html ?? ""), `signed in, the person's own list opens (HTTP ${signed.status}): ${(signed.html ?? "").replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300)}`);
    const page = (signed.html ?? "").replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]+>/g, " ").replace(/\s+/g, " ");
    ev.reply = page.slice(0, 500);
    ok(/signed in|sign out/i.test(page), `the signed-in state is visible (a "Signed in" mark or a Sign out control), only after the sign-in: ${page.slice(0, 300)}`);
    ok(!/signed in/i.test((unsigned.html ?? "").replace(/<[^>]+>/g, " ")), "the invalid link never says signed in");
    const pageToken = /name="t" value="([^"]+)"/.exec(signed.html ?? "")?.[1] ?? "";
    ok(pageToken, "the page carries its page token");
    const out = await handleFileRaw(w, { action: "signout", t: pageToken });
    ok(/signed out/i.test(out), `signing out says so: ${out.slice(0, 200)}`);
    const after = await handleFileRaw(w, { t: pageToken });
    ok(!/Machine Learning|reddit/i.test(after), "after signing out the private page is unavailable");
    const r = await renderPhone(after, "f10-after-signout", undefined, { csp: signed.csp });
    ev.screenshots.push(r.screenshot);
  }, w);
});
async function handleFileRaw(w: any, fields: Record<string, string>) {
  const { handleFile } = await import(`${helper}../../../supabase/functions/trainee-file/handler.ts`);
  const { buildFileDeps } = await import(`${helper}../../../supabase/functions/trainee-file/deps.ts`);
  const res = await handleFile(new Request(R.FILE_BASE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(R.FILE_BASE).origin, "user-agent": "Mozilla/5.0 (iPhone)" }, body: new URLSearchParams(fields).toString() }), buildFileDeps(w.admin, Deno.env, Date.now));
  return await res.text();
}
