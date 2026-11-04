// The visual system for the hosted role-results page and "A few things first" (owner design spec 1.1-1.6, 2026-11-02; a proposal,
// not an approved migration). Scoped to those two pages: this module only redefines the page's custom properties, so every other
// Trainee page keeps the tokens in brand.ts. Every status colour is paired with its word in the markup (results_spec.ts labels);
// colour is never the only signal. tests/architect/results-page-design.test.ts computes the WCAG ratio of every text/ground pair.
//
// OWNER OVERRIDE (repeated): the Apply button stays solid black. Plum-700 is for approve-ish controls (Select, links, focus), not Apply.
export interface DesignTokens {
  paper: string; card: string; ink: string; ink2: string; hair: string;
  p950: string; p800: string; p700: string; p600: string; p100: string; p50: string;
  ptext: string; // plum used as TEXT (links, plum chip): lighter on dark grounds
  confirmed: string; attention: string; risk: string; info: string; neutral: string; // status text colours
  confirmedBg: string; attentionBg: string; riskBg: string; infoBg: string; neutralBg: string; plumBg: string; // chip grounds
}
export const LIGHT_T: DesignTokens = {
  paper: "#FBF9F7", card: "#FFFFFF", ink: "#211A24", ink2: "#6E6675", hair: "#E7E1E4",
  p950: "#24102E", p800: "#3D1A4D", p700: "#512566", p600: "#64317C", p100: "#EFE4F2", p50: "#F8F2FA", ptext: "#512566",
  confirmed: "#2E6B4F", attention: "#8A5E0B", risk: "#A63A3A", info: "#46586A", neutral: "#6E6675",
  confirmedBg: "#E6F1EB", attentionBg: "#FBF1DC", riskBg: "#FBE9E9", infoBg: "#E7ECF1", neutralBg: "#F1EDEF", plumBg: "#EFE4F2",
};
export const DARK_T: DesignTokens = {
  paper: "#16101A", card: "#211928", ink: "#F3EEF5", ink2: "#B5ABBC", hair: "#3A2F42",
  p950: "#24102E", p800: "#3D1A4D", p700: "#512566", p600: "#A06BBD", p100: "#3A2748", p50: "#2B1E33", ptext: "#DDC4EA",
  confirmed: "#7FC3A0", attention: "#E3B061", risk: "#F09A9A", info: "#A9BBCC", neutral: "#B5ABBC",
  confirmedBg: "#17332A", attentionBg: "#3A2C0E", riskBg: "#3D1B1B", infoBg: "#1F2A35", neutralBg: "#2A2230", plumBg: "#3A2748",
};

// [what, text, ground, minimum ratio] for every pair the page draws as text.
export function designPairs(t: DesignTokens): [string, string, string, number][] {
  const P: [string, string, string, number][] = [
    ["ink on paper", t.ink, t.paper, 4.5], ["ink on card", t.ink, t.card, 4.5], ["ink-2 on paper", t.ink2, t.paper, 4.5], ["ink-2 on card", t.ink2, t.card, 4.5],
    ["ink on plum-50 fit callout", t.ink, t.p50, 4.5], ["ink-2 on plum-50", t.ink2, t.p50, 4.5], ["plum text on paper", t.ptext, t.paper, 4.5], ["plum text on card", t.ptext, t.card, 4.5],
    ["plum text on plum-50", t.ptext, t.p50, 4.5], ["white on plum-700", "#FFFFFF", t.p700, 7], ["white on black Apply", "#FFFFFF", "#000000", 7],
    ["white on header end plum-800", "#FFFFFF", t.p800, 7], ["white on header start plum-950", "#FFFFFF", t.p950, 7],
    ["plum text on plum-100 chip", t.ptext, t.plumBg, 4.5], ["danger text on card", t.risk, t.card, 4.5],
  ];
  for (const k of ["confirmed", "attention", "risk", "info", "neutral"] as const) {
    P.push([`${k} chip text`, t[k], t[`${k}Bg` as const], 4.5], [`${k} text on card`, t[k], t.card, 4.5], [`${k} text on paper`, t[k], t.paper, 4.5]);
  }
  return P;
}

const vars = (t: DesignTokens) => `--paper:${t.paper};--card:${t.card};--ink:${t.ink};--ink-2:${t.ink2};--hair:${t.hair};--plum-950:${t.p950};--plum-800:${t.p800};--plum-700:${t.p700};--plum-600:${t.p600};--plum-100:${t.p100};--plum-50:${t.p50};--plum-text:${t.ptext};`
  + `--st-confirmed:${t.confirmed};--st-attention:${t.attention};--st-risk:${t.risk};--st-info:${t.info};--st-neutral:${t.neutral};`
  + `--st-confirmed-bg:${t.confirmedBg};--st-attention-bg:${t.attentionBg};--st-risk-bg:${t.riskBg};--st-info-bg:${t.infoBg};--st-neutral-bg:${t.neutralBg};--st-plum-bg:${t.plumBg};`
  // The page-wide names the shared stylesheet already uses, pointed at this palette.
  + `--bg:${t.paper};--panel:${t.p50};--mute:${t.ink2};--line:${t.hair};--link:${t.ptext};--accent:${t.p700};--bad:${t.risk};--warn:${t.attention};--good:${t.confirmed}`;

