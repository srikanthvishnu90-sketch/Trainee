// The knowledge and context layer for the agent brain (flag CAREER_KNOWLEDGE=on, off by default): the Person Context Pack
// plus the 1 to 3 situation playbooks that fit it, as one block for the system prompt. Method only: playbooks never carry
// real companies, pay, dates or statistics (the lint test enforces it); those come from tools or are said to be unverified.
import { buildContextPack, contextPackBlock, type ContextPack, type PackInput } from "./context_pack.ts";
import { PLAYBOOKS } from "./playbooks.generated.ts";
import type { Playbook } from "./parse.ts";
import { selectPlaybooks } from "./retrieve.ts";

export const knowledgeOn = (env: { get(k: string): string | undefined }) => env.get("CAREER_KNOWLEDGE") === "on";
export const KNOWLEDGE_BUDGET = 12500;

const HOW = [
  "HOW TO USE THIS. The goal is an answer only this person could have been given: their facts named, a realistic read of their situation, concrete steps they can start this week, and one next action.",
  "The playbooks below are METHOD, written for anyone in a similar spot. Take what fits this person, drop what does not, and put it in your own words with their facts. Never paste a playbook or its headings.",
  "Playbooks name no real company, program, deadline, pay figure or statistic, and neither do you unless search_jobs, get_posting or the person gave it. Where a step needs a specific (which programs, which firms, when applications open), say how they find and verify it. You have no live outside information.",
  "Write any email or message the step calls for in full, with [brackets] for facts you lack. The person sends it; you never do. Honor \"Do not claim\" in each playbook.",
].join("\n");

function render(b: Playbook): string { return `### Playbook: ${b.id}\n${b.body}`; }

export interface Knowledge { text: string; playbooks: string[]; unknown: string[]; stage: string | null; pack: ContextPack }
export function knowledgeFor(o: PackInput, books: readonly Playbook[] = PLAYBOOKS): Knowledge {
  const pack = buildContextPack(o);
  const chosen = selectPlaybooks(pack, books);
  const core = books.find((b) => b.kind === "core");
  const parts = [contextPackBlock(pack), HOW, ...(core ? [render(core)] : [])];
  let used = parts.join("\n\n").length;
  const ids: string[] = [];
  for (const { book } of chosen) {
    const r = render(book);
    if (used + r.length + 2 > KNOWLEDGE_BUDGET) continue;
    parts.push(r); used += r.length + 2; ids.push(book.id);
  }
  return { text: parts.join("\n\n"), playbooks: ids, unknown: pack.unknown, stage: pack.stage.value, pack };
}
