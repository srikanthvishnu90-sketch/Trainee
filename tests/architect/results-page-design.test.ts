// Owner design spec (2026-11-02, sections 1.1-1.6, 3.5, 3.10, 5, 6) applied to the hosted role-results page and "A few things first".
// Pure render checks: no network, no browser (the Chromium test, role-pay-results-browser.test.ts, runs in CI only).
import assertNode from "node:assert/strict";
import { contrast } from "../../supabase/functions/_shared/brand.ts";
import { DARK_T, DESIGN_CSS, DESIGN_FONT_LINK, designPairs, LIGHT_T, MONO, SERIF } from "../../supabase/functions/_shared/results_design.ts";
import { renderResults, renderThings, type ResultRow } from "../../supabase/functions/_shared/results_page.ts";
import { specOf, stateCountsOf, stateOfDismissed, STATES, type StateKey } from "../../supabase/functions/_shared/results_spec.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

// Spec 1.6 labels, verbatim.
const SPEC_LABELS = ["Discovered", "Checking", "Needs candidate information", "Preparing", "Ready for review", "Approved", "Queued", "In progress", "User step needed", "Submission uncertain", "Submitted - confirmed", "Blocked", "Excluded", "Closed before submission"];

const row = (i: number, o: Partial<ResultRow> = {}): ResultRow => ({
  ref: `ref${i}`, job: { job_id: `j${i}`, company: `Co${i}`, title: `Role ${i}`, url: `https://boards.example.test/${i}`, source: "greenhouse", location: "Austin, TX", remote: "hybrid", reasons: [] } as never,
  logo: null, snippet: "", full: null, status: null, tag: null, resume: null, byHand: false, blocked: null, why: [], posted: "Posted 2 d ago",
  payShown: "$30-40/hr", payGroup: "meets", payNote: null, payConv: null, place: "Austin, TX · Hybrid", rid: `R-0${i}`, ...o,
});
const st = (word: string, extra: Record<string, unknown> = {}) => ({ word, detail: "d", ...extra }) as never;
// One row for every state the code can reach.
const SAMPLE: [StateKey, Partial<ResultRow>][] = [
  ["discovered", {}], ["checking", { status: st("submitted") }], ["needs_info", { openQs: 2 }], ["preparing", { status: st("preparing") }],
  ["ready", { tag: "a".repeat(16) }], ["queued", { status: st("queued") }], ["in_progress", { status: st("sending") }], ["user_step", { status: st("needs you") }],
  ["uncertain", { status: st("unknown") }], ["submitted", { status: st("confirmed", { evidence: "Employer reference Z9" }) }],
  ["blocked", { blocked: "it would be sent to LinkedIn." }], ["closed", { blocked: "its deadline to apply (Oct 30) has passed" }],
];
const feed = (rows: ResultRow[], o: Record<string, unknown> = {}) => ({ token: "tok", title: "frontend internships", floor: "$30/hr", rows, total: rows.length, filters: { pay: "any" as const, where: "" }, places: [], updated: "Nov 2, 2026, 9:00 AM CT", stamp: null, ...o });

Deno.test("design: tokens are custom properties with a dark-mode counterpart (plum scale, paper, card, ink, hairline, five status colours)", () => {
  const light = DESIGN_CSS.split("@media (prefers-color-scheme:dark)")[0], dark = DESIGN_CSS.split("@media (prefers-color-scheme:dark)")[1];
  for (const v of ["--plum-950", "--plum-800", "--plum-700", "--plum-600", "--plum-100", "--plum-50", "--paper", "--card", "--ink", "--ink-2", "--hair", "--st-confirmed", "--st-attention", "--st-risk", "--st-info", "--st-neutral"]) {
    ok(light.includes(`${v}:`), `${v} in the light scheme`);
    ok(dark.includes(`${v}:`), `${v} in the dark scheme`);
  }
  for (const [k, v] of Object.entries({ p950: "#24102E", p800: "#3D1A4D", p700: "#512566", p600: "#64317C", p100: "#EFE4F2", p50: "#F8F2FA", paper: "#FBF9F7", card: "#FFFFFF", ink: "#211A24", ink2: "#6E6675", hair: "#E7E1E4", confirmed: "#2E6B4F", attention: "#8A5E0B", risk: "#A63A3A", info: "#46586A", neutral: "#6E6675" })) eq((LIGHT_T as never)[k], v, `spec value ${k}`);
  ok(DESIGN_CSS.includes("prefers-reduced-motion:reduce") && /transition:none!important/.test(DESIGN_CSS), "reduced motion switches animation and transition off");
  ok(DESIGN_CSS.includes("linear-gradient(135deg,var(--plum-950),var(--plum-800))"), "file header gradient at 135 degrees");
});

