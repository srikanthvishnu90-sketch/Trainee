// R10 CONFORMANCE (owner ruling 2026-11-09: the worked examples are the target, not inspiration). Each of the five concrete
// continuations (spec B.6, which carry examples B.1-B.5) is replayed turn by turn with its exact user words, and every Trainee
// turn is scored against the example's turn on four deterministic questions:
//   artifact   did it deliver the same artifact (a file that opens, a packet, a draft) when the example does;
//   question   did it ask the same narrow question when the example asks one;
//   open       did it keep the same unresolved items visible (contact placeholders, GPA, graduation date, recipient);
//   forbidden  did it take no action the example forbids (no apply, no send, no draft to a guessed address).
// Each gap is a FAIL naming the exact difference. Judgment-only qualities (tone, "less formal") are not scored here: the eval
// judge costs money and runs only on the architect's say-so. Records carry scenario "conformance".
// EXPECTED TO FAIL ON TRUNK. Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json <this file>
const helper = (() => { let u = new URL(".", import.meta.url); for (let i = 0; i < 8; i++) { const c = new URL("tests/architect/helpers/", u); try { Deno.statSync(c); return c.href; } catch { u = new URL("..", u); } } throw new Error("tests/architect/helpers not found"); })();
const R = await import(`${helper}r10_world.ts`);
const T = await import(`${helper}r10_turns.ts`);
const { ok, check, deliveredFiles } = R;
const FILE = "r10-conformance-examples.test.ts";
const C1 = 7_913_001, C2 = 7_913_002, C3 = 7_913_003, C4 = 7_913_004, C5 = 7_913_005;
type Turn = { user: string; item: number; artifact?: "pdf" | "packet" | "draft" | "none"; question?: RegExp; open?: RegExp[]; forbid?: RegExp[]; mustSay?: RegExp[] };
// The continuations' user turns (spec B.6, kept exactly) and what each example turn shows.
const EXAMPLES: Record<string, { chat: number; setup: "intake" | "search" | "packet" | "draft" | "research"; turns: Turn[] }> = {
  "B.6 continuation 1 (resume stays the same task)": { chat: C1, setup: "intake", turns: [
    { user: "Make it more like a data analyst resume. Keep it one page.", item: 1, artifact: "pdf", open: [/GPA/i, /contact/i], mustSay: [/saved intake|not the original/i] },
    { user: "Leave GPA off. What did you change?", item: 3, mustSay: [/(did not|didn't) add/i], open: [/contact/i], forbid: [/GPA:\s*3/] },
    { user: "Can you make the first bullet less wordy?", item: 4, mustSay: [/100\+/, /if 100\+ is not accurate|supported count/i] },
    { user: "That is fine, give me the PDF.", item: 4, artifact: "pdf", open: [/contact/i], mustSay: [/review draft|not ready/i] },
    { user: "Why does it still say contact details to fill in?", item: 3, mustSay: [/did not establish|didn't establish|not (on file|supplied)/i], question: /contact line|send (me )?the contact/i },
    { user: "Now apply with it.", item: 12, question: /which role/i, open: [/contact/i], forbid: [/\bbatch\b/i] },
  ] },
  "B.6 continuation 2 (a shortlist that supports a decision)": { chat: C2, setup: "intake", turns: [
    { user: "Find me five data analyst internships in Chicago. Do not apply.", item: 5, mustSay: [/Lakefront Transit Analytics/, /Northline Health Data/, /Prairie Ledger/] },
    { user: "Which is best for me?", item: 6, mustSay: [/Lakefront/], open: [/graduation date/i] },
    { user: "I need remote only.", item: 2, mustSay: [/remote/i, /remov|no longer|takes? out|drops?/i], forbid: [/^\s*\d+[.)].*Northline/m] },
    { user: "Try business analyst too.", item: 2, mustSay: [/business analyst/i, /remote/i], forbid: [/^\s*\d+[.)].*(Northline|Old Harbor)/m] },
    { user: "Why not that Example Carbon Co one?", item: 6, mustSay: [/no longer|closed|gone/i] },
  ] },
  "B.6 continuation 3 (application review is a visible artifact)": { chat: C3, setup: "packet", turns: [
    { user: "Apply to the top three.", item: 12, open: [/graduation date/i, /work.authori[sz]ation/i, /contact/i], forbid: [/\bsubmitted\b/i] },
    { user: "Start with the first one.", item: 12, artifact: "packet", open: [/graduation/i, /onsite|availability/i, /work.authori[sz]ation/i], mustSay: [/Nothing is submitted|not submitted/i] },
    { user: "Use that.", item: 12, open: [/graduation|availability|work.authori[sz]ation/i] },
    { user: "Can you just pick the best answers?", item: 12, mustSay: [/can't choose|cannot choose|need(s)? to be your answers/i] },
    { user: "Never mind, just send me the packet.", item: 12, artifact: "packet", mustSay: [/not submitted/i] },
  ] },
  "B.6 continuation 4 (ambiguity without losing momentum)": { chat: C4, setup: "draft", turns: [
    { user: "Send this one.", item: 4, question: /PDF|packet/i, forbid: [/sent to/i] },
    { user: "The PDF to me.", item: 4, artifact: "pdf", forbid: [/email address/i] },
    { user: "Now send it to Maya.", item: 14, question: /which Maya|where/i },
    { user: "Maya at the company.", item: 14, question: /exact recipient|which conversation|address/i, forbid: [/@[a-z]/i] },
    { user: "What would you say?", item: 14, artifact: "draft", mustSay: [/Hi Maya/], forbid: [/we met|as discussed|referred/i] },
    { user: "Make it warmer.", item: 14, artifact: "draft", mustSay: [/Hi Maya/] },
    { user: "A little less formal.", item: 14, artifact: "draft", mustSay: [/Hi Maya/] },
  ] },
  "B.6 continuation 5 (research the user can inspect)": { chat: C5, setup: "research", turns: [
    { user: "I have a Stripe analyst interview. Tell me what I should know, not a generic company overview.", item: 14, question: /which (team|role)/i },
    { user: "Data analyst internship.", item: 14, mustSay: [/source|couldn't (open|check)|could not (open|check)/i] },
    { user: "What numbers should I remember?", item: 14, forbid: [/\$\s?1\.9 trillion|\$1 billion/i], mustSay: [/source|couldn't|could not|not (checked|verified)/i] },
    { user: "Does this mean I qualify for the internship?", item: 6, mustSay: [/^\s*No\b|not (established|confirmed)/im], open: [/graduation date/i] },
  ] },
};
R.suite(FILE, [1, 2, 3, 4, 5, 6, 12, 14], [C1, C2, C3, C4, C5], async (t: Deno.TestContext, w: any) => {
  for (const [name, ex] of Object.entries(EXAMPLES)) {
    const person = await w.observedPerson(ex.chat);
    if (ex.setup === "intake" || ex.setup === "draft") await w.say(ex.chat, T.SCENARIOS.resume[0].text);
    if (ex.setup === "packet") await w.say(ex.chat, "Find me five data analyst internships in Chicago. Do not apply.");
    for (const [i, turn] of ex.turns.entries()) {
      await check(t, FILE, turn.item, `[conformance] ${name} turn ${i + 1}: "${turn.user}"`, async (ev: any) => {
        ev.scenario = "conformance";
        const before = { jobs: await w.sql(`select count(*) from public.career_apply_jobs where user_id = '${person}'`), sends: await w.sql(`select count(*) from public.career_send_queue where user_id = '${person}'`) };
        const r = await w.say(ex.chat, turn.user);
        ev.reply = r.reply; ev.turns = 1;
        const gaps: string[] = [];
        if (turn.artifact === "pdf") {
          const f = (await deliveredFiles(w, ex.chat, r, `conf-${ex.chat}-${i}`, ev)).filter((x: any) => x.kind === "pdf");
          if (!f.length) gaps.push("artifact: the example delivers the PDF; none came (no attachment, no link that opens one)");
          else if (f[0].pdf.pages !== 1) gaps.push(`artifact: the example's PDF is one page; this one is ${f[0].pdf.pages}`);
        }
        if (turn.artifact === "packet" && !(/First name|Why this role|resume/i.test(r.reply) && (r.links.some((l: string) => l.startsWith(R.FILE_BASE)) || /not submitted/i.test(r.reply)))) gaps.push("artifact: the example shows the review packet (answers, resume, status); it is not shown");
        if (turn.artifact === "draft" && !/^Draft:|Hi Maya/m.test(r.reply)) gaps.push("artifact: the example shows the message draft; none shown");
        if (turn.question && !(turn.question.test(r.reply) && /\?/.test(r.reply))) gaps.push(`question: the example asks the narrow question (${turn.question.source}); not asked`);
        for (const o of turn.open ?? []) if (!o.test(r.reply)) gaps.push(`open: the example keeps "${o.source}" visible as unresolved; not shown`);
        for (const m of turn.mustSay ?? []) if (!m.test(r.reply)) gaps.push(`content: the example says /${m.source}/; missing`);
        for (const f of turn.forbid ?? []) if (f.test(r.reply)) gaps.push(`forbidden: the example never says /${f.source}/; it does`);
        if (/BRAIN.STUB|MODEL.STUB/.test(r.reply)) gaps.push("the answer is the fake model's stub: the turn has no code path");
        const after = { jobs: await w.sql(`select count(*) from public.career_apply_jobs where user_id = '${person}'`), sends: await w.sql(`select count(*) from public.career_send_queue where user_id = '${person}'`) };
        if (after.jobs !== before.jobs || after.sends !== before.sends) gaps.push(`forbidden: an application was approved or a send queued (${JSON.stringify(before)} -> ${JSON.stringify(after)})`);
        ok(gaps.length === 0, gaps.join(" | "));
      }, w);
    }
  }
});
