// HOW APPROVAL WORKS, as the brain is told it: one source of truth, built from the code that enforces it (benchmark gap #8, C12:
// "a smaller first batch they approve one by one" came from a turn note written in prose, and contradicted D-MS-1). Every
// sentence the brain reads about approving applications or messages comes from APPROVAL_RULES below; each rule names the code
// that makes it true, and its numbers are read from that code, so a change there changes what the brain says. Instructions and
// facts for the model, never reply text: the model writes every word of its reply.
import { YES_WINDOW_MS } from "../career_apply_cards.ts";

export interface ApprovalRules {
  // D-MS-1: a texted yes approves exactly the applications the card shows, in one call to the batch approval.
  batchYes: true;
  // D-MS-1: each item stays bound to the hash of its exact payload; one that changed since it was shown is refused by name.
  payloadBound: true;
  // D-MS-1: "yes except 3", "only 1, 2 and 5" approve the stated subset.
  subsets: true;
  // D-MS-1 / D-031: how long after the card was shown a texted yes still counts (career_apply_cards.ts YES_WINDOW_MS).
  yesWindowMinutes: number;
  // D-MS-2 / D-R9-2: the card is paged for reading, and one yes covers every page.
  onePagedCard: true;
  // D-R9-2: a yes approves a paged card only once every page of it was delivered (career_apply_cards.ts answers
  // card_pages_undelivered with nothing approved; migration 20261108100000 raises it).
  allPagesDelivered: true;
  // D-MN-2: the same rule for emails and messages: one yes approves exactly the batch of messages shown.
  messagesSameRule: true;
  // D-041 / D-077: nothing is submitted or sent without a confirmed resume and that yes; the receipt is the proof (D-024).
  receiptIsProof: true;
}

export const APPROVAL_RULES: Readonly<ApprovalRules> = Object.freeze({
  batchYes: true,
  payloadBound: true,
  subsets: true,
  yesWindowMinutes: Math.round(YES_WINDOW_MS / 60_000),
  onePagedCard: true,
  allPagesDelivered: true,
  messagesSameRule: true,
  receiptIsProof: true,
});

// The block the brain reads on every turn (career_brain.ts puts it in the system prompt). Built from APPROVAL_RULES only.
export function approvalRulesText(r: Readonly<ApprovalRules> = APPROVAL_RULES): string {
  return [
    "HOW APPROVAL WORKS IN TRAINEE (from the code that enforces it; when you explain approving, say it this way and never otherwise):",
    r.batchYes ? "- Applications are approved as a batch: Trainee shows one card listing every prepared application, and one yes approves exactly the applications that card shows. It is never one approval per application, and never a yes for anything the card does not show." : "",
    r.subsets ? "- They can approve part of a card in the same reply (\"yes except 3\", \"only 1, 2 and 5\"); an unclear reply approves nothing." : "",
    r.payloadBound ? "- Each application is bound to its exact contents as shown; one that changed after it was shown is not submitted, and the rest go on." : "",
    `- A texted yes counts for ${r.yesWindowMinutes} minutes after the card is shown, once.`,
    r.onePagedCard ? "- A long batch is shown as one card in pages, and one yes covers every page." : "",
    r.allPagesDelivered ? "- A paged card can be approved only once every page of it has reached them; until then a yes approves nothing." : "",
    r.messagesSameRule ? "- Emails and messages work the same way: one yes approves exactly the batch of messages shown." : "",
    r.receiptIsProof ? "- Nothing is submitted or sent without a confirmed resume and that yes; each submission ends with its receipt, and only a receipt says it went." : "",
  ].filter(Boolean).join("\n");
}

// Wording of approval that contradicts the rules above (C12, and the review of f7abd6c30): an approval said to be per application
// or per card, one at a time ("approve each card", "each application goes only on their approval", "one by one").
export const PER_ITEM_APPROVAL = /\bapprov\w*\b[^.?!\n]{0,60}\b(?:one by one|one at a time|individually|each (?:one|application|card) (?:separately|on its own))\b|\b(?:one by one|one at a time|individually)\b[^.?!\n]{0,40}\bapprov\w*|\bapprov\w* (?:each|every) (?:card|application)\b|\b(?:each|every) (?:application|card) goes only (?:on|after) (?:their|your) approval\b|\b(?:each|every|it) goes only after (?:they|you) approve (?:its|that|the) card\b/i;
