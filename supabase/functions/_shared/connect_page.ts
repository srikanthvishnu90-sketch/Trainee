// The account-connect page (owner, 2026-10-28), on the jobs page's shell and tokens (file_page.ts): warm off-white, plum only for
// the one main action, Inter + Brygada 1918, the T mark, dark mode. One page, one thing to do. Pure functions: a model in, HTML out.
//
// Rules that do not move: the scopes in the two plain lines are derived from the scopes the consent URL really asks for (the
// caller passes them from the code that builds it); an unconfigured provider has no button; "Connected as" is written only for
// a connection that exists; an address is untrusted text and always escaped; no secret, client id or token is ever rendered.
import { BRAND, esc, layout, TG_READY, type Og } from "./file_page.ts";
import { DARK_T, LIGHT_T, SERIF, type DesignTokens } from "./results_design.ts";
import { reasonKey, REASONS } from "./connect_link.ts";

export type ProviderId = "google" | "microsoft";
export type PState = "not_connected" | "connected" | "needs_reconnect";
export interface ProviderView { id: ProviderId; configured: boolean; state: PState; email: string | null; scopes: string[] }
export interface ConnectModel { token: string; reason: string; providers: ProviderView[]; botUrl: string | null }
export const NAMES: Record<ProviderId, { brand: string; mail: string }> = { google: { brand: "Google", mail: "Gmail" }, microsoft: { brand: "Microsoft", mail: "Outlook" } };

