// R10 WO-F, owner readiness review of #640: the connect page's permission words come from ONE source, the scopes each provider's
// consent asks for this purpose (trainee-connect/store.ts consentScopes), and never contradict each other.
//   1. For every provider and every purpose, the scopes the consent URL really asks for (start(), parsed from the URL) equal the
//      scopes the page shows (providers(purpose)). Also for a "send" link with a Gmail already connected (D-037), and with an
//      owner-approved gmail.send (GOOGLE_APPROVED_EXTRA_SCOPES, the D-048 outreach path): then the row says Send email "Only a
//      message you approve word for word", and the receipts-only connect says "No".
//   2. The intro never says "can't send" while any row shown allows sending.
//   3. Each variant at 390x844 in Chromium (R10_SNAPSHOTS=1 writes tests/architect/snapshots/r10-entry/connect-consent-<variant>-390x844.png).
// Memory fakes for the database; no Google, no Microsoft, no network.
import assertNode from "node:assert/strict";
import { createRequire } from "node:module";
import { REASONS } from "../../supabase/functions/_shared/connect_link.ts";
import { effectRows, renderConnect, type ProviderView } from "../../supabase/functions/_shared/connect_page.ts";
import { GMAIL_SEND } from "../../supabase/functions/_shared/google_scopes.ts";
import { consentScopes, supabaseConnectDeps } from "../../supabase/functions/trainee-connect/store.ts";
import type { ProviderId } from "../../supabase/functions/trainee-connect/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const U = "11111111-1111-4111-8111-1111111110cc", NOW = Date.parse("2026-11-09T15:00:00Z");
const BASE_ENV: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: "test-google-client", OAUTH_STATE_SECRET: "test-state-secret-0123456789abcdef", SUPABASE_URL: "https://project.supabase.test",
  MICROSOFT_OAUTH_CLIENT_ID: "test-ms-client", MICROSOFT_OAUTH_CLIENT_SECRET: "test-ms-secret" };
const envOf = (extra: Record<string, string> = {}) => ({ get: (k: string) => ({ ...BASE_ENV, ...extra } as Record<string, string>)[k] });
// The database calls start() makes, answered in memory: a link issued and opened; the Gmail connection read for a "send" link.
function admin(connectedEmail: string | null) {
  const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: connectedEmail ? { email: connectedEmail } : null, error: null }) };
  return { rpc: async (name: string) => ({ data: /issue$/.test(name) ? "nonce-1" : { link_id: "link-1" }, error: null }), from: () => chain };
}
const requested = (url: string | null) => { assert(url, "a consent URL"); return new URL(url!).searchParams.get("scope")!.split(" "); };
const sorted = (x: string[]) => [...x].sort();
const PROVIDERS: ProviderId[] = ["google", "microsoft"];
const plain = (h: string) => h.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

Deno.test("R10 owner review: for every provider and purpose, the scopes the consent URL asks for equal the scopes the page shows", async () => {
  for (const extra of [{}, { GOOGLE_APPROVED_EXTRA_SCOPES: GMAIL_SEND }]) {
    const env = envOf(extra);
    const d = supabaseConnectDeps(admin(null), env, fetch, () => NOW);
    for (const purpose of Object.keys(REASONS)) for (const p of PROVIDERS) {
      const shown = d.providers(purpose)[p].scopes;
      eq(sorted(requested(await d.start(p, U, "telegram", purpose))), sorted(shown), `${p} / ${purpose}${extra.GOOGLE_APPROVED_EXTRA_SCOPES ? " / gmail.send approved" : ""}: asked = shown`);
      eq(shown, consentScopes(p, purpose, false, env), "the page reads the one table");
    }
  }
  // D-037: a "send" link with a Gmail already connected asks only for gmail.send on that account; the table says the same
  const env = envOf();
  const d = supabaseConnectDeps(admin("ada.fictional@example.test"), env, fetch, () => NOW);
  const url = await d.start("google", U, "telegram", "send");
  eq(sorted(requested(url)), sorted(consentScopes("google", "send", true, env)));
  assert(requested(url).includes(GMAIL_SEND) && new URL(url!).searchParams.get("include_granted_scopes") === "true");
});

