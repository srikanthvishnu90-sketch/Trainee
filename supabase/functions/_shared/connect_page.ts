// The account-connect page (owner, 2026-10-28), on the jobs page's shell and tokens (file_page.ts): warm off-white, plum only for
// the one main action, Inter + Brygada 1918, the T mark, dark mode. One page, one thing to do. Pure functions: a model in, HTML out.
//
// Rules that do not move: the scopes in the two plain lines are derived from the scopes the consent URL really asks for (the
// caller passes them from the code that builds it); an unconfigured provider has no button; "Connected as" is written only for
// a connection that exists; an address is untrusted text and always escaped; no secret, client id or token is ever rendered.
import { BRAND, esc, layout, TG_READY, type Og } from "./file_page.ts";
import { maskEmail, reasonKey, REASONS } from "./connect_link.ts";

export type ProviderId = "google" | "microsoft";
export type PState = "not_connected" | "connected" | "needs_reconnect";
// canSend: a connected account already granted sending (from the grant's own scopes); sendScopes: what an "Allow sending"
// consent asks for on top (store.ts consentScopes(google, "send", connected)), present only where that consent exists.
export interface ProviderView { id: ProviderId; configured: boolean; state: PState; email: string | null; scopes: string[]; canSend?: boolean; sendScopes?: string[] }
// masked: a page opened from a link (the link is the credential, so a forwarded one may be opened by anyone): addresses show only their
// first letters and there is no Disconnect here; the chat does it (spec ruling 2026-11-10). Absent: the person is identified (Telegram).
export interface ConnectModel { token: string; reason: string; providers: ProviderView[]; botUrl: string | null; masked?: boolean }
// The chat's own words for a disconnect (connector_words.ts disconnectOf answers "disconnect gmail" / "disconnect outlook").
export const DISCONNECT_IN_CHAT = (p: ProviderId) => `Reply DISCONNECT ${p === "google" ? "GMAIL" : "OUTLOOK"} in your chat with Trainee to disconnect.`;
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

// R10 fix 11 (spec C.23 panels 8-9): before the provider's page, the account, the task's purpose and the exact permissions, with
// reading, sending and deleting as separate effects (never one vague "connect"). Every row follows the scopes the consent URL asks.
export function effectRows(scopes: string[]): { effect: string; answer: string }[] {
  const c = capsOf(scopes);
  return [
    { effect: "Read email", answer: c.read ? "Yes: sender, subject and a short preview of new email, and the security codes employers email you" : "No" },
    { effect: "Send email", answer: c.send ? "Only a message you approve word for word" : "No" },
    { effect: "Delete email", answer: "No" },
    // Calendars.ReadWrite lets an app create, change and delete events: all three are said, each only on your approval.
    ...(c.calendar ? [{ effect: "Calendar", answer: "Reads busy times; creates, changes or deletes an event only after you approve it" }] : []),
  ];
}
// asked: the exact scopes this consent requests when they differ from what the rows describe (an "Allow sending" consent asks
// only for gmail.send on top of the existing grant; the rows describe the result).
export function permissionsHtml(p: { id: ProviderId; scopes: string[]; asked?: string[]; account?: string | null }): string {
  const n = NAMES[p.id];
  const rows = effectRows(p.scopes).map((r) => `<li><span class="k">${esc(r.effect)}</span><span class="v">${esc(r.answer)}</span></li>`).join("");
  const exact = (p.asked ?? p.scopes).map((x) => `<code>${esc(x)}</code>`).join(" ");
  return `<section class="acct perms" aria-label="${n.mail} permissions"><p class="who">${n.mail}</p><p class="muted">${p.account ? `Account: ${esc(p.account)}. ${n.brand}'s page asks for this same account; another one is refused.` : `Account: you choose it on ${n.brand}'s page; this page then shows it.`}</p><ul class="eff">${rows}</ul><p class="muted">Exact permissions requested: ${exact || "none"}</p></section>`;
}

