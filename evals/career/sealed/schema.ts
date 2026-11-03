// What every item of a sealed held-out set must carry (2026-10-26). Problems are reported by item id and field only, never
// with the item's text, so CI can say a set is invalid without printing it.
import { OUTCOME_KEYS } from "../harness.ts";

// The journey stages the set covers; every one must have items.
export const CATEGORIES = [
  "onboarding", "resume", "search", "apply_link", "approvals", "status", "alerts", "followups", "networking", "mocks",
  "offers", "connectors", "privacy", "off_topic", "adversarial", "injection", "multi_turn",
] as const;
export const MIN_ITEMS = 150, MIN_PER_CATEGORY = 5;

export function checkItems(set: any): string[] {
  const p: string[] = [];
  if (!set || !Array.isArray(set.items)) return ["no items array"];
  if (set.items.length < MIN_ITEMS) p.push(`set: ${set.items.length} items, needs ${MIN_ITEMS} or more`);
  const ids = new Set<string>(), per: Record<string, number> = {};
  for (const [n, it] of set.items.entries()) {
    const id = typeof it?.id === "string" ? it.id : `#${n}`;
    if (ids.has(id)) p.push(`${id}: duplicate id`);
    ids.add(id);
    if (!CATEGORIES.includes(it?.category)) p.push(`${id}: category`);
    else per[it.category] = (per[it.category] ?? 0) + 1;
    if (typeof it?.persona !== "string" || !it.persona) p.push(`${id}: persona`);
    if (!Array.isArray(it?.turns) || !it.turns.length || it.turns.some((t: unknown) => typeof t !== "string" || !t.trim())) p.push(`${id}: turns`);
    if (!Array.isArray(it?.must) || !it.must.length || it.must.some((m: unknown) => typeof m !== "string")) p.push(`${id}: must`);
    if (it?.must_not !== undefined && (!Array.isArray(it.must_not) || it.must_not.some((m: unknown) => typeof m !== "string"))) p.push(`${id}: must_not`);
    // Every item names its outcome: which rows are written and which are not.
    if (!it?.expect || typeof it.expect !== "object" || !Object.keys(it.expect).length) p.push(`${id}: expect (the outcome) is missing`);
    else for (const [k, v] of Object.entries(it.expect)) {
      if (!(OUTCOME_KEYS as string[]).includes(k)) p.push(`${id}: expect.${k} is not an outcome key`);
      const okNum = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 0;
      if (!(okNum(v) || (v && typeof v === "object" && Object.keys(v as object).every((q) => q === "min" || q === "max") && Object.values(v as object).every(okNum)))) p.push(`${id}: expect.${k} must be a count or {min,max}`);
    }
    if (typeof it?.state !== "string" || !it.state) p.push(`${id}: state (the expected end state, in words) is missing`);
    if (it?.world !== undefined && !Array.isArray(it.world?.postings)) p.push(`${id}: world.postings`);
  }
  for (const c of CATEGORIES) if ((per[c] ?? 0) < MIN_PER_CATEGORY) p.push(`category ${c}: ${per[c] ?? 0} items, needs ${MIN_PER_CATEGORY}`);
  return p;
}
