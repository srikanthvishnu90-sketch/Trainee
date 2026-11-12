// D-063 (MIRROR-PROCESS C4; D-060 web research): a SPECIFIC advice question about one task ("what should I put at the very top of
// my resume", "how do I word a project with no results yet") answered the way Instinct did: the answer first, specific to the
// person's confirmed record, and ONE cited source on its own line. The open-question pipeline (index.ts) answers a different task:
// how to get into a field, as a staged plan with a brief file. The model picks which (G1: research_career_question's `kind`).
//
// One web search through the same searcher as the plan (ground.ts gatewayGroundSearch: Claude web search, the gateway's reserve,
// the never-list), cached per question like the plan's grounding. A passage stands only when the guard accepts it (guard.ts
// acceptFacts: a verbatim quote from a page the search returned); the source shown is a page with an accepted passage, chosen by
// code, and code puts its link on its own line after the model's answer (enforceAdviceReply). The model writes no link.
import { isBlockedHost } from "../../research_never.ts";
import type { ResearchDeps } from "./index.ts";
import { CACHE_TTL_MS, type Fact } from "./ground.ts";
import { acceptFacts } from "./guard.ts";
import { stripUrls } from "./reply.ts";

export const ADVICE_PASSAGES = 3;
export interface AdviceResult {
  status: "advice"; question: string; source: { url: string; label: string } | null; passages: { text: string; url: string }[];
  grounding: { searches: number; cost_usd: number; from_cache: boolean }; not_verified: string | null; note: string;
}
const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 200);
// Guides from a school, a government or a non-profit first (a university career center, a public guide), then any other page.
const rank = (url: string) => { try { const h = new URL(url).hostname; return /\.(edu|gov)$/.test(h) ? 0 : /\.org$/.test(h) ? 1 : 2; } catch { return 3; } };

export async function researchAdvice(o: { question: string; query?: string | null; deps: ResearchDeps; now: number }): Promise<AdviceResult> {
  const q = String(o.query ?? "").trim() || o.question;
  const key = `advice|${norm(q)}`;
  let facts: Fact[] = [], urls: string[] = [], searches = 0, cost = 0, fromCache = false, failed: string | null = null;
  const hit = o.deps.cache ? await o.deps.cache.get(key).catch(() => null) : null;
  if (hit && o.now - hit.at < CACHE_TTL_MS) { facts = hit.facts; urls = hit.urls; fromCache = true; }
  else {
    searches = 1;
    try {
      const out = await o.deps.search({ q, kinds: [] }, { field: "advice", stage: "", geo: "" });
      if (out.status !== "ok") failed = out.detail;
      else {
        if (out.cost_usd !== null) cost = out.cost_usd;
        facts = acceptFacts(out.facts, out.urls, { advice: true }).kept.filter((f) => !isBlockedHost(f.url));
        urls = out.urls;
        if (o.deps.cache && facts.length) await o.deps.cache.set(key, { at: o.now, facts, urls }).catch(() => {});
      }
    } catch (e) { failed = e instanceof Error ? e.message.slice(0, 120) : "search failed"; }
  }
  // One source: the best-ranked page with an accepted passage (the order the search returned breaks ties), and its passages.
  const best = [...new Set(facts.map((f) => f.url))].map((u, i) => ({ u, i })).sort((a, b) => rank(a.u) - rank(b.u) || a.i - b.i)[0]?.u ?? null;
  const mine = best ? facts.filter((f) => f.url === best).slice(0, ADVICE_PASSAGES) : [];
  const source = best ? { url: best, label: mine[0]?.label || new URL(best).hostname } : null;
  const not_verified = source ? null : failed ? "the search did not finish" : "the search found no page that states this";
  return {
    status: "advice", question: o.question, source, passages: mine.map((f) => ({ text: f.quote, url: f.url })),
    grounding: { searches, cost_usd: cost, from_cache: fromCache }, not_verified,
    note: "Answer the question itself first, in one short paragraph (about 300 to 500 characters), specific to this person: use only their confirmed facts and what they said in this conversation, each as they gave it. " +
      "If they said in this conversation that something on their resume is outdated, wrong or uncertain, name it and say to leave it off or fix it; never reuse it. Where a confirmed fact the answer needs is missing, say what to add instead of guessing. " +
      (source ? "Ground the general advice in the passages; write NO link (code puts the source's link on its own line after your answer)." : `No source could be cited (${not_verified}): say plainly in one clause that this is your own judgement, not a cited guide, and write no link.`),
  };
}

// The reply: the model's answer with every link it wrote removed, then the one source code chose, alone on its own line.
export function enforceAdviceReply(reply: string, r: AdviceResult): string {
  const body = stripUrls(String(reply ?? "")).trim();
  return r.source ? `${body}\n${r.source.url}` : body;
}
