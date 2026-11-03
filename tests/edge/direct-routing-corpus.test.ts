// The routing corpus (overnight G-hardening, 2026-10-12): ~90 realistic, sloppy asks, each pinned to the direct answer
// that must own it, or to none (it goes on to the flows or the model). It walks the handler's own order through the
// answers tests/edge/lib/direct_chain.ts exports, after the connect answer, the way handler.ts does. Every bug found
// tonight was a misroute; a new one found live gets a row in tests/edge/fixtures/direct-asks.json.
import { assertEquals } from "jsr:@std/assert@1";
import { connectReply, creditScoreReply, paperTradingReply, accountPrivacyReply, sleepReply, adviceReply, travelReply, optionsReply, notYetReply, copyReply, momentReply, termsReply, accreditedReply } from "../../supabase/functions/agent-chat/_shared/direct_answers.ts";
import { ANSWERS, ORDER } from "./lib/direct_chain.ts";
// Read as text imports so the suite runs without file permissions (the evidence recorder runs it with none).
import SRC_DIRECT_ASKS from "./fixtures/direct-asks.json" with { type: "text" };

const corpus = JSON.parse(SRC_DIRECT_ASKS);

async function owner(ask: string): Promise<string | null> {
  if (connectReply(ask)) return "connectReply";
  if (creditScoreReply(ask)) return "creditScoreReply";
  if (paperTradingReply(ask)) return "paperTradingReply";
  if (adviceReply(ask)) return "adviceReply";
  if (optionsReply(ask)) return "optionsReply";
  if (notYetReply(ask)) return "notYetReply";
  if (copyReply(ask)) return "copyReply";
  if (momentReply(ask)) return "momentReply";
  if (termsReply(ask)) return "termsReply";
  if (accreditedReply(ask, "2026-10-12")) return "accreditedReply";
  if (accountPrivacyReply(ask, "anthropic")) return "accountPrivacyReply";
  if (sleepReply(ask, { start: 22, end: 7 })) return "sleepReply";
  if (travelReply(ask, "America/New_York")) return "travelReply";
  for (const name of ORDER) if ((await ANSWERS[name](ask)) !== null) return name;
  return null;
}

Deno.test("every ask in the routing corpus reaches the answer that owns it", async () => {
  const wrong: string[] = [];
  for (const [ask, want] of corpus.asks as [string, string | null][]) {
    const got = await owner(ask);
    if (got !== want) wrong.push(`"${ask}": got ${got}, want ${want}`);
  }
  assertEquals(wrong, [], `${wrong.length} misrouted:\n${wrong.join("\n")}`);
});

// CLAUDE.md: every user-facing money statement cites its data source and as-of time. Over the whole corpus, a direct
// reply with a dollar amount names where it came from and a date.
const SOURCE = /\b(?:from your|per |as of|checked|you pasted|you told me|you said|from the (?:escrow|offer|email)|on file|linked (?:accounts|cards|history))\b/i;
const DATE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}\b/i;
Deno.test("every direct reply with a dollar amount names its source and a date", async () => {
  const bare: string[] = [];
  for (const [ask] of corpus.asks as [string, string | null][]) {
    if (connectReply(ask)) continue;
    let reply: string | null = null;
    for (const name of ORDER) { reply = await ANSWERS[name](ask); if (reply) break; }
    if (reply && /\$\d/.test(reply) && !(SOURCE.test(reply) && DATE.test(reply))) bare.push(`"${ask}": ${reply.slice(0, 160)}`);
  }
  assertEquals(bare, [], `${bare.length} without a source and date:\n${bare.join("\n")}`);
});
