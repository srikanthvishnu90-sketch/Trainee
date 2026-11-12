// D-072 (files writers): compare_paths, the chat's writer of the F-03 Path comparison record (career_path_comparisons.ts). When the
// person compares paths they are weighing ("consulting at Deloitte or product management?", "the Evercore offer or grad school"),
// the model names each path and quotes the person's own words for it from THIS message; code refuses a path whose words the person
// did not write (D-007), builds each direction's rows from their own records (career_path_comparisons.ts directionOf: what they
// said, the confirmed facts that relate, an offer they told Trainee about), and writes the comparison as a new version. Nothing is
// predicted (no odds, reach or timing). The File is opened with open_record_file path_comparison; this tool makes no link.
import { CareerProfile } from "../router_core.career.js";
import { type ConfirmedFact, directionOf, type OfferSaid, type PathStore, writePathComparison } from "../career_path_comparisons.ts";
import type { ToolSpec } from "./loop.ts";

export const PATH_TOOL = "compare_paths";
const clean = (s: unknown, n = 160) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
// The person's own words: the quoted phrase appears in this message, word for word (case and punctuation aside).
const plain = (s: unknown) => String(s ?? "").toLowerCase().replace(/[\u2019']/g, "").replace(/[^a-z0-9$%]+/g, " ").trim();
const saidIn = (message: string, words: string) => { const w = plain(words); return !!w && ` ${plain(message)} `.includes(` ${w} `); };
const money = (n: unknown) => typeof n === "number" && n > 0 ? `$${Math.round(n).toLocaleString("en-US")}` : null;

export function pathComparisonTool(store: PathStore): ToolSpec {
  return {
    name: PATH_TOOL, effect: "write_own",
    description: "Use when the person compares 2 to 4 paths they are weighing (offers, tracks, fields, staying or leaving). Give each path's short name and the person's own words for it, "
      + "copied exactly from THIS message (a path they did not write is refused). Code saves the comparison to their Path comparison File with what they said, the confirmed facts of "
      + "their record that relate, and any offer they told you about; it predicts nothing. Talk through the paths from the result's rows only; to give them the page, call "
      + "open_record_file with path_comparison.",
    input_schema: {
      type: "object", required: ["paths"],
      properties: {
        title: { type: "string", description: "A short title, e.g. 'Consulting vs product management'" },
        paths: { type: "array", minItems: 2, maxItems: 4, description: "The paths, in the order they named them",
          items: { type: "object", required: ["name", "said"], properties: { name: { type: "string", description: "Short name, e.g. 'Consulting at Deloitte'" }, said: { type: "string", description: "Their exact words for this path, from this message" } } } },
      },
    },
    run: async (i, c) => {
      const message = c.turn?.message ?? "";
      const paths = (Array.isArray(i?.paths) ? i.paths : []).map((p: { name?: unknown; said?: unknown }) => ({ name: clean(p?.name, 80), said: clean(p?.said, 240) }));
      if (paths.length < 2 || paths.length > 4) throw new Error("not saved: give 2 to 4 paths the person named");
      const unsaid = paths.filter((p: { name: string; said: string }) => !p.name || !p.said || !saidIn(message, p.said));
      if (!c.turn || unsaid.length) throw new Error(`not saved: each path must be the person's own words from this message (${unsaid.map((p: { said: string }) => `"${p.said}"`).join(", ") || "none given"}); ask them which paths they are weighing`);
      // deno-lint-ignore no-explicit-any
      const facts: ConfirmedFact[] = (CareerProfile.confirmedFacts((c.state.profile as any) ?? {}) as any[]).filter((f) => f && f.status !== "draft")
        .map((f) => ({ title: clean(String(f.title || f.text || "").split("\n")[0], 90), text: clean(f.text, 400) })).filter((f) => f.title);
      // deno-lint-ignore no-explicit-any
      const offers: OfferSaid[] = (Array.isArray((c.state.offerBenchmark as any)?.offers) ? (c.state.offerBenchmark as any).offers : []).filter((o: any) => o?.offer && typeof o.at === "number")
        // deno-lint-ignore no-explicit-any
        .map((o: any) => ({ company: clean(o.offer.company, 60), at: o.at,
          terms: [clean(o.offer.role, 60), money(o.offer.base) ? `base ${money(o.offer.base)}` : null, money(o.offer.signing) ? `signing ${money(o.offer.signing)}` : null].filter(Boolean).join(", ") || "terms not stated" }));
      const at = new Date(c.now).toISOString();
      const directions = paths.map((p: { name: string; said: string }, k: number) => directionOf(String.fromCharCode(65 + k), p, facts, offers, at));
      const title = clean(i?.title, 120) || directions.map((d: { name: string }) => d.name).join(" vs ").slice(0, 120);
      const version = await writePathComparison(store, c.userId, { title, directions, said: message, confirmed_facts: facts.length });
      return { saved: true, version, title, confirmed_facts: facts.length,
        directions: directions.map((d: { letter: string; name: string; evidence: string; related: number; rows: { k: string; v: string | null; missing?: string }[] }) => ({ letter: d.letter, name: d.name, evidence: `${d.evidence} (${d.related} related confirmed fact${d.related === 1 ? "" : "s"})`, rows: d.rows.map((r) => `${r.k}: ${r.v ?? r.missing ?? "Unknown"}`) })),
        note: "Saved to their Path comparison. Nothing here predicts odds, reach or timing; say only what the rows hold." };
    },
  };
}
