// R10 fix 11 (spec E.10 11; E.7 61; C.23): account connections are explicit and recoverable. Through the real trainee-connect
// handler with a signed connect link: before connecting, the page names the account provider, the task-specific purpose and
// the actual permissions in plain words; a connected account shows which address and a Disconnect control; an account that
// needs reconnecting says so with the way back; a consent that did not complete is never shown as connected; each state fits
// a 390 px phone. (Live consent, wrong-account and inbox permissions need their own live test: spec E.11.)
// EXPECTED TO FAIL ON TRUNK (WO-F). Run: CI=true deno test -A --no-check <this file>
const helper = (() => { let u = new URL(".", import.meta.url); for (let i = 0; i < 8; i++) { const c = new URL("tests/architect/helpers/", u); try { Deno.statSync(c); return c.href; } catch { u = new URL("..", u); } } throw new Error("tests/architect/helpers not found"); })();
const R = await import(`${helper}r10_world.ts`);
const T = await import(`${helper}r10_turns.ts`);
const { ok, check, deliveredFiles, internalHits, repeated, renderPhone } = R;
const { handleConnect } = await import(`${helper}../../../supabase/functions/trainee-connect/handler.ts`);
const { mintConnectToken, REASONS } = await import(`${helper}../../../supabase/functions/_shared/connect_link.ts`);
// Architect amendment (item 14, coordinator 2026-11-10): Telegram's signed Mini App data, for the identified view.
const { signedInit } = await import(`${helper}../file-session-fakes.ts`);
const BOT_TOKEN = "123456:TEST-r10-bot-token";
type ConnectDeps = any;
const FILE = "r10-fix-11-connections.test.ts";
const SECRET = "TEST-r10-connect-secret-0123456789abcdef", BASE = "https://trainee.test/connect", U = "00000000-0000-4000-8000-00000000a011";
const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1";
const READ = "https://www.googleapis.com/auth/gmail.readonly";
function deps(state: Record<string, { state: "not_connected" | "connected" | "needs_reconnect"; email: string | null }>): ConnectDeps {
  const used = new Set<string>();
  return {
    env: { get: (k: string) => ({ TRAINEE_CONNECT_LINK_SECRET: SECRET, TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_CONNECT_BASE_URL: BASE, TRAINEE_BOT_URL: "https://t.me/TraineeR10Bot", GOOGLE_OAUTH_CLIENT_ID: "cid", GOOGLE_OAUTH_CLIENT_SECRET: "csecret", TELEGRAM_BOT_TOKEN: BOT_TOKEN } as Record<string, string>)[k] },
    userOfTelegram: async (id: string) => (id === "7011" ? U : null),
    now: () => Date.now(),
    providers: () => ({ google: { configured: true, scopes: ["openid", "email", READ] }, microsoft: { configured: true, scopes: ["openid", "email", "offline_access", "Mail.Read"] } }) as any,
    status: async () => ({ google: state.google ?? { state: "not_connected", email: null }, microsoft: state.microsoft ?? { state: "not_connected", email: null } }) as any,
    start: async () => "https://accounts.example/consent?state=s1",
    disconnect: async () => ({ ok: true, reply: "Gmail is disconnected." }),
    claimLink: async (_u: string, jti: string) => { if (used.has(jti)) return false; used.add(jti); return true; },
  };
}
const { relayPageCsp } = await import(`${helper}../../../supabase/functions/_shared/page_csp.ts`);
const { pageCsp } = await import(`${helper}../../../api/_page_csp.js`);
let CSP = "";
const keep = (res: Response) => { const r = relayPageCsp(res); CSP = pageCsp(r.headers); return r; };
const shot = (h: string, name: string) => renderPhone(h, name, undefined, { csp: CSP });
async function session(d: ConnectDeps) {
  const t = await mintConnectToken({ secret: SECRET, userId: U, reason: "replies", channel: "telegram", now: Date.now(), kind: "l" });
  const first = await handleConnect(new Request(`${BASE}?t=${encodeURIComponent(t!)}`, { headers: { "user-agent": BROWSER } }), d);
  if (first.status !== 303) return { html: await first.text(), cookie: "" };
  const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
  return { html: await keep(await handleConnect(new Request(BASE, { headers: { "user-agent": BROWSER, cookie } }), d)).text(), cookie };
}
const openPage = async (d: ConnectDeps) => (await session(d)).html;
const text = (h: string) => h.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
Deno.test({ name: `R10 acceptance ${FILE}`, sanitizeResources: false, sanitizeOps: false, async fn(t) {
  try {
    await check(t, FILE, 11, "before connecting: the provider, the task's purpose and the actual permissions in plain words", async (ev: any) => {
      const h = await openPage(deps({}));
      ev.reply = text(h).slice(0, 600);
      const r = await shot(h, "f11-not-connected"); ev.screenshots.push(r.screenshot);
      ok(/Gmail|Google/.test(ev.reply), "names the account provider");
      ok(ev.reply.includes(REASONS.replies) || /so I can/i.test(ev.reply), `states the task-specific purpose: ${ev.reply.slice(0, 200)}`);
      ok(/reads? (the )?(sender|subject|email|messages|inbox|preview)/i.test(ev.reply), "says in words what the permission lets Trainee do (read mail)");
      ok(/Gmail|Google/.test(ev.reply) && /(account|address|which email)/i.test(ev.reply), "says which account will be connected (or asks for it) before consent");
      ok(/(won't|will not|never|doesn't|does not) (send|delete)|can't send/i.test(ev.reply), "says what it does not let Trainee do");
      ok(r.scrollWidth <= r.innerWidth, "no sideways scroll");
    });
    await check(t, FILE, 11, "connected: which address, and a Disconnect control", async (ev: any) => {
      // Architect amendment (item 14, ruling 2026-11-10): a page opened from a link, which may have been forwarded, names the
      // account masked and sends Disconnect to the chat; the person identified by Telegram sees the address and a Disconnect.
      const d = deps({ google: { state: "connected", email: "jordan.rivera@example.test" } });
      const linked = await openPage(d);
      ok(/Connected as j\*\*\*@e\*\*\*\.test/.test(text(linked)) && !linked.includes("jordan.rivera@example.test"), "a link's page names the account masked");
      ok(/Reply DISCONNECT GMAIL in your chat with Trainee to disconnect\./.test(text(linked)) && !/name="action" value="disconnect"/i.test(linked), "a link's page disconnects through the chat");
      const h = await keep(await handleConnect(new Request(BASE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": BROWSER }, body: new URLSearchParams({ init: await signedInit("7011", Date.now() / 1000 - 30, BOT_TOKEN), w: "replies" }).toString() }), d)).text();
      ev.reply = text(h).slice(0, 600);
      const r = await shot(h, "f11-connected"); ev.screenshots.push(r.screenshot);
      ok(/jordan\.rivera@example\.test/.test(ev.reply) && /connected/i.test(ev.reply), "names the connected account (identified by Telegram)");
      ok(/<button[^>]*>[^<]*Disconnect/i.test(h) || /name="action" value="disconnect"/i.test(h), "a Disconnect control");
    });
    await check(t, FILE, 11, "needs reconnecting: says so and shows the way back; never 'Connected'", async (ev: any) => {
      const h = await openPage(deps({ google: { state: "needs_reconnect", email: "jordan.rivera@example.test" } }));
      ev.reply = text(h).slice(0, 600);
      const r = await shot(h, "f11-needs-reconnect"); ev.screenshots.push(r.screenshot);
      ok(/reconnect|connect again|expired|access (was )?(removed|revoked)/i.test(ev.reply), "names the problem");
      ok(!/\bConnected\b(?! as)/.test(ev.reply.replace(/not connected|isn't connected|disconnected/gi, "")) || /reconnect/i.test(ev.reply), "not shown as connected");
    });
    await check(t, FILE, 11, "a consent that was started but not completed is shown as not finished, with a retry, never as connected", async (ev: any) => {
      const d = deps({});
      const s0 = await session(d);
      const tok = /name="t" value="([^"]+)"/.exec(s0.html)?.[1] ?? "";
      ok(tok, "the page carries its page token");
      const started = await handleConnect(new Request(BASE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": BROWSER, cookie: s0.cookie, origin: new URL(BASE).origin }, body: new URLSearchParams({ t: tok, action: "start", provider: "google" }).toString() }), d);
      ok([302, 303].includes(started.status), `Connect goes to the provider's consent (HTTP ${started.status})`);
      // The person comes back without finishing consent: the account is still not connected. Architect amendment (2026-11-10):
      // the browser sends back the cookie the Start answer set (tc_p), as a browser does (r10-connect-states.test.ts).
      const pending = (started.headers.get("set-cookie") ?? "").split(";")[0];
      ok(/^tc_p=google$/.test(pending), `Start remembers the consent it started (${pending})`);
      const back = await keep(await handleConnect(new Request(BASE, { headers: { "user-agent": BROWSER, cookie: `${s0.cookie}; ${pending}` } }), d)).text();
      ev.reply = text(back).slice(0, 500);
      const r = await shot(back, "f11-incomplete"); ev.screenshots.push(r.screenshot);
      ok(!/\bis connected\b|\bconnected as\b|all set/i.test(text(back)), "not shown as connected");
      ok(/didn't (finish|complete)|not (finished|completed)|wasn't completed|not connected yet|was cancell?ed/i.test(text(back)), `says the connection did not finish: ${text(back).slice(0, 200)}`);
      // Architect amendment (coordinator 2026-11-10): the retry is "Resume connecting Gmail" (pinned in r10-connect-states.test.ts).
      ok(/try again|connect (again|gmail)|reconnect|resume connecting/i.test(text(back)), "offers the retry");
    });
  } finally { await R.closeBrowser(); }
} });
