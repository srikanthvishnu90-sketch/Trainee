// The jobs list page (owner, 2026-10-28): a plain list of rows. Each row: logo, company name, Apply at the far right; under it a
// short description of the role; tapping the description opens the full posting. One tiny line on top says which resume the
// Apply taps use. Pure functions: a model in, HTML or plain text out.
//
// Rules that do not move: the status word says what is true (Queued / Preparing / Sending / Submitted / Confirmed / Failed /
// Not submitted / Needs you / Unknown) and "applied" is never written; the logo comes only from the employer's own domain, else a
// lettermark; posting text is untrusted and always escaped (bidi overrides and isolates removed, links only http and https).
import type { JobView } from "./telegram_jobs.ts";

export type Word = "queued" | "preparing" | "sending" | "submitted" | "confirmed" | "failed" | "not submitted" | "needs you" | "unknown";
export interface Status { word: Word; detail: string }
export interface AppRow {
  id: string; state: string; reason: string | null; confirmation_id: string | null; created_at: string; updated_at: string;
  email_confirmed_at: string | null; payload: Record<string, unknown>; company: string; url: string;
}
export interface Row {
  ref: string; job: JobView; logo: string | null; snippet: string; full: string | null;
  status: Status | null; // null: nothing yet, so the row offers Apply
  tag: string | null; // first 16 hex of the payload hash this row's Apply is bound to; null when nothing is prepared yet
  resume: string | null; byHand: boolean; note?: string;
  blocked?: string | null; // why this row offers no Apply (it cannot pass the posting screen, or is the same posting as a row above)
  sends?: string; send?: { label: string; value: string; needs?: boolean }[];
  meta?: string; metaSrc?: "From the posting" | "Reported, not verified" | null; why?: string[];
}
export interface Feed { og?: Og; token: string; rows: Row[]; setHash: string | null; setSize: number; top?: string; botUrl?: string | null }

