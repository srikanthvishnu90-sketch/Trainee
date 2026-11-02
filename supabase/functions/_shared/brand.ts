// Trainee's one visual identity (product requirements Q540, Q553, Q564, Q565, Q575, Q726): every page Trainee serves — the jobs
// list, the phone sign-in, the connect page, the hosted files, and the small Gmail/Outlook pages at the end of a connection — is
// drawn from these tokens, so any two Trainee pages side by side have the same ground, ink, plum and type.
//
// Colour roles (Q575: four roles, no more, plus the status hues the status chips already use):
//   accent  plum, ONLY for the one primary action and selected states (a button's ground, a focus ring, a link);
//   ink     the one text colour; mute the metadata colour; bad (red) only for a genuine failure.
// Plum is never a background wash and never the body text colour.
//
// Contrast (Q540, Q553): every text/ground pair below is at least WCAG AA (4.5:1) in both schemes, and the action's text on plum
// is at least AAA (7:1). tests/architect/design-tokens.test.ts computes each ratio with the WCAG relative-luminance formula.
//
// The plum value (owner ruling 2026-10-31, docs/architect/DECISIONS.md D-DESIGN-1): #5C2751, the doc-3 proposal (11.3:1 on white,
// AAA). It replaced #4A2F5E. The hover tint and the dark-scheme tint are derived for contrast; the base never moves for them.
export const PLUM = "#5C2751";

export interface Tokens { bg: string; ink: string; mute: string; line: string; accent: string; accentHover: string; accentInk: string; link: string; good: string; bad: string; warn: string; panel: string; disabledBg: string; disabledInk: string }
export const LIGHT: Tokens = { bg: "#FAF8F4", ink: "#141414", mute: "#4F4F57", line: "#E6E3DD", accent: PLUM, accentHover: "#6E3462", accentInk: "#FFFFFF", link: PLUM, good: "#1B6B3A", bad: "#B42318", warn: "#8A5300", panel: "#F1EEE8", disabledBg: "#E6E3DD", disabledInk: "#4F4F57" };
// Dark grounds: the plum is lifted to a light plum so it keeps its contrast (Q553), and the action's text turns dark.
export const DARK: Tokens = { bg: "#000000", ink: "#EDEDF0", mute: "#A6A6B0", line: "#1F1F25", accent: "#D4C2E2", accentHover: "#FFFFFF", accentInk: "#141414", link: "#D4C2E2", good: "#7FB89A", bad: "#E07A6E", warn: "#E3B061", panel: "#16161A", disabledBg: "#1F1F25", disabledInk: "#A6A6B0" };

const vars = (t: Tokens) =>
  `--bg:${t.bg};--ink:${t.ink};--mute:${t.mute};--line:${t.line};--accent:${t.accent};--accent-hover:${t.accentHover};--accent-ink:${t.accentInk};--link:${t.link};--good:${t.good};--bad:${t.bad};--warn:${t.warn}`;
// The custom properties every Trainee page starts its stylesheet with (both schemes).
export const TOKENS_CSS = `:root{${vars(LIGHT)};--panel:${LIGHT.panel};--disabled-bg:${LIGHT.disabledBg};--disabled-ink:${LIGHT.disabledInk};color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{${vars(DARK)};--panel:${DARK.panel};--disabled-bg:${DARK.disabledBg};--disabled-ink:${DARK.disabledInk}}}`;

// A disabled action (a button while its request runs): muted, never a plum the person might tap again, still AA (Q553).
export const DISABLED_CSS = `.apply:disabled{background:var(--disabled-bg);border-color:var(--disabled-bg);color:var(--disabled-ink);cursor:default}.lnk:disabled,.all button:disabled{color:var(--mute);cursor:default}`;

// Type (Q543, Q544): Inter for text, Brygada 1918 for the display heading and the wordmark, system fonts as the fallback; body
// text 18px, facts never under 16px on a phone.
export const BODY_FONT = `'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif`;
export const DISPLAY_FONT = `'Brygada 1918',Georgia,serif`;
export const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Brygada+1918:wght@500;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">`;
// What a page's Content-Security-Policy must allow for the fonts above (style and font sources).
export const FONT_CSP = { style: "https://fonts.googleapis.com", font: "https://fonts.gstatic.com" };

