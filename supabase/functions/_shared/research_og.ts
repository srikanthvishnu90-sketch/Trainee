// R9-C (2026-11-07): the link preview a research brief's link shows (og:image), drawn like an iMessage link card in Trainee's brand:
// the warm off-white ground, the T mark and the name, a serif title, ink and mute text, plum only in the mark. No new hue (brand.ts).
// The card names the kind, never the brief: a link-preview crawler gets nothing of the file (tests/architect/file-kinds.test.ts), so
// one static image serves every brief. scripts/brand/og-research.ts renders this HTML to og-research.png (1200 x 630) at the site root.
import { BODY_FONT, DISPLAY_FONT, FONT_LINKS, LIGHT, PLUM } from "./brand.ts";

export const RESEARCH_OG_FILE = "og-research.png";
export const RESEARCH_OG_SIZE = { width: 1200, height: 630 } as const;
// The og:image for a research brief, on the same origin as the File pages' own card (og-file.png); none without an https base.
export const researchOgImage = (base: string | undefined | null): string | null => {
  const b = String(base ?? "").trim();
  return /^https:\/\//.test(b) ? `${new URL(b).origin}/${RESEARCH_OG_FILE}` : null;
};

export function researchOgCardHtml(): string {
  const t = LIGHT;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${FONT_LINKS}<style>
*{box-sizing:border-box}html,body{margin:0;width:${RESEARCH_OG_SIZE.width}px;height:${RESEARCH_OG_SIZE.height}px;background:${t.bg};color:${t.ink};font-family:${BODY_FONT}}
.c{position:absolute;inset:0;padding:72px 84px;display:flex;flex-direction:column}
.b{display:flex;align-items:center;gap:18px}.b svg{width:64px;height:64px}.b span{font-family:${DISPLAY_FONT};font-weight:700;font-size:40px;letter-spacing:-.01em}
.k{margin:auto 0 0;font-size:26px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${t.mute}}
h1{margin:14px 0 0;font-family:${DISPLAY_FONT};font-weight:500;font-size:96px;line-height:1.02;letter-spacing:-.015em}
p{margin:22px 0 0;font-size:34px;color:${t.mute}}.r{position:absolute;left:84px;right:84px;bottom:56px;height:2px;background:${t.line}}
</style></head><body><div class="c"><div class="b"><svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="${PLUM}"/><text x="32" y="45" font-family="Georgia,serif" font-size="40" font-weight="700" text-anchor="middle" fill="#fff">T</text></svg><span>Trainee</span></div>
<p class="k">Market research</p><h1>Research brief</h1><p>Every claim cited to a source Trainee read.</p></div><div class="r"></div></body></html>`;
}
