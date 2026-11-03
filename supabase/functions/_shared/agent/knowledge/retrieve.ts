// Pick the 1 to 3 playbooks that fit this person and this message. Deterministic: the same pack gives the same playbooks.
// A playbook is eligible when one `when` item holds (an item "a+b" needs both signals). Its score is the weight of the best
// item (message 6, confirmed fact 5, earlier chat 4; a pair counts as its weaker half plus 1, being more specific), plus 1
// per `boost` signal present, plus 3 for an emotional playbook the message itself calls for. At most one stage playbook and
// one emotional playbook; ties break by kind order, then id.
import type { ContextPack } from "./context_pack.ts";
import type { Playbook, PlaybookKind } from "./parse.ts";

const KIND_ORDER: PlaybookKind[] = ["emotional", "situation", "employer", "context", "stage", "method", "interview", "offer", "core"];
export const MAX_PLAYBOOKS = 3, MIN_SCORE = 4;

export function scorePlaybook(b: Playbook, weights: Record<string, number>): number {
  let best = 0;
  for (const item of b.when) {
    const parts = item.split("+");
    const ws = parts.map((p) => weights[p] ?? 0);
    if (ws.some((w) => w === 0)) continue;
    best = Math.max(best, parts.length > 1 ? Math.min(...ws) + 1 : ws[0]);
  }
  if (!best) return 0;
  const boost = b.boost.filter((s) => (weights[s] ?? 0) > 0).length;
  const distress = b.kind === "emotional" && b.when.some((w) => (weights[w] ?? 0) >= 6) ? 3 : 0;
  return best + boost + distress;
}

export function selectPlaybooks(pack: ContextPack, books: readonly Playbook[], k = MAX_PLAYBOOKS): { book: Playbook; score: number }[] {
  const scored = books.filter((b) => b.kind !== "core")
    .map((b) => ({ book: b, score: scorePlaybook(b, pack.weights) }))
    .filter((s) => s.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || KIND_ORDER.indexOf(a.book.kind) - KIND_ORDER.indexOf(b.book.kind) || a.book.id.localeCompare(b.book.id));
  const out: { book: Playbook; score: number }[] = [];
  const seen = new Set<PlaybookKind>();
  for (const s of scored) {
    if (out.length >= k) break;
    if ((s.book.kind === "stage" || s.book.kind === "emotional") && seen.has(s.book.kind)) continue;
    seen.add(s.book.kind);
    out.push(s);
  }
  return out;
}
