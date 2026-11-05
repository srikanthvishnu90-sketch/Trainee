// BETA C04 (2026-11-04): the offer paths (career_offer.ts offerTurn, career_offer_chat.ts offerChatTurn) draft a counter
// that answers "should I counter?" directly, says when it stands on judgment rather than a sourced number, raises the
// package terms nobody stated, keeps an hourly offer in hourly terms, never asks for the offer's own figure or less, and
// never uses a placeholder for the role or the employer. Nothing is sent: the card is held for approval of its exact text.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/edge/career-offer-counter-c04.test.ts
import assertNode from "node:assert/strict";
import { offerChatTurn } from "../../supabase/functions/_shared/career_offer_chat.ts";
import { counterAnswer, offerTurn } from "../../supabase/functions/_shared/career_offer.ts";
import { CareerNegotiation } from "../../supabase/functions/_shared/router_core.career.js";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const NOW = Date.UTC(2026, 10, 4, 16);
const PLACEHOLDER = /\bthe firm\b|\[[^\]]*\]|\brole role\b|\bRole offer\b/i;

Deno.test("C04/O1 counterAnswer: a direct answer on what it stands on, the package terms, no promise", () => {
  const none = counterAnswer({ base: 49920 }, null).join("\n");
  assert(/^Should you counter\? In my judgment, yes/.test(none) && /judgment, not market data/.test(none), none);
  assert(/benefits/.test(none) && /schedule/.test(none) && /start date/.test(none), none);
  assert(/can't promise/.test(none), none);
  const above = counterAnswer({ base: 90000 }, { median: 120000, cite: "BLS OEWS May 2025" }).join("\n");
  assert(/Yes, once, in writing: BLS OEWS May 2025 puts the median at \$120,000/.test(above), above);
  const below = counterAnswer({ base: 130000 }, { median: 120000, cite: "BLS OEWS May 2025" }).join("\n");
  assert(/On pay alone, probably not/.test(below), below);
  const comp = counterAnswer({ base: 95000, competing: [{ company: "Citi", base: 105000 }] }, null).join("\n");
  assert(/other offer you told me about \(Citi\) has a base of \$105,000/.test(comp), comp);
});

Deno.test("C04/O2 factScript: an hourly offer is restated and asked in hourly terms, never at the offer or below", () => {
  const s = (CareerNegotiation as any).factScript({ company: "Acme", role: null, base: 24 * 2080, hourly: 24 }, { benchmark: { median: 60000, cite: "A test citation" } });
  assert(/Subject: Your offer, Acme/.test(s.email) && !PLACEHOLDER.test(s.email), s.email);
  assert(/with \$24 an hour/.test(s.email), s.email);
  assert(/Could you bring the rate closer to \$28\.85 an hour\?/.test(s.email), s.email);
  assert(/A test citation shows a median of \$60,000 a year, about \$28\.85 an hour at 2,080 hours\./.test(s.email), s.email);
  const flat = (CareerNegotiation as any).factScript({ company: "Acme", base: 24 * 2080, hourly: 24 }, { benchmark: { median: 40000, cite: "A test citation" } });
  assert(!/\$24(\.00)? an hour\?/.test(flat.email) && /flexibility on the hourly rate/.test(flat.email), flat.email);
  eq(s.sends, false);
});

Deno.test("C04/O3 offerTurn and offerChatTurn: the answer and the terms lead the held counter", async () => {
  const r = offerTurn({ words: "JPM offered 110k base, 15k signing, NYC, analyst", pending: null, now: NOW }).result;
  const all = r.messages.join("\n");
  assert(/Should you counter\?/.test(all) && /benefits/.test(all), all);
  eq(r.draft!.sent, false);
  const c = await offerChatTurn({ message: "Acme offered me $150k as a product manager in Denver. Help me negotiate", state: null, now: NOW });
  const reply = c.answer!.reply;
  assert(/Should you counter\?/.test(reply) && /start date/.test(reply), reply);
  assert(!PLACEHOLDER.test(c.answer!.card!.body), c.answer!.card!.body);
  eq(c.answer!.card!.sent, false);
  eq(c.answer!.card!.requires_approval, true);
});