Deno.test("R10 owner review: the send row follows the scopes (receipts-only says No; an approved gmail.send says approved-only), and the intro never says 'can't send' when a row allows sending", () => {
  const view = (p: ProviderId, scopes: string[]): ProviderView => ({ id: p, configured: true, state: "not_connected", email: null, scopes });
  const plainG = consentScopes("google", "replies", false, envOf()), sendG = consentScopes("google", "replies", false, envOf({ GOOGLE_APPROVED_EXTRA_SCOPES: GMAIL_SEND }));
  const ms = consentScopes("microsoft", "replies", false, envOf());
  eq(effectRows(plainG).find((r) => r.effect === "Send email")!.answer, "No", "receipts-only Gmail: Send email No");
  eq(effectRows(sendG).find((r) => r.effect === "Send email")!.answer, "Only a message you approve word for word", "Gmail with send: approved-only");
  const variants: [string, ProviderView[]][] = [["gmail-only", [view("google", plainG)]], ["gmail-and-outlook", [view("google", plainG), view("microsoft", ms)]],
    ["gmail-send", [view("google", sendG)]], ["outlook-only", [view("microsoft", ms)]]];
  for (const [name, providers] of variants) {
    const html = renderConnect({ token: "t", reason: "replies", providers, botUrl: "https://t.me/TraineeTestBot" });
    const intro = [...html.matchAll(/<p class="line">([^<]+)<\/p>/g)].map((m) => m[1].replace(/&#39;/g, "'")).join(" ");
    const sends = providers.some((p) => effectRows(p.scopes).find((r) => r.effect === "Send email")!.answer !== "No");
    if (sends) assert(!/can't send|cannot send/i.test(intro), `${name}: the intro says it can't send while a row allows sending: ${intro}`);
    else assert(/can't send/i.test(intro), `${name}: read-only, and the intro says so: ${intro}`);
    for (const p of providers) for (const s of p.scopes) assert(html.includes(`<code>${s}</code>`), `${name}: the exact scope ${s}`);
  }
});

function playwright(): any {
  const req = createRequire(import.meta.url);
  for (const p of [Deno.env.get("UPMORE_PLAYWRIGHT_PATH"), `${ROOT}/tools/node_modules/playwright`]) { if (!p) continue; try { return req(p); } catch { /* next */ } }
  return null;
}
Deno.test({ name: "R10 owner review: each consent variant at 390x844: the primary in the first screen, rows and intro agree, nothing sideways", sanitizeResources: false, sanitizeOps: false, async fn() {
  const pw = playwright();
  if (!pw) { if (CI) throw new Error("Playwright is missing in CI"); console.log("NOT_RUN locally: no Playwright"); return; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)"); return; }
  const write = Deno.env.get("R10_SNAPSHOTS") === "1", out = `${ROOT}/tests/architect/snapshots/r10-entry`;
  if (write) await Deno.mkdir(out, { recursive: true });
  const view = (p: ProviderId, scopes: string[]): ProviderView => ({ id: p, configured: true, state: "not_connected", email: null, scopes });
  const g = consentScopes("google", "confirm", false, envOf()), gs = consentScopes("google", "confirm", false, envOf({ GOOGLE_APPROVED_EXTRA_SCOPES: GMAIL_SEND })), m = consentScopes("microsoft", "confirm", false, envOf());
  const variants: [string, ProviderView[]][] = [["gmail-only", [view("google", g)]], ["gmail-and-outlook", [view("google", g), view("microsoft", m)]], ["gmail-send", [view("google", gs)]], ["outlook-only", [view("microsoft", m)]]];
  const browser = await pw.chromium.launch({ args: ["--no-proxy-server"] });
  const problems: string[] = [];
  try {
    for (const [name, providers] of variants) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
      await ctx.route("**/*", (r: any) => r.abort());
      const page = await ctx.newPage();
      await page.setContent(renderConnect({ token: "t", reason: "confirm", providers, botUrl: "https://t.me/TraineeTestBot" }), { waitUntil: "load" });
      const mm = await page.evaluate(() => ({ primary: (document.querySelector("button.primary") as HTMLElement).getBoundingClientRect().bottom, sideways: document.documentElement.scrollWidth > innerWidth + 1, text: document.body.innerText }));
      if (mm.primary > 844) problems.push(`${name}: the primary ends at ${mm.primary}`);
      if (mm.sideways) problems.push(`${name}: scrolls sideways`);
      const sends = providers.some((p) => effectRows(p.scopes).find((r) => r.effect === "Send email")!.answer !== "No");
      if (sends && /can't send/i.test(plain(mm.text))) problems.push(`${name}: "can't send" on screen while a row allows sending`);
      const png = await page.screenshot({ fullPage: true });
      if (write) await Deno.writeFile(`${out}/connect-consent-${name}-390x844.png`, png);
      await ctx.close();
    }
  } finally { await browser.close(); }
  assert(!problems.length, problems.join("\n"));
} });
