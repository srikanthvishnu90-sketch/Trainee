// R10 spec C.2 (D-049): a research brief or an application record the model made this turn is answered as its File card. create_file
// (and the market research publisher) record each File code made as { kind, title, url }; the turn carries them (fileCards); the
// handler builds the card from the first brief or record (cardFromTurnFiles) and that File's link is not also sent as a bare link.
// A comparison or a draft keeps its link as before; a tailored resume is a document and never a card. No network, no model.
import assert from "node:assert/strict";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { createFileTool } from "../../supabase/functions/_shared/agent/file_tool.ts";
import { runAgentTurn } from "../../supabase/functions/_shared/agent/loop.ts";
import { KIND_LABEL } from "../../supabase/functions/_shared/file_kinds.ts";
import { cardFromTurnFiles, withFileCard } from "../../supabase/functions/_shared/file_card_reply.ts";

const U = "11111111-1111-4111-8111-111111111111", NOW = Date.parse("2026-11-09T15:40:00Z");
const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-0123456789-abcdef", TRAINEE_FILE_BASE_URL: "https://trainee.example/file" };
const BRIEF = { title: "Example Co research", subject: "Example Co", findings: [{ label: "Product", value: "Pricing analytics software", source: "Reported, not verified" }, { label: "Open role", value: "Data Analyst, Austin TX", source: "From the posting" }],
  sources: [{ title: "Example Co about page", url: "https://example.com/about" }] };
const COMPARISON = { title: "Acme vs Globex", options: [{ name: "Acme" }, { name: "Globex" }], rows: [{ label: "Base pay", cells: [{ value: "$90k", source: "From the posting" }, { value: "$95k", source: "Reported, not verified" }] }] };
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const use = (name: string, input: unknown) => ({ content: [{ type: "tool_use", id: "t1", name, input }], stop_reason: "tool_use" });
async function turn(kind: string, data: unknown, message: string) {
  const svc = createFileService({ store: memoryFileStore(), env: { get: (k) => ENV[k] }, now: () => NOW });
  let i = 0;
  const script = [use("create_file", { kind, data }), text("Here it is.")];
  // deno-lint-ignore no-explicit-any
  return await runAgentTurn({ system: "s", message, history: [], tools: [createFileTool(svc)], ctx: { userId: U, threadId: "th", now: NOW, state: {} }, model: async () => script[Math.min(i++, 1)] as any }) as any;
}

Deno.test("C.2 card files: create_file records the File code made as { kind, title, url }, and a research brief becomes the card", async () => {
  const r = await turn("research_brief", BRIEF, "research Example Co for me: it sells Pricing analytics software and has a Data Analyst, Austin TX opening (Example Co about page, https://example.com/about)");
  assert.equal(r.fileCards?.length, 1); assert.equal(r.fileCards[0].kind, "research_brief"); assert.equal(r.fileCards[0].title, "Example Co research");
  assert.equal(r.fileCards[0].url, r.fileLinks[0], "the card carries the same signed link code minted");
  const src = cardFromTurnFiles(r.fileCards, KIND_LABEL, NOW)!;
  assert.equal(src.kicker, KIND_LABEL.research_brief); assert.equal(src.title, "Example Co research"); assert.equal(src.url, r.fileLinks[0]);
  const tg = withFileCard({ channel: "telegram", reply: r.reply, parts: null, src }, { now: NOW, tz: "America/Chicago" });
  assert.ok(tg.card && tg.card.url === r.fileLinks[0]); assert.doesNotMatch(tg.reply, /https?:/);
  assert.match(tg.card.text, new RegExp(`^${KIND_LABEL.research_brief.toUpperCase()}\\nExample Co research\\nUpdated Today 9:40 AM CT\\n`));
  const wa = withFileCard({ channel: "whatsapp", reply: r.reply, parts: null, src }, { now: NOW, tz: "America/Chicago" });
  assert.ok(wa.parts.at(-1)!.endsWith(`\n${r.fileLinks[0]}`)); assert.equal((wa.reply.match(/https:\/\//g) ?? []).length, 1);
});

Deno.test("C.2 card files: an application record is carded; a comparison or a draft keeps its link; no File, no card", () => {
  const url = "https://trainee.example/file?t=v1.a.b";
  assert.equal(cardFromTurnFiles([{ kind: "application_proof", title: "Application to Example Co", url }], KIND_LABEL, NOW)?.kicker, KIND_LABEL.application_proof);
  for (const kind of ["comparison", "draft", "introduction", "plan_review"]) assert.equal(cardFromTurnFiles([{ kind, title: "t", url }], KIND_LABEL, NOW), null, kind);
  assert.equal(cardFromTurnFiles([], KIND_LABEL, NOW), null); assert.equal(cardFromTurnFiles(undefined, KIND_LABEL, NOW), null);
  assert.equal(cardFromTurnFiles([{ kind: "research_brief", title: "t", url: "http://evil.example" }], KIND_LABEL, NOW), null, "https only");
});

Deno.test("C.2 card files: a comparison made by create_file is recorded too, but is not a card kind", async () => {
  const r = await turn("comparison", COMPARISON, "compare Acme ($90k) and Globex ($95k)");
  assert.equal(r.fileCards?.length, 1); assert.equal(r.fileCards[0].kind, "comparison");
  assert.equal(cardFromTurnFiles(r.fileCards, KIND_LABEL, NOW), null);
});