Deno.test("design: fonts are Source Serif 4 (titles), Inter (UI), Noto Sans Mono (R-nn ids), with system fallbacks and the Google Fonts link", () => {
  ok(SERIF.startsWith("'Source Serif 4'") && /Georgia,serif$/.test(SERIF) && MONO.startsWith("'Noto Sans Mono'") && /monospace$/.test(MONO));
  ok(/\.rid\{font-family:\$\{MONO\}|\.rid\{font-family:'Noto Sans Mono'/.test(DESIGN_CSS.replace(/\s/g, "")) || DESIGN_CSS.includes(`.rid{font-family:${MONO}`), "ids in mono");
  const html = renderResults(feed([row(1)]));
  ok(html.includes(DESIGN_FONT_LINK) && /family=Source\+Serif\+4/.test(html) && /family=Noto\+Sans\+Mono/.test(html) && /family=Inter/.test(html));
  ok(!/src=["']http/.test(html), "no other external resource");
});

Deno.test("design: WCAG AA (4.5:1) for every text/ground pair in both schemes; white on plum and on black is AAA", () => {
  for (const [scheme, t] of [["light", LIGHT_T], ["dark", DARK_T]] as const) {
    for (const [what, fg, bg, min] of designPairs(t)) ok(contrast(fg, bg) >= min, `${scheme}: ${what} ${fg} on ${bg} is ${contrast(fg, bg).toFixed(2)}:1, under ${min}:1`);
  }
});

Deno.test("design: every spec 1.6 label is defined verbatim, and each is reachable from the row states (Approved and Excluded noted below)", () => {
  eq(Object.values(STATES).map((s) => s.label).sort(), SPEC_LABELS.slice().sort().filter((l) => l !== "Cancelled before submission"), "the 14 labels asked for, verbatim");
  for (const [key, o] of SAMPLE) {
    const sp = specOf(o as never);
    eq(sp.key, key, `${key}`);
    eq(sp.label, STATES[key].label);
  }
  eq(stateOfDismissed().label, "Excluded");
  // Approved: the record has no row state between "prepared" and "queued" to carry it, so a queued application reads Queued
  // (honest queue, no fake progress). The label exists for the day the queue exposes an approved-not-yet-queued state.
  ok(!SAMPLE.some(([k]) => k === "approved") && STATES.approved.label === "Approved");
  // Submitted - confirmed only with evidence.
  eq(specOf({ status: st("confirmed", { evidence: null }), byHand: false, blocked: null, tag: null } as never).label, "Checking");
  eq(specOf({ status: st("confirmed", { evidence: "Employer reference Z9" }), byHand: false, blocked: null, tag: null } as never).label, "Submitted - confirmed");
  // Needs candidate information names the missing fact when it is known.
  ok(/Missing: a work-authorization answer/.test(specOf({ status: null, byHand: false, blocked: null, tag: null, openQs: 1, missing: ["a work-authorization answer"] } as never).detail));
  // Apply by hand is a user step; the failed/not-submitted rows are Blocked.
  eq(specOf({ status: null, byHand: true, blocked: null, tag: null } as never).label, "User step needed");
  eq(specOf({ status: st("failed"), byHand: false, blocked: null, tag: null } as never).label, "Blocked");
});

Deno.test("design: one primary state per role; the counts strip sums to the role total; blocked, closed and user-step roles are never in the ready count", () => {
  const rows = SAMPLE.map(([, o], i) => row(i + 1, o));
  const c = stateCountsOf(rows);
  eq(c.reduce((n, x) => n + x.n, 0), rows.length);
  eq(c.find((x) => x.key === "ready")!.n, 1, "only the prepared role is ready");
  const html = renderResults(feed(rows));
  const strip = /<ul class="counts">([\s\S]*?)<\/ul>/.exec(html)![1];
  const nums = [...strip.matchAll(/<b>(\d+)<\/b>/g)].map((m) => Number(m[1]));
  eq(nums.reduce((a, b) => a + b, 0), rows.length, "the strip on the page sums to the total");
  ok(/<b>1<\/b> Ready for review/.test(strip) && /<b>1<\/b> Blocked/.test(strip) && /<b>1<\/b> Closed before submission/.test(strip));
  eq((html.match(/<li class="card"/g) ?? []).length, rows.length);
});

Deno.test("design: never colour alone: every chip carries its words and a tone class, and every count carries a label", () => {
  const rows = SAMPLE.map(([, o], i) => row(i + 1, o));
  const html = renderResults(feed(rows, { dismissed: [row(20)] }));
  const chips = [...html.matchAll(/<span class="chip ([^"]*)" role="status">([^<]*)<\/span>/g)];
  eq(chips.length, rows.length + 1);
  for (const [, cls, text] of chips) {
    ok(text.trim().length > 2, `chip text: ${cls}`);
    ok(SPEC_LABELS.includes(text), `${text} is a spec label`);
    ok(/\bt-(neutral|info|attention|plum|risk|confirmed)\b/.test(cls), `tone class: ${cls}`);
  }
  for (const li of (/<ul class="counts">([\s\S]*?)<\/ul>/.exec(html)![1].match(/<li[\s\S]*?<\/li>/g) ?? [])) ok(/<b>\d+<\/b> [A-Z]/.test(li), li);
  ok(/\.chip::before\{content:""/.test(DESIGN_CSS), "a dot marks the chip as a status, with the word beside it");
});

Deno.test("design: Apply stays solid black with class apply and hash-bound fields; plum never fills it; Select and links are plum", () => {
  const html = renderResults(feed([row(1, { tag: "b".repeat(16) }), row(2, { tag: "c".repeat(16) })]));
  eq((html.match(/<button type="submit" class="apply" aria-label="Apply to /g) ?? []).length, 2);
  ok(/<input type="hidden" name="tag" value="b{16}">/.test(html) && /name="action" value="apply"/.test(html), "hash-bound one-tap fields unchanged");
  ok(/<button type="submit" class="apply">Apply to selected<\/button>/.test(html));
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
  ok(/\.results \.apply,\.things \.apply\{[^}]*border:2px solid #000;background:#000;color:#fff/.test(css), "solid black Apply");
  for (const m of css.matchAll(/([^{}]*\.apply[^{}]*)\{([^}]*)\}/g)) {
    if (/hover|focus-visible|disabled/.test(m[1]) || !/\.(results|things)\b/.test(m[1])) continue; // the shared .apply rule is overridden by these
    ok(!/plum|--accent|#512566/i.test(m[2].replace(/outline[^;]*;?/g, "")), `Apply rule is not plum: ${m[1]} { ${m[2]} }`);
  }
  ok(/\.pick input\{accent-color:var\(--plum-700\)\}/.test(css) && /\.results a,\.things a\{color:var\(--plum-text\)\}/.test(css));
  const things = renderThings({ token: "t", ref: "r", title: "Intern", company: "Acme", link: null, questions: [{ id: "1", label: "Q?", options: [], kind: "text" }] });
  ok(/<button type="submit" class="apply">Save answers<\/button>/.test(things) && /class="filehead"/.test(things) && /A few things first/.test(things) && things.includes(DESIGN_FONT_LINK));
});

Deno.test("design: file header, role card anatomy and the bottom action bar (3.5, 3.10)", () => {
  const html = renderResults(feed([row(1, { tag: "d".repeat(16), why: ["You listed React and TypeScript."], payNote: "the range starts below $30/hr" }), row(2, { blocked: "it would be sent to LinkedIn." })], { madeFor: "Made for Ada · Nov 2, 2026", quick: ["Next: tap Apply.", "Best match: Role 1."] }));
  ok(/<header class="filehead"><p class="kicker">Roles file<\/p>/.test(html) && /<section class="top"/.test(html), "kicker, serif title, counts inside the header");
  const card = html.split('<li class="card"')[1];
  ok(/^[^>]*id="r-ref1"><p class="state"><span class="rid">R-01<\/span><span class="chip/.test(card), "mono id and the state chip lead the card");
  ok(card.indexOf('class="title"') > card.indexOf('class="chip') && card.indexOf('class="facts"') > card.indexOf('class="title"') && card.indexOf('class="fit"') > card.indexOf('class="facts"'));
  ok(/<div class="fit"><p><b>Why it fits:<\/b> You listed React and TypeScript\.<\/p><p class="gap"><b>Gap:<\/b> Pay: the range starts below \$30\/hr\.<\/p><\/div>/.test(card), "one reason and a visible gap, nothing invented");
  ok(/border-left:4px solid var\(--plum-600\)/.test(DESIGN_CSS) && /\.fit\{[^}]*background:var\(--plum-50\)/.test(DESIGN_CSS));
  ok(/Requisition ID<\/dt><dd>Not listed/.test(card) && /Check time unknown/.test(card), "unknown fields say so in words");
  ok(/View role on boards\.example\.test/.test(card) && /class="ghost small"[^>]*>Dismiss</.test(card), "ghost overflow: View role / Dismiss");
  const bar = /<div class="actionbar"[\s\S]*?<\/div><\/div>/.exec(html)![0];
  ok(/Apply to selected/.test(bar) && /class="ghost danger">Pause on this page/.test(bar), "main action and the danger-style pause in the bar");
  ok(/\.actionbar\{position:fixed;[^}]*bottom:0/.test(DESIGN_CSS));
  // The blocked role is listed, in its own words, and has no Apply.
  const blocked = html.split('<li class="card"')[2];
  ok(/Blocked/.test(blocked) && !/class="apply"/.test(blocked) && /Not offered: it would be sent to LinkedIn/.test(blocked));
  // Paused: the bar offers no Pause and no Apply to selected.
  const paused = renderResults(feed([row(1, { tag: "d".repeat(16) })], { paused: true }));
  ok(!/Pause on this page<\/button>/.test(paused) && !/Apply to selected/.test(paused) && /Resume/.test(paused));
});

Deno.test("design: phone layout at class level (360px): one column, 14px page padding, 14px card radius, 11px buttons, 44px hit areas, no fixed widths over 360", () => {
  ok(/\.wrap:has\(>\.results\)[^{]*\{padding-left:calc\(14px/.test(DESIGN_CSS));
  ok(/\.card\{[^}]*border-radius:14px;padding:12px/.test(DESIGN_CSS) && /\.ghost\{border-radius:11px/.test(DESIGN_CSS) && /\.results \.apply,\.things \.apply\{border-radius:11px/.test(DESIGN_CSS));
  ok(/\.ghost\{[^}]*min-height:44px/.test(DESIGN_CSS) && /\.ghost\.small\{[^}]*min-height:44px/.test(DESIGN_CSS));
  ok(/\.chip\{[^}]*font-size:12\.5px/.test(DESIGN_CSS) && /\.card \.ttl \.title\{font-size:17\.5px/.test(DESIGN_CSS) && /\.filehead h1\{[^}]*font-size:24px/.test(DESIGN_CSS));
  ok(/overflow-wrap:anywhere/.test(DESIGN_CSS));
  const css = renderResults(feed([row(1)]));
  for (const m of css.matchAll(/(?:^|[;{\s])(?:min-width|width):(\d+)px/g)) ok(Number(m[1]) <= 360, `fixed width ${m[0]}`);
  ok(!/grid-template-columns:[^;}]*\d{3,}px/.test(css.replace(/minmax\(0,38%\)/g, "")), "no wide fixed grid column");
  ok(/ul\.cards\{[^}]*flex-direction:column/.test(css), "one column");
});