export const SERIF = `'Source Serif 4','Iowan Old Style','Palatino Linotype',Georgia,serif`;
export const MONO = `'Noto Sans Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;
// Source Serif 4 and Noto Sans Mono from Google Fonts (the same hosts the CSP already allows for Inter); the stacks above keep the
// page right with no network. Inter comes from the shared FONT_LINKS.
export const DESIGN_FONT_LINK = `<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Mono:wght@600&family=Source+Serif+4:wght@600&display=swap" rel="stylesheet">`;

export const DESIGN_CSS = `
:root{${vars(LIGHT_T)}}
@media (prefers-color-scheme:dark){:root{${vars(DARK_T)}}}
.wrap:has(>.results),.wrap:has(>.things){padding-left:calc(14px + env(safe-area-inset-left));padding-right:calc(14px + env(safe-area-inset-right));padding-bottom:calc(24px + env(safe-area-inset-bottom))}
.results,.things{font-size:16px;line-height:1.5;overflow-wrap:anywhere}
.results .brand,.things .brand{margin-bottom:12px}
.results h1,.things h1,.results h2.group,.results .card .title{font-family:${SERIF};font-weight:600;letter-spacing:0}
.rid{font-family:${MONO};font-weight:600;font-size:13px;letter-spacing:.02em;color:var(--plum-text)}
/* File header: plum-950 to plum-800 at 135 degrees, 16px radius */
.filehead{margin:0 0 10px;padding:16px;border-radius:16px;background:linear-gradient(135deg,var(--plum-950),var(--plum-800));color:#fff}
.filehead .kicker,.eyebrow{margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#E9D9F0}
.filehead h1{margin:0;font-size:24px;line-height:1.2;color:#fff}
.filehead .made,.filehead .stamp,.filehead .caveat,.filehead .lede,.filehead .upd,.filehead .cover{color:#F1E8F5;font-size:14px;line-height:1.5}
.filehead .made{margin:0 0 6px}.filehead .stamp{margin:8px 0 0}.filehead .caveat{margin:10px 0 0;font-size:16px}.filehead .lede{margin:8px 0 0;font-size:16px}
.filehead a{color:#fff}
.filehead .top{margin:14px 0 0;padding:12px 0 0;border:0;border-top:1px solid rgba(255,255,255,.28);border-radius:0;background:none}
.filehead .top h2{margin:0 0 8px;font-size:14px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#E9D9F0}
.filehead .counts{gap:6px}
.filehead .counts li{padding:4px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.35);background:rgba(255,255,255,.12);color:#fff;font-size:14px}
.filehead .top .cover{margin:10px 0 0}.filehead .top .upd{margin:6px 0 0}
.filehead .pausebar{margin:10px 0 0}.filehead .pausebar p{color:#F1E8F5;font-size:14px}
.filehead .ghost{border-color:#fff;color:#fff}
.quick{border-radius:14px;padding:12px;border:1px solid var(--hair);background:var(--card);margin:0 0 10px}
.quick h2{font-size:14px;letter-spacing:.14em}.quick p{font-size:16px}
.filters{margin:0 0 10px;padding:12px;border-radius:14px;background:var(--card);border:1px solid var(--hair)}
.filters select,.things input[type=text],.things select,.things textarea{border-radius:11px;font-size:16px}
/* Buttons: ghost/secondary plum, danger red, Apply stays solid black (owner override) */
.ghost{border-radius:11px;border:1px solid var(--plum-700);color:var(--plum-text);font-size:16px;font-weight:600;padding:6px 14px;min-height:44px}
@media (prefers-color-scheme:dark){.ghost{border-color:var(--plum-text)}}
.ghost.small{border-color:var(--hair);color:var(--ink-2);font-size:14px;min-height:44px;padding:6px 12px}
.ghost.danger{background:var(--card);border-color:var(--st-risk);color:var(--st-risk)}
.results .apply,.things .apply{border-radius:11px;font-size:16px;min-height:48px}
.results .apply:focus-visible,.things .apply:focus-visible,.ghost:focus-visible,a:focus-visible,summary:focus-visible,select:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid var(--plum-600);outline-offset:2px}
.filehead :focus-visible{outline-color:#fff}
.results a,.things a{color:var(--plum-text)}
/* Role card (3.5) */
h2.group{margin:18px 0 4px;font-size:20px}.groupnote{margin:0 0 10px;font-size:14px;color:var(--ink-2)}
ul.cards{gap:10px}
.card{background:var(--card);border:1px solid var(--hair);border-radius:14px;padding:12px}
.card .state{margin:0 0 8px;justify-content:space-between;flex-wrap:nowrap}
.card .head{gap:10px;align-items:center}.card .logo{width:40px;height:40px;border-radius:10px}
.card .ttl .title{font-size:17.5px;line-height:1.3}.card .ttl .co{font-size:16px;color:var(--ink-2);margin:2px 0 0}
dl.facts{margin:10px 0 0;gap:4px 12px;font-size:14px}dl.facts dt{color:var(--ink-2)}
dl.facts dd.key{font-size:16px;color:var(--ink)}dl.facts dd.paid{font-weight:600}
.src{font-size:14px;color:var(--ink-2)}
.fit{margin:10px 0 0;padding:10px 12px;border-left:4px solid var(--plum-600);border-radius:0 11px 11px 0;background:var(--plum-50);font-size:16px;color:var(--ink)}
.fit p{margin:0}.fit p+p{margin-top:4px}.fit .gap{color:var(--ink)}
.card details summary{min-height:44px;font-size:16px;font-weight:600;color:var(--plum-text)}
.card .acts{margin-top:10px;gap:10px;justify-content:space-between}
.pick input{accent-color:var(--plum-700)}
.card .guide{margin:10px 0 0;font-size:16px}.card .note{font-size:16px}.applyhelp,.markhelp{font-size:14px;color:var(--ink-2)}
.more{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;margin-top:8px;padding-top:8px;border-top:1px solid var(--hair)}
.more .open{margin:0}.more .open a{font-size:14px;font-weight:600;min-height:44px;display:inline-flex;align-items:center}
.more form.mark{margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:8px}.more .markhelp{margin:0;flex:1 1 200px}
/* State chips: colour AND word, 12.5px, full round */
.chip{flex:none;display:inline-flex;align-items:center;min-height:0;padding:3px 10px;border-radius:999px;font-size:12.5px;line-height:1.4;font-weight:600;letter-spacing:.01em;background:var(--st-neutral-bg);color:var(--st-neutral);border:1px solid currentColor}
.chip::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;margin-right:6px;flex:none}
.chip.t-confirmed{background:var(--st-confirmed-bg);color:var(--st-confirmed)}.chip.t-attention{background:var(--st-attention-bg);color:var(--st-attention)}
.chip.t-risk{background:var(--st-risk-bg);color:var(--st-risk)}.chip.t-info{background:var(--st-info-bg);color:var(--st-info)}
.chip.t-neutral{background:var(--st-neutral-bg);color:var(--st-neutral)}.chip.t-plum{background:var(--st-plum-bg);color:var(--plum-text)}
.card .chip{min-height:0}
/* Bottom action bar: pinned to the bottom edge for the whole scroll (it sits before the cards in the document so each card stays one block) */
.actionbar{position:fixed;left:0;right:0;bottom:0;z-index:5;background:var(--card);border-top:1px solid var(--hair);padding-bottom:env(safe-area-inset-bottom)}
.abin{max-width:640px;margin:0 auto;padding:10px 14px;display:flex;gap:10px;align-items:center}
.actionbar form{margin:0;flex:1 1 0;min-width:0}.actionbar .apply,.actionbar .ghost{width:100%;padding-left:8px;padding-right:8px}
.selhelp{margin:0 0 10px;font-size:14px;color:var(--ink-2)}
.wrap:has(>.results){padding-bottom:calc(96px + env(safe-area-inset-bottom))}
.empty{border-radius:14px;background:var(--card);border:1px solid var(--hair)}
/* A few things first */
.things fieldset{border-radius:14px;border:1px solid var(--hair);padding:12px;margin:0 0 10px}.things legend{font-size:16px;font-weight:600}
.things .opt{font-size:16px}.things .opt input{accent-color:var(--plum-700)}.things .err{color:var(--st-risk)}
.things .top-note,.results .top-note{border-radius:11px;background:var(--plum-50);border-left:4px solid var(--plum-600)}
.back{font-size:16px}
/* Phone fixes: the Dismiss form takes the whole row (it was squeezed to ~32px beside the view link at 360px); the fixed bottom bar never hides a focused control; a skip link past the long header */
.more form.mark{flex:1 1 100%}
html{scroll-padding-bottom:104px}
.skip{position:absolute;left:-9999px;top:0;z-index:10;padding:12px 16px;background:#000;color:#fff!important;border-radius:0 0 11px 0;font-weight:600}.skip:focus{left:0}
.fstate{padding:16px;border-radius:14px;background:var(--card);border:1px solid var(--hair)}
@media (prefers-reduced-motion:no-preference){.card,.chip,.ghost,.apply{transition:background-color .15s ease,border-color .15s ease,opacity .15s ease}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media (max-width:480px){.card .acts{flex-direction:column;align-items:stretch}.card .state{flex-wrap:wrap}}
`;