// ---------------------------------------------------------------- what the scopes mean, in plain words
const last = (s: string) => s.replace(/^https:\/\/(?:www\.googleapis\.com\/auth|graph\.microsoft\.com)\//i, "").toLowerCase();
export interface Caps { read: boolean; send: boolean; calendar: boolean }
export function capsOf(scopes: string[]): Caps {
  const s = scopes.map(last);
  return { read: s.some((x) => x === "gmail.readonly" || x === "mail.read" || x === "mail.readwrite"), send: s.some((x) => x === "gmail.send" || x === "mail.send"),
    calendar: s.some((x) => x.startsWith("calendar") || x.startsWith("calendars.")) };
}
// Two plain lines: what Trainee reads, and what it never does. Both follow the scopes asked.
export function scopeLines(scopes: string[]): [string, string] {
  const c = capsOf(scopes);
  const reads = [c.read && "the sender, subject and a short preview of new email, and the security codes employers email you", c.calendar && "the busy times on your calendar"].filter(Boolean) as string[];
  const one = reads.length ? `Trainee reads ${reads.join(", and ")}.` : "Trainee only reads your email address, to show which account is connected.";
  const acts = [c.send && "an email", c.calendar && "a calendar event"].filter(Boolean) as string[];
  const two = acts.length ? `It never sends ${acts.join(" or adds ")} without your approval of the exact ${c.send ? "message" : "event"}, and never deletes anything.` : "It can't send or delete anything, and before it ever sends one, you approve the exact message.";
  return [one, two];
}
// What the other provider can do that the primary one cannot, stated under its own button.
function extraReach(scopes: string[], than: string[]): string | null {
  const a = capsOf(scopes), b = capsOf(than);
  const more = [a.send && !b.send && "send emails you approve word for word", a.calendar && !b.calendar && "read your calendar's busy times and add invites you approve"].filter(Boolean) as string[];
  return more.length ? `${NAMES.microsoft.mail} access also lets Trainee ${more.join(" and ")}.` : null;
}

// ---------------------------------------------------------------- html
// The look of the hosted results page (results_design.ts, owner design spec 2026-11-02): paper ground, Source Serif 4 headings over
// Inter, a plum file header, a SOLID BLACK primary button, 16px body, nothing a person decides on under 14px, 44px+ hit areas, a dark
// scheme that is checked pair by pair (tests/architect/connect-page-design.test.ts). Colour never carries a state alone: every state
// is a word ("Connected", "Needs reconnecting") the chat uses too.
const vars = (t: DesignTokens) => `--paper:${t.paper};--card:${t.card};--ink:${t.ink};--ink-2:${t.ink2};--hair:${t.hair};--plum-950:${t.p950};--plum-800:${t.p800};--plum-700:${t.p700};--plum-600:${t.p600};--plum-50:${t.p50};--plum-text:${t.ptext};`
  + `--st-confirmed:${t.confirmed};--st-attention:${t.attention};--st-risk:${t.risk};--st-confirmed-bg:${t.confirmedBg};--st-attention-bg:${t.attentionBg};`
  // The shared shell's own names (file_page.ts), pointed at the same palette.
  + `--bg:${t.paper};--panel:${t.p50};--mute:${t.ink2};--line:${t.hair};--link:${t.ptext};--accent:${t.p700};--bad:${t.risk};--warn:${t.attention};--good:${t.confirmed}`;
export const CONNECT_CSS = `
:root{${vars(LIGHT_T)}}
@media (prefers-color-scheme:dark){:root{${vars(DARK_T)}}}
.wrap:has(>.connect){padding-left:calc(14px + env(safe-area-inset-left));padding-right:calc(14px + env(safe-area-inset-right))}
.connect{font-size:16px;line-height:1.5;overflow-wrap:anywhere}
.connect h1{font-family:${SERIF};font-weight:600;letter-spacing:0}
.filehead{margin:0 0 14px;padding:16px;border-radius:16px;background:linear-gradient(135deg,var(--plum-950),var(--plum-800));color:#fff}
.filehead .brand{margin-bottom:12px}.filehead .wm{color:#fff}
.filehead h1{margin:0;font-size:24px;line-height:1.2;color:#fff}
.filehead .lede{margin:8px 0 0;font-size:16px;color:#F1E8F5}
.line{margin:0 0 12px;font-size:16px}
.actions{margin-top:20px;display:flex;flex-direction:column;gap:10px}.actions form{margin:0}
.primary,.secondary,.notnow,.back,.lnk{font:inherit;cursor:pointer}
.primary,.secondary{display:flex;width:100%;align-items:center;justify-content:center;text-align:center;text-decoration:none;border-radius:11px}
.primary{min-height:48px;padding:6px 22px;font-size:17px;font-weight:600;background:#000;border:2px solid #000;color:#fff}
.primary:hover{opacity:.88}
@media (prefers-color-scheme:dark){.primary{border-color:var(--ink)}}
.secondary{min-height:48px;padding:6px 18px;font-size:16px;font-weight:600;background:transparent;border:1px solid var(--plum-700);color:var(--plum-text)}
@media (prefers-color-scheme:dark){.secondary{border-color:var(--plum-text)}}
.notnow,.back{display:flex;align-items:center;justify-content:center;min-height:44px;font-size:16px;text-decoration:underline}
.notnow{color:var(--ink-2)}.back{color:var(--plum-text)}
.fine{margin:0 4px;font-size:14px;color:var(--ink-2)}
.acct{margin:0 0 10px;padding:12px;border-radius:14px;border:1px solid var(--hair);background:var(--card)}.acct p{margin:0}
.acct .who{font-size:16px;font-weight:600;color:var(--ink)}.acct .muted{margin-top:6px;font-size:14px;color:var(--ink-2)}
.chip{display:inline-flex;align-items:center;margin:0 0 8px;padding:3px 10px;border-radius:999px;font-size:14px;line-height:1.4;font-weight:600;border:1px solid currentColor}
.chip::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;margin-right:6px;flex:none}
.chip.t-confirmed{background:var(--st-confirmed-bg);color:var(--st-confirmed)}.chip.t-attention{background:var(--st-attention-bg);color:var(--st-attention)}
.alert{margin:0 0 12px;padding:12px;border-radius:14px;border:1px solid var(--hair);border-left:4px solid var(--st-attention);background:var(--card);color:var(--ink)}.alert .chip{display:flex;width:fit-content}
.lnk{display:inline-flex;align-items:center;min-height:44px;padding:0 4px;border:0;background:none;text-decoration:underline;font-size:16px}
.lnk.danger{color:var(--st-risk);margin-top:2px}
.ok{font-weight:600;color:var(--st-confirmed)}
.connect a:focus-visible,.connect button:focus-visible{outline:3px solid var(--plum-600);outline-offset:2px}
.filehead a:focus-visible{outline-color:#fff}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;
// Source Serif 4 from the host the page's CSP already allows for Inter; the SERIF stack keeps the page right with no network.
const SERIF_LINK = `<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@600&display=swap" rel="stylesheet">`;

export const CONNECT_SCRIPT = `(function(){${TG_READY}var w=window.Telegram&&window.Telegram.WebApp;var inTg=!!(w&&w.initData);function open(u){if(inTg&&w.openLink){w.openLink(u)}else{location.href=u}}document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a.notnow,a.tgback");if(a&&inTg&&w.close){e.preventDefault();w.close()}});document.addEventListener("submit",function(e){var f=e.target;if(!f.classList||!f.classList.contains("go")||!window.fetch)return;e.preventDefault();var b=f.querySelector("button");if(b)b.disabled=true;fetch(f.action||location.href,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",accept:"application/json"},body:new URLSearchParams(new FormData(f)).toString(),credentials:"same-origin"}).then(function(r){return r.ok?r.json():null}).then(function(j){if(j&&j.url){open(j.url);if(b)b.disabled=false}else{f.submit()}}).catch(function(){f.submit()})})})();`;
export const CONNECT_BOOT = `(function(){${TG_READY}var p=new URLSearchParams(location.hash.slice(1)),d=p.get("tgWebAppData");if(!d){document.getElementById("nodata").hidden=false;return}var f=document.createElement("form");f.method="post";function a(n,v){var i=document.createElement("input");i.type="hidden";i.name=n;i.value=v;f.appendChild(i)}a("init",d);a("w",document.body.getAttribute("data-w"));document.body.appendChild(f);f.submit()})();`;

const hidden = (token: string, action: string, provider: string) => `<input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="provider" value="${provider}">`;
const back = (botUrl: string | null, cls = "primary") => (botUrl ? `<a class="${cls}${cls === "primary" ? "" : " tgback"}" href="${esc(botUrl)}" rel="noopener noreferrer">Back to Telegram</a>` : "");
const page = (title: string, inner: string, o: { og?: Og; script?: string; tg?: boolean; lede?: string; bodyAttrs?: string } = {}) =>
  layout(`${title} - Trainee`, `<div id="root" class="connect"><header class="filehead">${BRAND}<h1>${esc(title)}</h1>${o.lede ? `<p class="lede">${esc(o.lede)}</p>` : ""}</header><main id="main">${inner}</main></div>`, { script: o.script, tg: o.tg, og: o.og, bodyAttrs: o.bodyAttrs, css: CONNECT_CSS, head: SERIF_LINK });

export function renderConnect(m: ConnectModel): string {
  const reason = REASONS[reasonKey(m.reason)];
  const shown = m.providers.filter((p) => p.state !== "not_connected" || p.configured);
  const connected = m.providers.filter((p) => p.state === "connected");
  const revoked = m.providers.filter((p) => p.state === "needs_reconnect" && p.configured);
  const open = m.providers.filter((p) => p.configured && p.state === "not_connected");
  const who = (p: ProviderView) => `${NAMES[p.id].mail}${p.email ? ` (${p.email})` : ""}`;
  if (!shown.length) {
    return page("Not available yet", `<p class="line">Connecting your email isn't switched on yet, so nothing can be connected. Nothing was read or sent.</p><div class="actions">${back(m.botUrl, "back")}</div>`, { script: CONNECT_SCRIPT, tg: true });
  }
  const disc = (p: ProviderView) => `<form method="post" class="disc">${hidden(m.token, "disconnect", p.id)}<button type="submit" class="lnk danger" aria-label="Disconnect ${NAMES[p.id].mail}">Disconnect</button></form>`;
  const acct = (p: ProviderView) => `<section class="acct"><span class="chip t-confirmed">Connected</span><p class="who">Connected as ${esc(p.email ?? NAMES[p.id].mail)}</p><p class="muted">${NAMES[p.id].mail}. Disconnecting removes Trainee's access and what it read from it.</p>${disc(p)}</section>`;
  if (revoked.length) {
    const p = revoked[0], n = NAMES[p.id];
    const alert = `<p class="alert" role="status"><span class="chip t-attention">Needs reconnecting</span>${n.brand} access${p.email ? ` to ${esc(p.email)}` : ""} stopped working. Trainee can't read anything from it until you reconnect.</p>`;
    const act = `<form method="post" class="go">${hidden(m.token, "start", p.id)}<button type="submit" class="primary">Reconnect ${n.brand}</button></form>`;
    return page("Reconnect your email", `${alert}<div class="actions">${act}${back(m.botUrl, "notnow")}</div>${connected.map(acct).join("")}`, { script: CONNECT_SCRIPT, tg: true });
  }
  if (connected.length) {
    return page("Your email is connected", `${connected.map(acct).join("")}<div class="actions">${back(m.botUrl)}</div>`, { script: CONNECT_SCRIPT, tg: true });
  }
  const [one, two] = scopeLines(open[0].scopes);
  const buttons = open.map((p, i) => {
    const n = NAMES[p.id];
    const extra = i > 0 ? extraReach(p.scopes, open[0].scopes) : null;
    return `<form method="post" class="go">${hidden(m.token, "start", p.id)}<button type="submit" class="${i === 0 ? "primary" : "secondary"}">Continue with ${n.brand}</button></form>${extra ? `<p class="fine">${esc(extra)}</p>` : ""}`;
  }).join("");
  const notnow = m.botUrl ? `<a class="notnow" href="${esc(m.botUrl)}" rel="noopener noreferrer">Not now</a>` : "";
  return page("Connect your email", `<p class="line">${esc(one)}</p><p class="line">${esc(two)}</p><div class="actions">${buttons}${notnow}</div>`, { script: CONNECT_SCRIPT, tg: true, og: previewOg(m.reason), lede: `So I can ${reason}.` });
}

// After consent (the OAuth callback's landing), or after a disconnect: one calm state and the way back.
export interface DoneModel { outcome: "connected" | "denied" | "failed" | "disconnected"; provider: ProviderId; email: string | null; botUrl: string | null; message?: string }
export function renderDone(m: DoneModel): string {
  const n = NAMES[m.provider];
  const b = m.botUrl ? `<div class="actions">${back(m.botUrl)}</div>` : `<p class="fine">You can close this tab and go back to your chat with Trainee.</p>`;
  if (m.outcome === "connected") return page(`${n.mail} connected`, `<p class="line ok">Connected as ${esc(m.email ?? n.mail)}.</p><p class="line">Trainee will tell you in the chat when it has something. Say "disconnect ${n.mail.toLowerCase()}" in the chat any time to remove it.</p>${b}`, { script: CONNECT_SCRIPT, tg: true });
  if (m.outcome === "denied") return page("Nothing was connected", `<p class="line">You chose not to allow access, so nothing was connected. You can try again whenever you like.</p>${b}`, { script: CONNECT_SCRIPT, tg: true });
  if (m.outcome === "disconnected") return page(`${n.mail} disconnected`, `<p class="line">${esc(m.message ?? "Trainee's access is removed.")}</p>${b}`, { script: CONNECT_SCRIPT, tg: true });
  return page("That didn't work", `<p class="line">Something went wrong on the way back from ${n.brand}, so nothing was saved. Ask Trainee for a new link in the chat.</p>${b}`, { script: CONNECT_SCRIPT, tg: true });
}

// A link that cannot be used or a step that cannot be done: says why, shows nothing about any account.
export function renderState(title: string, paras: string[], botUrl: string | null): string {
  return page(title, `${paras.map((p) => `<p class="line">${esc(p)}</p>`).join("")}${botUrl ? `<div class="actions">${back(botUrl)}</div>` : ""}`, { script: CONNECT_SCRIPT, tg: true });
}

export function renderBootstrap(reason: string): string {
  return page("Connect your email", `<p class="line">Signing you in with Telegram.</p><p class="line" id="nodata" hidden>Open this page from the button in Telegram, or use the link Trainee sent you.</p><noscript><p class="line">This needs JavaScript. Use the link Trainee sent you instead.</p></noscript>`, { script: CONNECT_BOOT, tg: true, bodyAttrs: `data-w="${esc(reasonKey(reason))}"` });
}

// The preview card a chat shows under the link: the brand and the reason; nothing about any person.
export const previewOg = (reason: string, image: string | null = null): Og => ({ title: "Connect your email to Trainee", description: `So I can ${REASONS[reasonKey(reason)]}. One tap; nothing is sent without your approval.`, image });
export function renderPreview(og: Og): string {
  return page("Connect your email", `<p class="line">${esc(og.description)}</p><p class="line">Open this link in your browser, or from Telegram.</p>`, { og });
}
