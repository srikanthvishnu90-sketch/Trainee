// MIRROR WA-1 gaps, through the real handler (2026-11-11). The live run of the owner's Instinct WhatsApp benchmark
// (evals/mirror/instinct-wa-batch1/results/, live-4) left four gaps that code can close; this pins what code hands the brain
// for each, at $0: every migration on a throwaway Postgres 16, the real career handler, a SCRIPTED model that records the
// system prompt and the tools it was offered, every host but the database double refused.
//   C15  "say i'm a new grad with zero internships and a mid gpa": a hypothetical person. The brain is told so, the person's
//        saved facts are not in its prompt, and no tool that reads or writes their record is offered: a scripted attempt to
//        save a fact is refused and their facts are unchanged. C7 (a hypothetical offer) is a hypothetical too and writes nothing.
//   C21f the answer to "ask me 'tell me about a time you failed' and then roast my answer", one turn later (C22 in between):
//        the brain is told to critique that answer bluntly (ownership, cost, the specific change, only what happened), never
//        a fill-in template; a control answer with no roast asked gets no such note.
//   C10, C11, C18, C20 "that paypal internship": the posting the conversation listed (C3) is handed over by job id and link.
//   Length: the brain is told each reply's length by kind (a draft short, a recall one line, "everything" long).
//   CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/mirror-wa-batch1-gaps-handler.test.ts
import assertNode from "node:assert/strict";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { canRun, openWorld } from "./helpers/response_world.ts";