// The mark and wordmark (Q562, Q563): the name in one face, no mascot, no tagline.
export const BRAND = `<div class="brand"><svg class="mark" viewBox="0 0 64 64" role="img" aria-label="Trainee"><rect width="64" height="64" rx="14" fill="${PLUM}"/><text x="32" y="45" font-family="Georgia,serif" font-size="40" font-weight="700" text-anchor="middle" fill="#fff">T</text></svg><span class="wm">Trainee</span></div>`;
export const FAVICON = `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23${PLUM.slice(1)}'/%3E%3Ctext x='32' y='45' font-family='Georgia,serif' font-size='40' font-weight='700' text-anchor='middle' fill='%23fff'%3ET%3C/text%3E%3C/svg%3E">`;

// ---------------------------------------------------------------- WCAG contrast (relative luminance, sRGB)
function channel(v: number): number { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a #RRGGBB colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
export function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
// The pairs a reader actually reads: [text, ground, minimum ratio].
export function readablePairs(t: Tokens): [string, string, string, number][] {
  return [
    ["ink on ground", t.ink, t.bg, 4.5], ["metadata on ground", t.mute, t.bg, 4.5], ["link on ground", t.link, t.bg, 4.5],
    ["error on ground", t.bad, t.bg, 4.5], ["success on ground", t.good, t.bg, 4.5], ["warning on ground", t.warn, t.bg, 4.5],
    ["ink on panel", t.ink, t.panel, 4.5], ["metadata on panel", t.mute, t.panel, 4.5],
    ["action text on plum", t.accentInk, t.accent, 7], ["action text on plum (hover)", t.accentInk, t.accentHover, 4.5],
    ["disabled button text on its ground", t.disabledInk, t.disabledBg, 4.5], ["disabled link-button text on ground", t.mute, t.bg, 4.5],
  ];
}

// ---------------------------------------------------------------- the small system page
// The one-message pages at the end of a connection (Gmail or Outlook connected, a used link, "not available yet"): the same shell
// as the jobs page — warm ground, ink text, the T mark, Inter — with plum only on the single button. Text is escaped here.
const escText = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const SYSTEM_CSS = `${TOKENS_CSS}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:18px/1.5 ${BODY_FONT};-webkit-font-smoothing:antialiased}
main{max-width:640px;margin:0 auto;padding:calc(20px + env(safe-area-inset-top)) 20px calc(48px + env(safe-area-inset-bottom))}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:22px}.mark{width:32px;height:32px;flex:none}
.wm{font-family:${DISPLAY_FONT};font-weight:700;font-size:24px;letter-spacing:-.01em}
h1{margin:0 0 12px;font-family:${DISPLAY_FONT};font-weight:500;font-size:28px;line-height:1.2;overflow-wrap:anywhere}
p{overflow-wrap:anywhere}
.apply{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:6px 20px;border-radius:999px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);font:inherit;font-weight:600;cursor:pointer}
.apply:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
:focus-visible{outline:3px solid var(--accent);outline-offset:3px;border-radius:8px}
@media (max-width:480px){.apply{width:100%}}
${DISABLED_CSS}`;
export function systemPage(title: string, paras: string[], form?: { action: string; token: string; label: string }): string {
  const button = form
    ? `<form method="post" action="${escText(form.action)}"><input type="hidden" name="t" value="${escText(form.token)}"><button type="submit" class="apply">${escText(form.label)}</button></form>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="${PLUM}" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">${FAVICON}${FONT_LINKS}<title>${escText(title)}</title><style>${SYSTEM_CSS}</style></head>` +
    `<body><main><header>${BRAND}<h1>${escText(title)}</h1></header>${paras.map((p) => `<p>${escText(p)}</p>`).join("")}${button}</main></body></html>`;
}