// ---------------------------------------------------------------- html
// The page keeps Trainee's one visual identity (brand.ts tokens, checked in a real browser by design-pages-browser.test.ts): the
// shared ground and ink, plum ONLY on the one primary action and links, Inter + Brygada 1918, dark scheme. On top of that the
// results page's habits: 16px body, nothing under 14px, 44px+ tap targets, cards for accounts, and states in words ("Connected",
// "Needs reconnecting"), never colour alone. tests/architect/connect-page-design.test.ts computes every size and contrast pair.
export const CONNECT_CSS = `
.wrap:has(>.connect){padding-left:calc(16px + env(safe-area-inset-left));padding-right:calc(16px + env(safe-area-inset-right))}
.connect{font-size:16px;line-height:1.5;overflow-wrap:anywhere}
.connect .lede{margin:6px 0 0;font-size:16px;color:var(--mute)}
.line{margin:0 0 8px;font-size:16px}
.actions{margin-top:14px;display:flex;flex-direction:column;gap:10px}.actions form{margin:0}
.primary,.secondary,.notnow,.back,.lnk{font:inherit;cursor:pointer}
.primary,.secondary{display:flex;width:100%;align-items:center;justify-content:center;text-align:center;text-decoration:none;min-height:48px;padding:6px 22px;border-radius:999px;font-size:17px;font-weight:600}
.primary{background:var(--accent);border:1px solid var(--accent);color:var(--accent-ink)}.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.primary:disabled{background:var(--disabled-bg);border-color:var(--disabled-bg);color:var(--disabled-ink);cursor:default}
.secondary{background:transparent;border:1px solid var(--ink);color:var(--ink)}.secondary:hover{border-color:var(--mute)}
.secondary:disabled{color:var(--mute);cursor:default}
.notnow,.back{display:flex;align-items:center;justify-content:center;min-height:44px;font-size:16px;text-decoration:underline}
.notnow{color:var(--mute)}.back{color:var(--link)}
.fine{margin:0 4px;font-size:14px;color:var(--mute)}
.acct{margin:0 0 10px;padding:12px 14px;border-radius:14px;border:1px solid var(--line);background:var(--panel)}.acct p{margin:0}
.acct .who{font-size:16px;font-weight:600;color:var(--ink)}.acct .muted{margin-top:6px;font-size:14px;color:var(--mute)}
.chip{display:inline-flex;align-items:center;margin:0 0 8px;padding:3px 10px;border-radius:999px;font-size:14px;line-height:1.4;font-weight:600;border:1px solid currentColor;background:var(--bg)}
.chip::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;margin-right:6px;flex:none}
.chip.t-confirmed{color:var(--good)}.chip.t-attention{color:var(--warn)}
.alert{margin:0 0 12px;padding:12px 14px;border-radius:14px;border:1px solid var(--line);border-left:4px solid var(--warn);background:var(--panel);color:var(--ink)}.alert .chip{display:flex;width:fit-content}
.lnk{display:inline-flex;align-items:center;min-height:44px;padding:0 4px;border:0;background:none;text-decoration:underline;font-size:16px}
.lnk.danger{color:var(--bad);margin-top:2px}
.ok{font-weight:600;color:var(--good)}
.eff{list-style:none;margin:10px 0 0;padding:0}.eff li{display:flex;flex-wrap:wrap;justify-content:space-between;gap:2px 12px;padding:6px 0;border-top:1px solid var(--line);font-size:16px}.eff .k{font-weight:600;flex:0 0 auto}.eff .v{flex:1 1 0;min-width:55%;text-align:right;color:var(--ink)}
.perms{padding:8px 14px}.perms .eff{margin-top:4px}.perms .muted{margin-top:4px}.perms code{font-size:14px;overflow-wrap:anywhere}.recovery{margin:0 0 12px;font-weight:600}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

export const CONNECT_SCRIPT = `(function(){${TG_READY}var w=window.Telegram&&window.Telegram.WebApp;var inTg=!!(w&&w.initData);function open(u){if(inTg&&w.openLink){w.openLink(u)}else{location.href=u}}document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a.notnow,a.tgback");if(a&&inTg&&w.close){e.preventDefault();w.close()}});document.addEventListener("submit",function(e){var f=e.target;if(inTg&&f.querySelector&&!f.querySelector('input[name="init"]')){var i=document.createElement("input");i.type="hidden";i.name="init";i.value=w.initData;f.appendChild(i)}if(!f.classList||!f.classList.contains("go")||!window.fetch)return;e.preventDefault();var b=f.querySelector("button");if(b)b.disabled=true;fetch(f.action||location.href,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",accept:"application/json"},body:new URLSearchParams(new FormData(f)).toString(),credentials:"same-origin"}).then(function(r){return r.ok?r.json():null}).then(function(j){if(j&&j.url){open(j.url);if(b)b.disabled=false}else{f.submit()}}).catch(function(){f.submit()})})})();`;
export const CONNECT_BOOT = `(function(){${TG_READY}var p=new URLSearchParams(location.hash.slice(1)),d=p.get("tgWebAppData");if(!d){document.getElementById("nodata").hidden=false;return}var f=document.createElement("form");f.method="post";function a(n,v){var i=document.createElement("input");i.type="hidden";i.name=n;i.value=v;f.appendChild(i)}a("init",d);a("w",document.body.getAttribute("data-w"));document.body.appendChild(f);f.submit()})();`;

const hidden = (token: string, action: string, provider: string) => `<input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="provider" value="${provider}">`;
const back = (botUrl: string | null, cls = "primary") => (botUrl ? `<a class="${cls}${cls === "primary" ? "" : " tgback"}" href="${esc(botUrl)}" rel="noopener noreferrer">Back to Telegram</a>` : "");
const page = (title: string, inner: string, o: { og?: Og; script?: string; tg?: boolean; lede?: string; bodyAttrs?: string } = {}) =>
  layout(`${title} - Trainee`, `<div id="root" class="connect"><header>${BRAND}<h1>${esc(title)}</h1>${o.lede ? `<p class="lede">${esc(o.lede)}</p>` : ""}</header><main id="main">${inner}</main></div>`, { script: o.script, tg: o.tg, og: o.og, bodyAttrs: o.bodyAttrs, css: CONNECT_CSS });

export function renderConnect(m0: ConnectModel): string {
  const m = m0.masked ? { ...m0, providers: m0.providers.map((p) => ({ ...p, email: maskEmail(p.email) })) } : m0;
  const reason = REASONS[reasonKey(m.reason)];
  const shown = m.providers.filter((p) => p.state !== "not_connected" || p.configured);
  const connected = m.providers.filter((p) => p.state === "connected");
  const revoked = m.providers.filter((p) => p.state === "needs_reconnect" && p.configured);
  const open = m.providers.filter((p) => p.configured && p.state === "not_connected");
  const who = (p: ProviderView) => `${NAMES[p.id].mail}${p.email ? ` (${p.email})` : ""}`;
  if (!shown.length) {
    return page("Not available yet", `<p class="line">Connecting your email isn't switched on yet, so nothing can be connected. Nothing was read or sent.</p><div class="actions">${back(m.botUrl, "back")}</div>`, { script: CONNECT_SCRIPT, tg: true });
  }
  const disc = (p: ProviderView) => m.masked ? `<p class="fine">${esc(DISCONNECT_IN_CHAT(p.id))}</p>` : `<form method="post" class="disc">${hidden(m.token, "disconnect", p.id)}<button type="submit" class="lnk danger" aria-label="Disconnect ${NAMES[p.id].mail}">Disconnect</button></form>`;
  const acct = (p: ProviderView) => `<section class="acct"><span class="chip t-confirmed">Connected</span><p class="who">Connected as ${esc(p.email ?? NAMES[p.id].mail)}</p><p class="muted">${NAMES[p.id].mail}. Disconnecting removes Trainee's access and what it read from it.</p>${disc(p)}</section>`;
  if (revoked.length) {
    const p = revoked[0], n = NAMES[p.id];
    const alert = `<p class="alert" role="status"><span class="chip t-attention">Needs reconnecting</span>${n.brand} access${p.email ? ` to ${esc(p.email)}` : ""} stopped working. Trainee can't read anything from it until you reconnect.</p>`;
    const act = `<form method="post" class="go">${hidden(m.token, "start", p.id)}<button type="submit" class="primary">Reconnect ${n.brand}</button></form>`;
    return page("Reconnect your email", `${alert}<div class="actions">${act}${back(m.botUrl, "notnow")}</div>${connected.map(acct).join("")}`, { script: CONNECT_SCRIPT, tg: true });
  }
  // D-037 / D-048: a link made to allow sending, for a Gmail that is connected and cannot send yet: the one step that adds
  // sending (gmail.send on that same account), with its exact permissions, instead of a page with nothing to do.
  const sendable = m.reason === "send" ? connected.find((p) => p.configured && !p.canSend && p.sendScopes?.length) : undefined;
  if (sendable) {
    const n = NAMES[sendable.id];
    const go = `<form method="post" class="go">${hidden(m.token, "start", sendable.id)}<button type="submit" class="primary">Allow sending</button></form>`;
    const notnow = m.botUrl ? `<a class="notnow" href="${esc(m.botUrl)}" rel="noopener noreferrer">Not now</a>` : "";
    return page("Allow sending from your email", `<p class="line">${n.mail} is connected as ${esc(sendable.email ?? n.mail)}. To send the emails you approve, ${n.brand} asks you to allow sending on that same account.</p>${permissionsHtml({ id: sendable.id, scopes: [...new Set([...sendable.scopes, ...sendable.sendScopes!])], asked: sendable.sendScopes, account: sendable.email })}<p class="fine">Asked on top of what you already allowed; reading stays as it is.</p><div class="actions">${go}${notnow}</div>`,
      { script: CONNECT_SCRIPT, tg: true, lede: "So I can send the emails you approve, word for word, and nothing else." });
  }
  if (connected.length) {
    return page("Your email is connected", `${connected.map(acct).join("")}<div class="actions">${back(m.botUrl)}</div>`, { script: CONNECT_SCRIPT, tg: true });
  }
  // The intro speaks for every provider offered (the union of their scopes), so it can never contradict a provider's own rows
  // (owner readiness review: "It can't send" above an Outlook row that allows sending).
  const [one, two] = scopeLines(open.flatMap((p) => p.scopes));
  const buttons = open.map((p, i) => {
    const n = NAMES[p.id];
    const extra = i > 0 ? extraReach(p.scopes, open[0].scopes) : null;
    // Each provider's permissions sit right above its own Continue button (owner review R11), so they are read before the step.
    return `${permissionsHtml(p)}<form method="post" class="go">${hidden(m.token, "start", p.id)}<button type="submit" class="${i === 0 ? "primary" : "secondary"}">Continue with ${n.brand}</button></form>${extra ? `<p class="fine">${esc(extra)}</p>` : ""}`;
  }).join("");
  const notnow = m.botUrl ? `<a class="notnow" href="${esc(m.botUrl)}" rel="noopener noreferrer">Not now</a>` : "";
  // The purpose line never promises what no row allows: a "send" link for an inbox that is not connected yet connects it first
  // (reading only); sending is the separate step after (the "Allow sending" state above).
  const sends = open.some((p) => capsOf(p.scopes).send);
  const lede = reasonKey(m.reason) === "send" && !sends ? `So I can ${REASONS.replies}. Sending is a separate step you allow after this, on the same account.` : `So I can ${reason}.`;
  return page("Connect your email", `<p class="line">${esc(one)}</p><p class="line">${esc(two)}</p><div class="actions">${buttons}${notnow}</div>`, { script: CONNECT_SCRIPT, tg: true, og: previewOg(m.reason), lede });
}