const DIR = new URL("../../evals/mirror/instinct-wa-batch1/", import.meta.url);
const lines = (f: string) => Deno.readTextFileSync(new URL(f, DIR)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const turns: Record<string, string> = Object.fromEntries(lines("prompts.jsonl").map((t: any) => [t.id, t.prompt]));
const persona: { setup: string[] } = JSON.parse(Deno.readTextFileSync(new URL("persona.json", DIR)));
const PAYPAL = { id: "greenhouse:paypalwa1:9101", url: "https://boards.greenhouse.io/paypalwa1/jobs/9101" };
const C21_QUESTION = "Tell me about a time you failed: what were you responsible for, what went wrong, and what did you do afterward?";

type Seen = { system: string; tools: string[]; user: string };
const lastUser = (chat: any) => { const u = [...(chat.messages ?? [])].reverse().find((m: any) => m.role === "user"); return typeof u?.content === "string" ? u.content : JSON.stringify(u?.content ?? ""); };

Deno.test({ name: "WA1-G the brain gets the hypothetical, the roast, the posting already listed, and the length, from code", sanitizeOps: false, sanitizeResources: false, ignore: canRun() !== null && canRun() !== "FAIL", fn: async () => {
  if (canRun() === "FAIL") throw new Error("WA1-G needs Postgres 16 in CI");
  let label = "";
  const seen: Record<string, Seen> = {};
  const scripted = (chat: any) => {
    const msgs = chat.messages ?? [];
    const reply = (content: string, tool_calls?: unknown[]) => Response.json({ id: "wa1g", model: chat.model, choices: [{ index: 0, message: { role: "assistant", content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    if (!Array.isArray(chat.tools) || !chat.tools.length) return reply(chat.response_format ? "{}" : `scripted (${label})`);
    if (!seen[label]) seen[label] = { system: String(msgs[0]?.role === "system" ? msgs[0].content : ""), tools: chat.tools.map((t: any) => t.function?.name ?? t.name), user: lastUser(chat) };
    // C15: the model tries to save the hypothetical as a fact; the tool is not offered, so the loop refuses it.
    if (label === "C15" && msgs.at(-1)?.role !== "tool") return reply("", [{ id: "toolu_wa1g_1", type: "function", function: { name: "add_profile_fact", arguments: JSON.stringify({ kind: "education", text: "new grad, zero internships, mid GPA" }) } }]);
    if (label === "C21") return reply(C21_QUESTION);
    return reply(`scripted (${label})`);
  };
  const w = await openWorld(2, { model: (req) => anthropicWire(req, scripted) });
  try {
    Deno.env.set("CAREER_BRAIN", "staged");
    Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
    await w.pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
      ('${PAYPAL.id}', 'greenhouse', 'paypalwa1', 'PayPal', 'Software Engineer Intern', 'Chicago, IL', '${PAYPAL.url}', 'Summer 2027 software engineering internship. Python, Java.', now() - interval '1 day', now())`);
    const person = await w.person({ resume: false });
    for (const s of persona.setup) { label = "setup"; await person.say(s); }
    const facts = async () => (await w.pg.sql(`select coalesce(state->'career'->'stores'->'profile'->'facts', '[]'::jsonb)::text from public.agent_flow_state where user_id = '${person.id}' order by updated_at desc limit 1`)).trim();
    const say = async (id: string, text = turns[id]) => { label = id; const r = await person.say(text); return String(r.reply ?? ""); };

    // C3, code's search: the PayPal posting is listed.
    const c3 = await say("C3");
    assertNode.ok(c3.includes("PayPal"), `C3 lists the PayPal posting: ${c3.slice(0, 300)}`);

    // C10, C11, C18, C20: "that paypal ..." is the posting C3 listed, handed to the brain by job id and link.
    for (const id of ["C10", "C11", "C18", "C20"]) {
      await say(id);
      const s = seen[id];
      assertNode.ok(s, `${id} reached the brain`);
      assertNode.match(s.system, /THE POSTING THEY MEAN/, `${id}: the posting note`);
      assertNode.ok(s.system.includes(PAYPAL.id) && s.system.includes(PAYPAL.url), `${id}: the listed posting's job id and link`);
      assertNode.match(s.system, /never ask them to paste or find it again/, id);
    }
    // Control: an employer the conversation never listed gets no posting.
    await say("X1", "can you make me a tailored resume for that stripe internship, like an actual file. don't apply anywhere");
    assertNode.ok(!seen.X1 || !/THE POSTING THEY MEAN/.test(seen.X1.system), "no posting is handed over for an employer never listed");

    // C15: a hypothetical person. Answered as the hypothetical, without their facts, and nothing about them read or written.
    const before = await facts();
    assertNode.ok(before.includes("Pixelforge"), "the resume facts are on record before C15");
    await say("C15");
    const s15 = seen.C15;
    assertNode.ok(s15, "C15 reached the brain");
    assertNode.match(s15.system, /THIS MESSAGE IS A HYPOTHETICAL PERSON/);
    assertNode.match(s15.system, /In that situation/);
    assertNode.ok(!/Pixelforge|Rallyup|Harbor Global|Crestline/.test(s15.system), "none of their saved facts is in the prompt");
    for (const t of ["add_profile_fact", "correct_profile_fact", "confirm_profile_fact", "get_profile", "remember_instruction", "track_application"]) assertNode.ok(!s15.tools.includes(t), `C15 offers ${t}`);
    assertNode.equal(await facts(), before, "the scripted attempt to save the hypothetical changed nothing");

    // C7: a hypothetical situation: told so, and offered no tool that writes their record.
    await say("C7");
    assertNode.match(seen.C7.system, /THIS MESSAGE IS A HYPOTHETICAL \(/);
    for (const t of ["add_profile_fact", "correct_profile_fact", "track_application"]) assertNode.ok(!seen.C7.tools.includes(t), `C7 offers ${t}`);
    // Control: a plain advice question is not a hypothetical, and keeps the record tools.
    await say("X2", "what should i put at the very top of my resume for swe roles, be specific");
    // Architect amendment (D-067 (7), G1/D-007): a question that states nothing about the person is no longer offered add_profile_fact
    // (nothing to save from it); the control's bar stands: it is not a hypothetical and keeps the record tools a hypothetical withholds.
    assertNode.ok(!/HYPOTHETICAL/.test(seen.X2.system) && seen.X2.tools.includes("correct_profile_fact") && seen.X2.tools.includes("track_application"), "not a hypothetical");

    // C21, C22, C21f: the answer to the roast ask, one turn later, is critiqued bluntly on what it says.
    await say("C21");
    await say("C22");
    await say("C21f");
    const s21 = seen.C21f;
    assertNode.ok(s21, "C21f reached the brain");
    assertNode.match(s21.system, /THEY ARE ANSWERING THE PRACTICE QUESTION THEY ASKED YOU TO ROAST/);
    assertNode.ok(s21.system.includes("Tell me about a time you failed"), "the question as it was asked");
    assertNode.match(s21.system, /ownership/);
    assertNode.match(s21.system, /what it cost/);
    assertNode.match(s21.system, /Never write a fill-in template/);
    assertNode.ok(!/ROAST/.test(seen.C22?.system ?? ""), "C22, a new question, is not read as the answer");

    // Length by kind: a draft is short, a casual or "way shorter" one shorter, a recall one line, "everything" long.
    await say("C2");
    assertNode.match(seen.C2.system, /LENGTH OF THIS REPLY \(a text message\): the draft itself, about 150 to 360 characters/);
    await say("C13");
    assertNode.match(seen.C13.system, /LENGTH OF THIS REPLY \(a text message\): the draft itself under about 200 characters/, "\"keep it casual\"");
    await say("C14");
    assertNode.match(seen.C14.system, /LENGTH OF THIS REPLY \(a text message\): the draft itself under about 200 characters/);
    await say("C23");
    assertNode.match(seen.C23.system, /LENGTH OF THIS REPLY \(a text message\): one or two sentences/);
    await say("C8");
    assertNode.match(seen.C8.system, /LENGTH OF THIS REPLY \(a text message\): about 900 to 1,200 characters/);
    for (const id of ["C13", "C23", "C8"]) assertNode.match(seen[id].system, /Keep every fact, caveat and statement of what was not sent, submitted or verified/);

    for (const t of ["career_apply_receipts", "career_apply_jobs", "career_apply_prepared", "career_outbox", "career_contact_sends"]) {
      if (!(await w.pg.sql(`select to_regclass('public.${t}') is not null`)).includes("t")) continue;
      const n = (await w.pg.sql(`select count(*) from public.${t} where user_id = '${person.id}'`)).replace(/\D+/g, " ").trim().split(" ")[0];
      assertNode.equal(n, "0", `${t} has rows`);
    }
  } finally {
    Deno.env.delete("CAREER_BRAIN");
    Deno.env.delete("ANTHROPIC_API_KEY");
    await w.close();
  }
} });
