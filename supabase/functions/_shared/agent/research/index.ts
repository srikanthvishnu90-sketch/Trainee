// The open-question pipeline (flag CAREER_KNOWLEDGE): understand -> ground -> write -> guard. One call per question:
//   understand  Person Context Pack + message -> field, stage, place, question type, at most ONE question (understand.ts)
//   ground      cached, capped OpenAI web search -> guard-accepted facts with URLs (ground.ts, guard.ts)
//   write       the research brief file, built from those facts, labelled general knowledge and the person's own facts (brief.ts)
//   guard       any number or name no source accounts for is dropped by code; the chat paragraph is linted (chat.ts)
// The brief is delivered through `publish`: in production file_publisher.ts files it as #280's `research_brief` kind. Without
// `publish` the markdown is returned for the caller and the reply carries no link.
import { buildContextPack, type PackInput } from "../knowledge/context_pack.ts";
import { composeBrief } from "./brief.ts";
import { groundFor, type Fact, type GroundCache, type GroundSearch } from "./ground.ts";
import { understand } from "./understand.ts";
import type { DeriveFn } from "./derive.ts";
import { unsourcedIn } from "./guard.ts";

// Where the finished brief goes. PR #280's file kind plugs in here by implementing this one function (kind "research_brief");
// nothing else in this pipeline changes. The link is inserted into the chat reply by code (reply.ts), never by the model.
export interface BriefFile { name: string; kind: "research_brief"; subject: string; markdown: string }
export type Publisher = (file: BriefFile) => Promise<{ url: string }>;
export interface ResearchDeps { search: GroundSearch; cache?: GroundCache; publish?: Publisher; derive?: DeriveFn; onResult?: (r: ResearchResult, message: string) => void }
export type ResearchResult =
  | { status: "need_field"; ask: string; note: string }
  | { status: "ok"; brief_markdown: string; file_name: string; file_url: string | null; verdict: { now: string; later: string }; first_action: string; ask: string | null; assumptions: string[];
      sources: { n: number; url: string; label: string }[]; grounding: { searches: number; cost_usd: number; from_cache: boolean }; unsourced: string[]; dropped: string[]; note: string; facts: Fact[]; person: string[] };

export async function researchCareerQuestion(o: PackInput & { deps: ResearchDeps; now: number }): Promise<ResearchResult> {
  const pack = buildContextPack(o);
  let u = understand({ pack, message: o.message });
  // Not in the catalog: the model names the occupation from the question and the confirmed facts; code validates it.
  if (!u.field && o.deps.derive) {
    const confirmed = [...u.confirmed];
    u = understand({ pack, message: o.message, derived: await o.deps.derive({ question: o.message, confirmed }).catch(() => null) });
  }
  if (!u.field) return { status: "need_field", ask: u.ask!, note: "Ask this one question and nothing else; research starts once the field is known." };
  const g = await groundFor({ u, search: o.deps.search, cache: o.deps.cache, now: o.now });
  const today = new Date(o.now).toISOString().slice(0, 10);
  const b = composeBrief({ u, g, message: o.message, today });
  const person = [...u.confirmed, ...u.said, today, u.field.label];
  const unsourced = unsourcedIn(b.markdown, { facts: g.facts, person, message: o.message });
  const file_name = `${u.field.id}-plan-${today}.md`;
  let file_url: string | null = null;
  if (o.deps.publish) { try { file_url = (await o.deps.publish({ name: file_name, kind: "research_brief", subject: u.field.label, markdown: b.markdown })).url; } catch (e) { console.error("research brief publish:", e instanceof Error ? e.message : e); } }
  const result: ResearchResult = {
    status: "ok", brief_markdown: b.markdown, file_name, file_url, verdict: { now: u.field.now, later: u.field.later }, first_action: u.field.slots.foundation, ask: u.ask, assumptions: u.assumptions,
    facts: g.facts, person, sources: b.sources, grounding: { searches: g.searches, cost_usd: g.cost_usd, from_cache: g.from_cache }, unsourced, dropped: b.dropped,
    note: "Reply with ONE short plain paragraph (about 60 to 90 words, no list, no heading, no opener): first the honest verdict for this person (what is realistic now, then what comes later, with the one timing fact that matters most for their stage if the brief has it), in your own words, using only their facts and the verdict above; then ONE concrete thing to do this week (the first action: " + u.field.slots.foundation.replace(/\.$/, "") + "); then say the full plan, timeline and honest odds are in the file" +
      (file_url ? ", and write NO link: code adds the file link after your paragraph" : " (the file is not attached in this environment: do not mention a file or a link, give the verdict and the first action only)") +
      ". Put no figure, date or name in the paragraph that is not in the brief's sourced lines; where the brief says it found no sourced figure, say plainly that you do not know it rather than guessing. " + (u.ask ? `You may end with this one question: ${u.ask}` : "Ask nothing."),
  };
  o.deps.onResult?.(result, o.message);
  return result;
}
