// D-070 (live-7 C9, C23; real-set item 10: 9 of 20 companies "no_sources" after 5 to 11 rich pages were read): the research draft
// is the model's JSON. A draft that reached the call's token limit ended mid-string, JSON.parse threw, and the whole draft was read
// as {}: every sourced line the model had already written was lost, and the brief said no page "stated anything the brief could
// quote". A draft is now read as far as it is complete: the whole JSON when it parses; otherwise the longest prefix that ends on a
// complete value, with its open arrays and objects closed. Nothing is invented or completed: a cut-off item is left out, and every
// kept item still passes the same guard (its quote on its page, the claim saying what the quote says).
export type DraftParse = { value: any | null; how: "whole" | "salvaged" | "failed" };

const strip = (raw: string) => String(raw ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");

export function parseDraft(raw: string): DraftParse {
  const t = strip(raw);
  try { return { value: JSON.parse(t), how: "whole" }; } catch { /* below */ }
  // Prose before the JSON ("Here is the brief:") or after it: the object itself.
  const at = t.indexOf("{");
  if (at < 0) return { value: null, how: "failed" };
  const s = t.slice(at);
  try { return { value: JSON.parse(s), how: "whole" }; } catch { /* below */ }
  try { const end = s.lastIndexOf("}"); if (end > 0) return { value: JSON.parse(s.slice(0, end + 1)), how: "whole" }; } catch { /* below */ }
  // Scan once: after each closing bracket (outside a string), the stack of brackets still open. Cutting there and closing the
  // rest gives a candidate; the longest one that parses is the draft as far as it is complete.
  const cuts: { end: number; open: string }[] = [];
  const stack: string[] = [];
  let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      stack.pop();
      if (!stack.length) break;
      cuts.push({ end: i + 1, open: stack.map((b) => (b === "{" ? "}" : "]")).reverse().join("") });
    }
  }
  for (let k = cuts.length - 1, tries = 0; k >= 0 && tries < 400; k--, tries++) {
    const { end, open } = cuts[k];
    try {
      const v = JSON.parse(s.slice(0, end) + open);
      if (v && typeof v === "object" && !Array.isArray(v)) return { value: v, how: "salvaged" };
    } catch { /* an earlier cut */ }
  }
  return { value: null, how: "failed" };
}

// The page text and a quote, read alike: a reference marker ("[12]", "[a]", "[citation needed]", "[edit]") is not part of the
// sentence it sits in, and a typographic dash, a non-breaking space or a curly quote is the plain one. Wikipedia's "Coinbase is an
// American company[1] that operates" is quoted as "Coinbase is an American company that operates" and is on the page.
export function readAlike(s: string): string {
  return String(s ?? "").normalize("NFC")
    .replace(/\[(?:\d{1,3}|[a-z]{1,2}|citation needed|edit|note \d+|nb \d+)\]/gi, "")
    .replace(/[   ]/g, " ").replace(/[‐-―−]/g, "-").replace(/[“”«»„]/g, '"').replace(/[‘’‚′]/g, "'").replace(/…/g, "...")
    .replace(/\s+([,.;:!?])/g, "$1");
}

// D-070: the draft call's output cap. At 1,800 tokens a brief from rich pages (Wikipedia, a 10-K, the company's own pages) ran
// out mid-item; the parse above keeps what was complete, and the cap leaves room for the whole draft. Billed as used, not as
// capped: at most 4,000 output tokens is $0.04 a draft at $10 per million (README of evals/real-sets/research).
export const RESEARCH_DRAFT_MAX_TOKENS = 4000;