// Bidi overrides and isolates (U+202A-E, U+2066-9) in a company, title or location would reverse the text after them on the page,
// a provenance label included; they are dropped, never rendered.
export const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;
export const esc = (s: unknown) => String(s ?? "").replace(BIDI_CONTROLS, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const dayOf = (iso: string | null | undefined) => { const t = iso ? Date.parse(iso) : NaN; if (Number.isNaN(t)) return null; const d = new Date(t); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
export const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// null = available (no status to show). Details are plain words about what is true.
export function statusOf(o: { app: AppRow | null; wanted: boolean }): Status | null {
  const a = o.app, who = a?.company || "The employer";
  if (a) {
    switch (a.state) {
      case "confirmed": return { word: "confirmed", detail: `${who} confirmed it${a.confirmation_id ? ` (${a.confirmation_id})` : ""}.` };
      case "submitted_unconfirmed": return { word: "submitted", detail: `${who} hasn't confirmed it yet.` };
      case "queued": return { word: "queued", detail: "We haven't started it yet." };
      case "driving": return { word: "sending", detail: "Being sent now; not submitted yet." };
      case "needs_user": return { word: "needs you", detail: a.reason ?? "It stopped and needs you." };
      case "failed": return { word: "failed", detail: a.reason ?? "No reason was recorded." };
      case "not_submitted": return { word: "not submitted", detail: a.reason ?? "It was not sent." };
      case "unknown_outcome": return { word: "unknown", detail: `We can't tell whether it reached ${who}. It won't be sent again.` };
      default: return { word: "unknown", detail: `Recorded as ${a.state}; not known to be sent.` };
    }
  }
  return o.wanted ? { word: "preparing", detail: "Getting it ready. Nothing has been sent." } : null;
}

// A short description from the posting's own text: its first sentences, never more than ~150 characters. No text, no invention:
// then the role's place, if the posting states it.
export function snippetOf(job: JobView, description: string | null | undefined): string {
  const plain = String(description ?? "").replace(/<\/(p|li|h\d|div)>/gi, ". ").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").replace(/(\. ){2,}/g, ". ").trim();
  if (plain.length > 20) return clip(plain, 150);
  return [job.location, job.remote === "remote" ? "Remote" : job.remote === "hybrid" ? "Hybrid" : job.remote === "onsite" ? "On-site" : ""].filter(Boolean).join(" · ");
}
export function fullOf(description: string | null | undefined): string | null {
  const plain = String(description ?? "").replace(/<\/(p|li|h\d|div)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<li[^>]*>/gi, "• ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return plain ? clip(plain, 12000) : null;
}
export const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
// Only an http or https posting link becomes a link on the page (a stored "javascript:" link is never one).
export const webUrl = (u: string) => { try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? u : null; } catch { return null; } };

// ---------------------------------------------------------------- html
const CSS = `
:root{--bg:#FAF8F4;--ink:#141414;--mute:#4F4F57;--line:#E6E3DD;--accent:#4A2F5E;--accent-hover:#5C3B74;--accent-ink:#FFFFFF;--link:#4A2F5E;--good:#1B6B3A;--bad:#B42318;--warn:#8A5300;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#000000;--ink:#EDEDF0;--mute:#A6A6B0;--line:#1F1F25;--accent:#D4C2E2;--accent-hover:#FFFFFF;--accent-ink:#141414;--link:#D4C2E2;--good:#7FB89A;--bad:#E07A6E;--warn:#E3B061}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:18px/1.5 'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;letter-spacing:-.005em;-webkit-font-smoothing:antialiased}
h1{font-family:'Brygada 1918',Georgia,serif;font-weight:500}
.wrap{max-width:640px;margin:0 auto;min-height:100vh;min-height:100dvh;padding:calc(20px + env(safe-area-inset-top)) calc(20px + env(safe-area-inset-right)) calc(48px + env(safe-area-inset-bottom)) calc(20px + env(safe-area-inset-left))}
header{padding:4px 0 18px}.brand{display:flex;align-items:center;gap:10px;margin-bottom:22px}.mark{width:32px;height:32px;flex:none}
.wm{font-family:'Brygada 1918',Georgia,serif;font-weight:700;font-size:24px;letter-spacing:-.01em}
h1{margin:0;font-size:28px;line-height:1.2}
.with{margin:6px 0 0;font-size:14px;color:var(--mute)}
.all{margin:6px 0 0}.all button{display:inline-flex;align-items:center;min-height:44px;padding:0;border:0;background:none;color:var(--link);font:inherit;font-size:15px;font-weight:500;text-decoration:underline;cursor:pointer}
.top-note{margin:8px 0 14px;color:var(--bad)}
ul.rows{list-style:none;margin:0;padding:0}
.row{padding:22px 0;border-top:1px solid var(--line)}
.head{display:flex;align-items:center;gap:14px}
.logo{position:relative;flex:none;width:44px;height:44px;border-radius:10px;overflow:hidden;border:1px solid var(--line)}
.lettermark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:'Brygada 1918',Georgia,serif;font-size:22px;font-weight:700;color:var(--ink)}
.logo img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#fff;color:transparent;font-size:0}
.name{flex:1;min-width:0;font-weight:600;font-size:19px;overflow-wrap:anywhere}
.act{flex:none;margin:0}
.apply{display:inline-flex;align-items:center;justify-content:center;min-width:96px;min-height:48px;padding:6px 20px;border-radius:999px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);font:inherit;font-weight:600;text-decoration:none;cursor:pointer}.apply:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.chip{flex:none;min-height:48px;display:inline-flex;align-items:center;justify-content:flex-end;font-weight:600;color:var(--mute)}
.chip.queued,.chip.sending,.chip.submitted,.chip.confirmed{color:var(--good)}.chip.failed,.chip.not-submitted,.chip.unknown{color:var(--bad)}.chip.needs-you{color:var(--warn)}
details{margin:4px 0 0 58px}summary{list-style:none;cursor:pointer;min-height:44px;padding:4px 0}
summary::-webkit-details-marker{display:none}
.role{display:block;font-weight:500}.desc{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--mute);font-size:16px}
details[open] .desc{display:block;-webkit-line-clamp:unset}
.meta,.why,.note{margin:2px 0 0 58px;font-size:15px;color:var(--mute)}.why{color:var(--ink)}
.full{white-space:pre-wrap;overflow-wrap:anywhere;font-size:16px;margin:8px 0}
.note a,details a,.top-note a{color:var(--link)}.lnk{display:inline;min-height:44px;padding:0 4px;border:0;background:none;color:var(--link);font:inherit;text-decoration:underline;cursor:pointer}.sendh{margin:8px 0 2px;font-weight:600;font-size:15px}.send{margin:0 0 8px;padding-left:20px;font-size:15px;color:var(--mute)}.send li{margin:2px 0;overflow-wrap:anywhere}
:focus-visible{outline:3px solid var(--accent);outline-offset:3px;border-radius:8px}
.foot{margin-top:24px;padding-top:14px;border-top:1px solid var(--line);font-size:15px;color:var(--mute)}
@media (max-width:360px){details,.meta,.why,.note{margin-left:0}.apply{min-width:80px;padding:6px 12px}}
`;
export interface Og { title: string; description: string; image: string | null }
const ogTags = (o: Og) => `<meta property="og:type" content="website"><meta property="og:site_name" content="Trainee"><meta property="og:title" content="${esc(o.title)}"><meta property="og:description" content="${esc(o.description)}">${o.image ? `<meta property="og:image" content="${esc(o.image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(o.image)}">` : `<meta name="twitter:card" content="summary">`}<meta name="twitter:title" content="${esc(o.title)}"><meta name="twitter:description" content="${esc(o.description)}">`;
const OG_DEFAULT: Og = { title: "Your jobs on Trainee", description: "Tap Apply on any job.", image: null };
export function layout(title: string, inner: string, o: { script?: string; bodyAttrs?: string; og?: Og; tg?: boolean; css?: string } = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#4A2F5E" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">${ogTags(o.og ?? OG_DEFAULT)}
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%234A2F5E'/%3E%3Ctext x='32' y='45' font-family='Georgia,serif' font-size='40' font-weight='700' text-anchor='middle' fill='%23fff'%3ET%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Brygada+1918:wght@500;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<title>${esc(clip(title, 90))}</title><style>${CSS}${o.css ?? ""}</style></head>
<body${o.bodyAttrs ? " " + o.bodyAttrs : ""}><div class="wrap">${inner}</div>${o.tg ? `<script src="https://telegram.org/js/telegram-web-app.js"></script>` : ""}${o.script ? `<script>${o.script}</script>` : ""}</body></html>`;
}
// In-place flip without a reload: every .ajax form posts, the response page replaces the list. Without script the forms post and
// the response is the whole page. The script is a constant (the CSP allows exactly its hash).
export const TG_READY = `var w=window.Telegram&&window.Telegram.WebApp;if(w){try{w.ready();w.expand();var c=getComputedStyle(document.body).backgroundColor.match(/\\d+/g);if(c){var h="#"+c.slice(0,3).map(function(n){return("0"+(+n).toString(16)).slice(-2)}).join("");if(w.setBackgroundColor)w.setBackgroundColor(h);if(w.setHeaderColor)w.setHeaderColor(h)}}catch(e){}}`;
export const FEED_SCRIPT = `(function(){${TG_READY}var r=document.getElementById("root");if(!r||!window.fetch||!window.DOMParser)return;r.addEventListener("submit",function(e){var f=e.target;if(!f.classList||!f.classList.contains("ajax"))return;e.preventDefault();var b=f.querySelector("button");if(b)b.disabled=true;fetch(location.href,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(new FormData(f)).toString()}).then(function(x){return x.text()}).then(function(t){var d=new DOMParser().parseFromString(t,"text/html").getElementById("root");if(d){r.innerHTML=d.innerHTML}else{f.submit()}}).catch(function(){f.submit()})})})();`;
export const BOOT_SCRIPT = `(function(){${TG_READY}var p=new URLSearchParams(location.hash.slice(1)),d=p.get("tgWebAppData");if(!d){document.getElementById("nodata").hidden=false;return}var f=document.createElement("form");f.method="post";function a(n,v){var i=document.createElement("input");i.type="hidden";i.name=n;i.value=v;f.appendChild(i)}a("init",d);a("list",document.body.getAttribute("data-list"));document.body.appendChild(f);f.submit()})();`;

export const BRAND = `<div class="brand"><svg class="mark" viewBox="0 0 64 64" role="img" aria-label="Trainee"><rect width="64" height="64" rx="14" fill="#4A2F5E"/><text x="32" y="45" font-family="Georgia,serif" font-size="40" font-weight="700" text-anchor="middle" fill="#fff">T</text></svg><span class="wm">Trainee</span></div>`;
const refresh = (token: string) => `<form method="post" class="ajax" style="display:inline">${hidden(token, "refresh")}<button type="submit" class="lnk">Refresh</button></form>`;
const hidden = (token: string, action: string, extra = "") => `<input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="action" value="${action}">${extra}`;

function rowHtml(r: Row, token: string): string {
  const j = r.job;
  const initial = esc((j.company.trim()[0] ?? "?").toUpperCase());
  const img = r.logo ? `<img src="${esc(r.logo)}" alt="${esc(j.company)} logo" width="48" height="48" loading="lazy" referrerpolicy="no-referrer">` : "";
  const link = webUrl(j.url), host = link ? hostOf(link) : "";
  let act: string;
  if (r.status) act = `<span class="chip ${r.status.word.replace(/ /g, "-")}" role="status">${esc(cap1(r.status.word))}</span>`;
  else if (r.byHand) act = link ? `<a class="apply" href="${esc(link)}" rel="noopener noreferrer" aria-label="Open ${esc(j.title)} at ${esc(j.company)} to apply there yourself">Apply there</a>` : "";
  else if (r.blocked) act = "";
  else act = `<form method="post" class="ajax act">${hidden(token, "apply", `<input type="hidden" name="ref" value="${esc(r.ref)}"><input type="hidden" name="tag" value="${esc(r.tag ?? "none")}">`)}<button type="submit" class="apply" aria-label="Apply to ${esc(j.title)} at ${esc(j.company)}">Apply</button></form>`;
  const openOn = host ? `<p><a href="${esc(link)}" rel="noopener noreferrer">Open on ${esc(host)}</a></p>` : "";
  const more = r.full ? `<p class="full">${esc(r.full)}</p>${openOn}` : `<p class="full">The full posting text isn't on file.</p>${openOn}`;
  const note = r.note ? `<p class="note">${esc(r.note)} ${refresh(token)}</p>` : r.status ? `<p class="note">${esc(r.status.detail)}</p>` : r.byHand ? `<p class="note">Not applied for automatically on this site.</p>` : r.blocked ? `<p class="note">Not offered: ${esc(r.blocked)}</p>` : "";
  const meta = r.meta ? `<p class="meta">${esc(r.meta)}${r.metaSrc ? ` · ${esc(r.metaSrc)}` : ""}</p>` : "";
  const sendsLine = r.sends ? `<p class="meta">${esc(r.sends)}</p>` : "";
  const sendList = r.send?.length ? `<p class="sendh">What we send</p><ul class="send">${r.send.map((x) => `<li>${esc(x.label)}: ${x.needs ? `<strong>Needs you</strong>` : esc(x.value)}</li>`).join("")}</ul>` : "";
  const why = r.why?.length ? `<p class="why">Why it fits you: ${esc(r.why.slice(0, 2).join(" "))}</p>` : "";
  return `<li class="row" id="r-${esc(r.ref)}"><div class="head"><span class="logo"><span class="lettermark" aria-hidden="true">${initial}</span>${img}</span><span class="name">${esc(j.company)}</span>${act}</div>
<details><summary><span class="role">${esc(j.title)}</span><span class="desc">${esc(r.snippet)}</span></summary>${sendList}${more}</details>${meta}${sendsLine}${why}${note}</li>`;
}

export function renderFeed(f: Feed): string {
  const names = [...new Set(f.rows.map((r) => r.resume).filter(Boolean))] as string[];
  const withLine = names.length ? `<p class="with">Applying with: ${esc(names.join(", "))}</p>` : "";
  const all = f.setHash && f.setSize >= 2 ? `<form method="post" class="ajax all">${hidden(f.token, "applyall", `<input type="hidden" name="set" value="${f.setHash}">`)}<button type="submit">Apply to all ${f.setSize}</button></form>` : "";
  const top = f.top ? `<p class="top-note" role="alert">${esc(f.top)} ${refresh(f.token)}</p>` : "";
  const inner = `<div id="root"><header>${BRAND}<h1>Your jobs</h1>${withLine}${all}</header><main id="main">${top}<ul class="rows">${f.rows.map((r) => rowHtml(r, f.token)).join("")}</ul></main>${signOutFoot(f.token)}</div>`;
  return layout("Your jobs - Trainee", inner, { script: FEED_SCRIPT, tg: true, og: f.og });
}
// Sign out of this page here, or everywhere it is open (every session of the account ends; each needs a new sign-in).
export const signOutFoot = (token: string) => `<footer class="foot"><form method="post" style="display:inline">${hidden(token, "signout")}<button type="submit" class="lnk">Sign out</button></form> · <form method="post" style="display:inline">${hidden(token, "signout_all")}<button type="submit" class="lnk">Sign out everywhere</button></form></footer>`;

// PHONE SIGN-IN (file_session.ts): a link opens this, never the list. Step 1 the number, step 2 the texted code. Nothing about
// the person or their jobs is on either page, not even a masked number.
const LOGIN_CSS = `.login label{display:block;margin:14px 0 6px;font-weight:600}.login input{box-sizing:border-box;width:100%;max-width:320px;min-height:48px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;font-size:18px;background:var(--bg);color:inherit}.login .apply{margin-top:14px}.login .hint{font-size:15px;opacity:.8}`;
export function renderPhoneLogin(o: { step: "phone" | "code"; note?: string; botUrl?: string | null }): string {
  const note = o.note ? `<p class="top-note" role="alert">${esc(o.note)}</p>` : "";
  const form = o.step === "phone"
    ? `<form method="post" class="login"><input type="hidden" name="action" value="phone_start"><label for="phone">Your phone number</label><input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required maxlength="32" placeholder="+1 (555) 000-0000"><p class="hint">The number on your Trainee account. We text it a 6-digit code.</p><button type="submit" class="apply">Text me a code</button></form>`
    : `<form method="post" class="login"><input type="hidden" name="action" value="phone_verify"><label for="code">6-digit code</label><input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 -]{6,9}" required maxlength="9"><button type="submit" class="apply">Sign in</button></form><form method="post" class="login"><input type="hidden" name="action" value="phone_reset"><button type="submit" class="lnk">Use a different number</button></form>`;
  const lead = o.step === "phone" ? "Sign in with your phone number to see your jobs and apply." : "If that is the number on your Trainee account, we texted it a code. Type it here.";
  return layout("Sign in - Trainee", `<header>${BRAND}<h1>Sign in</h1></header><main id="main">${note}<p>${esc(lead)}</p>${form}<p class="hint">Trainee never asks for a password, and never asks for this code in chat.</p>${o.botUrl ? `<p><a href="${esc(o.botUrl)}" rel="noopener noreferrer">Get a new link</a></p>` : ""}</main>`, { css: LOGIN_CSS });
}
export function renderBootstrap(list: string): string {
  return layout("Opening your jobs - Trainee", `<header>${BRAND}<h1>Opening your jobs</h1></header><main id="main"><p>Signing you in with Telegram.</p><p id="nodata" hidden>Open this page from the button in Telegram, or use the link Trainee sent you.</p><noscript><p>This needs JavaScript. Use the link Trainee sent you instead.</p></noscript></main>`, { script: BOOT_SCRIPT, tg: true, bodyAttrs: `data-list="${esc(list)}"` });
}
// A link that cannot be used: says why, shows nothing about any job, offers a way to get a new one.
export function renderLinkState(title: string, paras: string[], botUrl?: string | null): string {
  return layout(`${title} - Trainee`, `<header>${BRAND}<h1>${esc(title)}</h1></header><main id="main">${paras.map((p) => `<p>${esc(p)}</p>`).join("")}${botUrl ? `<p><a class="apply" href="${esc(botUrl)}" rel="noopener noreferrer">Get a new link</a></p>` : ""}</main>`);
}

// ---------------------------------------------------------------- plain text twin: every row, its state, what Apply does
export function renderText(f: Feed): string {
  return renderTextRaw(f).replace(BIDI_CONTROLS, "");
}
function renderTextRaw(f: Feed): string {
  const names = [...new Set(f.rows.map((r) => r.resume).filter(Boolean))];
  const L = ["Your jobs", ...(names.length ? [`Applying with: ${names.join(", ")}`] : []), `Apply to all: ${f.setHash && f.setSize >= 2 ? `available (${f.setSize} rows)` : "not available"}`, ""];
  f.rows.forEach((r, i) => {
    L.push(`${i + 1}. ${r.job.company} - ${r.job.title}`);
    if (r.snippet) L.push(`   ${r.snippet}`);
    L.push(`   Status: ${r.status ? r.status.word : "available"}${r.status ? ` (${r.status.detail})` : ""}`);
    L.push(`   Apply: ${r.status ? "closed" : r.byHand ? "not automated on this site; apply there yourself" : r.blocked ? `not offered: ${r.blocked}` : "available"}`);
    if (r.job.url) L.push(`   Posting: ${r.job.url}`);
    if (r.note) L.push(`   ${r.note}`);
  });
  L.push("", "To act, open this link in a browser. Apply approves exactly the application prepared for that row.");
  return L.join("\n");
}

// What a link-preview crawler gets: the preview tags and nothing about any job.
export function renderPreview(og: Og): string {
  return layout("Your jobs - Trainee", `<header>${BRAND}<h1>Your jobs</h1></header><main id="main"><p>Open this link in your browser, or from Telegram, to see your jobs.</p></main>`, { og });
}