// After consent (the OAuth callback's landing), or after a disconnect: one calm state and the way back.
// R10 fix 11: "connected" only after the grant was stored (the callback's own result), with the address, what it is allowed to do
// and a working Disconnect (a form to the connect page carrying a fresh session for this person, when the callback can mint one).
// A cancelled consent, an incomplete or failed redirect and a different account each say "No access saved" and offer a retry;
// a different account is named and never used in place of the one asked for.
export type DoneWhy = "taken" | "other_account" | "incomplete";
export interface DoneModel {
  outcome: "connected" | "denied" | "failed" | "disconnected"; provider: ProviderId; email: string | null; botUrl: string | null; message?: string;
  why?: DoneWhy; scopes?: string[];
  manage?: { action: string; token: string } | null; // after a stored grant only: the connect page's address and a session for this person (Disconnect)
  connectUrl?: string | null; // the connect page: Retry opens it (it signs the person in itself)
}
const NOT_FINISHED = `<p class="alert" role="status"><span class="chip t-attention">Connection not finished</span>No access saved.</p>`;
export function renderDone(m: DoneModel): string {
  const n = NAMES[m.provider];
  const b = m.botUrl ? `<div class="actions">${back(m.botUrl, m.connectUrl && m.outcome !== "connected" && m.outcome !== "disconnected" ? "notnow" : "primary")}</div>` : `<p class="fine">You can close this tab and go back to your chat with Trainee.</p>`;
  const post = (action: string, cls: string, label: string) => m.manage ? `<form method="post" action="${esc(m.manage.action)}">${hidden(m.manage.token, action, m.provider)}<button type="submit" class="${cls}">${esc(label)}</button></form>` : "";
  const retry = m.connectUrl ? `<div class="actions"><a class="primary" href="${esc(m.connectUrl)}">Retry connection</a></div>` : "";
  if (m.outcome === "connected") {
    const allowed = m.scopes?.length ? effectRows(m.scopes).map((r) => `${r.effect}: ${r.answer}.`).join(" ") : "";
    const disc = m.manage ? post("disconnect", "lnk danger", "Disconnect") : `<p class="fine">To disconnect, say "disconnect ${n.mail.toLowerCase()}" in the chat.</p>`;
    return page(`${n.mail} connected`, `<p class="line ok">Connected as ${esc(m.email ?? n.mail)}.</p>${allowed ? `<p class="line">${esc(allowed)}</p>` : ""}<p class="line">Trainee will tell you in the chat when it has something. Say "disconnect ${n.mail.toLowerCase()}" in the chat any time to remove it.</p>${b}${disc}`, { script: CONNECT_SCRIPT, tg: true });
  }
  if (m.outcome === "disconnected") return page(`${n.mail} disconnected`, `<p class="line">${esc(m.message ?? "Trainee's access is removed.")}</p>${b}`, { script: CONNECT_SCRIPT, tg: true });
  if (m.why === "taken" || m.why === "other_account") {
    const who = m.email ? esc(m.email) : `a different ${n.brand} account`;
    const words = m.why === "taken" ? `You signed in to ${who}, which another Trainee account already uses, so nothing was connected.` : `You signed in to ${who}, not the account connected to Trainee, so nothing was changed.`;
    // Never substituted: the person chooses. Retry with the account asked for, or (only where it can be done) use this one instead:
    // disconnect the current account on the connect page, then connect this one. Nothing changes until they do.
    const instead = m.why === "other_account" && m.connectUrl && m.email
      ? `<div class="actions"><a class="secondary" href="${esc(m.connectUrl)}">Use ${esc(m.email)} instead</a></div><p class="fine">That disconnects the account connected now, then connects ${esc(m.email)}. Nothing changes until you do it.</p>` : "";
    return page("A different account was used", `${NOT_FINISHED}<p class="line">${words} Trainee never uses one account in place of another.</p><p class="line">Choose: retry with the account you want on ${n.brand}'s page${instead ? `, or use ${esc(m.email!)} instead` : ""}.</p>${retry}${instead}${b}`, { script: CONNECT_SCRIPT, tg: true });
  }
  if (m.outcome === "denied" && m.why !== "incomplete") return page("Nothing was connected", `${NOT_FINISHED}<p class="line">You chose not to allow access, so nothing was connected. You can try again whenever you like.</p>${retry}${b}`, { script: CONNECT_SCRIPT, tg: true });
  const why = m.why === "incomplete" ? `The way back from ${n.brand} was not finished, so nothing was saved.` : `Something went wrong on the way back from ${n.brand}, so nothing was saved.`;
  return page("That didn't work", `${NOT_FINISHED}<p class="line">${why} ${m.connectUrl ? "Retry here, or ask" : "Ask"} Trainee for a new link in the chat.</p>${retry}${b}`, { script: CONNECT_SCRIPT, tg: true });
}

// R10 fix 11: a consent that was started (Continue was tapped) and never came back here: nothing was connected; resume it, or cancel.
export function renderUnfinished(m: { token: string; provider: ProviderId; botUrl: string | null }): string {
  const n = NAMES[m.provider];
  const resume = `<form method="post" class="go">${hidden(m.token, "start", m.provider)}<button type="submit" class="primary">Resume connecting ${n.mail}</button></form>`;
  const cancel = `<form method="post">${hidden(m.token, "cancel", m.provider)}<button type="submit" class="secondary">Cancel</button></form>`;
  return page("Connecting didn't finish", `${NOT_FINISHED}<p class="line">You started connecting ${n.mail} on ${n.brand}'s page, but it didn't come back here, so nothing was connected.</p><p class="line">Resume to choose the account on ${n.brand}'s page again, or cancel.</p><div class="actions">${resume}${cancel}${back(m.botUrl, "notnow")}</div>`, { script: CONNECT_SCRIPT, tg: true });
}

// A link that cannot be used or a step that cannot be done: says why, shows nothing about any account.
export function renderState(title: string, paras: string[], botUrl: string | null): string {
  // R10 fix 10: the way back is always there, right under the heading (a phone's first screen): Back to Telegram, else the words.
  return page(title, `${paras.map((p) => `<p class="line">${esc(p)}</p>`).join("")}${botUrl ? `<div class="actions recovery">${back(botUrl)}</div>` : `<p class="recovery">Ask Trainee in your chat for a new link to the same task.</p>`}`, { script: CONNECT_SCRIPT, tg: true });
}

export function renderBootstrap(reason: string): string {
  return page("Connect your email", `<p class="line">Signing you in with Telegram.</p><p class="line" id="nodata" hidden>Open this page from the button in Telegram, or use the link Trainee sent you.</p><noscript><p class="line">This needs JavaScript. Use the link Trainee sent you instead.</p></noscript>`, { script: CONNECT_BOOT, tg: true, bodyAttrs: `data-w="${esc(reasonKey(reason))}"` });
}

// The preview card a chat shows under the link: the brand and the reason; nothing about any person.
export const previewOg = (reason: string, image: string | null = null): Og => ({ title: "Connect your email to Trainee", description: `So I can ${REASONS[reasonKey(reason)]}. One tap; nothing is sent without your approval.`, image });
export function renderPreview(og: Og): string {
  return page("Connect your email", `<p class="line">${esc(og.description)}</p><p class="line">Open this link in your browser, or from Telegram.</p>`, { og });
}
