// R10 fix 4 (spec E.10 4; E.1 5-10, 12; E.4 36-38; B.4): real, inspectable files and honest file claims. A file a reply
// names comes with it and opens; a DOCX named is a DOCX that opens with the same facts as the PDF; "Send this one." with two
// candidate objects asks which, and sends nothing; "The PDF to me." delivers the PDF itself; the filename says what it is.
// EXPECTED TO FAIL ON TRUNK (WO-B). Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json <this file>
const helper = (() => { let u = new URL(".", import.meta.url); for (let i = 0; i < 8; i++) { const c = new URL("tests/architect/helpers/", u); try { Deno.statSync(c); return c.href; } catch { u = new URL("..", u); } } throw new Error("tests/architect/helpers not found"); })();
const R = await import(`${helper}r10_world.ts`);
const T = await import(`${helper}r10_turns.ts`);
const { ok, check, deliveredFiles, internalHits, repeated, renderPhone } = R;
const FILE = "r10-fix-04-files.test.ts", CHAT = 7_910_401;
R.suite(FILE, [4], [CHAT], async (t: Deno.TestContext, w: any) => {
  const person = await w.observedPerson(CHAT);
  let pdfText = "", pdfSent = false; // pdfSent: a PDF was delivered by an earlier turn of this conversation
  await check(t, FILE, 4, "the draft PDF is delivered and opens: one page, selectable text, readable type, nothing outside the page", async (ev: any) => {
    const r = await w.say(CHAT, T.SCENARIOS.resume[0].text);
    ev.reply = r.reply;
    const files = await deliveredFiles(w, CHAT, r, "files-t1", ev);
    const pdf = files.find((f: any) => f.kind === "pdf");
    ok(pdf, `a PDF is delivered: ${r.reply.slice(0, 300)}`);
    ok(pdf.pdf.ok && pdf.pdf.pages === 1 && pdf.pdf.text.length > 200, `opens: ${pdf.pdf.pages} page(s), ${pdf.pdf.text.length} chars`);
    ok(pdf.pdf.minFontPt === null || pdf.pdf.minFontPt >= 8, `readable type: ${pdf.pdf.minFontPt} pt`);
    ok(pdf.pdf.outOfPage === 0, "no clipped text");
    ok(!/^(Resume_Resume|document|resume)\.pdf$/i.test(pdf.name), `a meaningful filename: ${pdf.name}`);
    pdfText = pdf.pdf.text;
    pdfSent = true;
  }, w);
  await check(t, FILE, 4, "'send me the Word version too' delivers a DOCX that opens with the same facts", async (ev: any) => {
    const r = await w.say(CHAT, "Send me the Word version too.");
    ev.reply = r.reply;
    const files = await deliveredFiles(w, CHAT, r, "files-docx", ev);
    const docx = files.find((f: any) => f.kind === "docx");
    ok(docx && docx.docx.ok, `a DOCX that opens: ${JSON.stringify(files.map((f: any) => f.name))} | ${r.reply.slice(0, 300)}`);
    for (const fact of [T.INTAKE_NAME, "Granite Peak Partners", "Halcyon Advisory"]) ok(docx.docx.text.includes(fact) && (!pdfText || pdfText.includes(fact)), `the DOCX and PDF both carry "${fact}"`);
  }, w);
  await check(t, FILE, 4, "'Send this one.' with a resume and an application in view asks which (two concrete choices) and sends nothing", async (ev: any) => {
    const r = await w.say(CHAT, "Send this one.");
    ev.reply = r.reply;
    // B.4: two concrete choices ("submit the application for job 2, or send you the revised resume PDF?"), not "please clarify".
    // Both choices concrete: the resume PDF by name, and a specific application (job N, or one at a named employer or role).
    const pdfChoice = /\b(resume|revised|the|your)\s+(resume\s+)?PDF\b|\b(revised|tailored) resume\b|\bresume draft\b/i.test(r.reply);
    // The application is a role or an employer of this test's world (the fixtures), or "job N" of the list shown.
    const names = [...T.MARKET, ...T.OLD_LIST].flatMap((m: any) => [m.company, m.title]).filter((x: string) => x.length > 3);
    const appChoice = /\bjob \d\b/i.test(r.reply) || names.some((n: string) => r.reply.toLowerCase().includes(n.toLowerCase()));
    ok(/\?/.test(r.reply) && /\bor\b/i.test(r.reply) && pdfChoice && appChoice && !/\b(something|anything) else\b|\bor (other|another) (thing|one)\b/i.test(r.reply), `a short question naming two concrete choices (the resume PDF or a specific application): ${r.reply.slice(0, 300)}`);
    ok(!/please clarify|can you clarify|what do you mean\??$/i.test(r.reply), "not a generic clarification request");
    ok(r.docs.length === 0, "nothing sent while the referent is unsettled");
    ok((await w.sql(`select count(*) from public.career_apply_wanted where user_id = '${person}'`)) === "0" && (await w.sql(`select count(*) from public.career_outreach_drafts where user_id = '${person}'`)) === "0", "no application or message started");
  }, w);
  await check(t, FILE, 4, "'The PDF to me.' delivers the PDF itself, and does not ask for an email address", async (ev: any) => {
    const r = await w.say(CHAT, "The PDF to me.");
    ev.reply = r.reply;
    const files = await deliveredFiles(w, CHAT, r, "files-to-me", ev);
    ok(files.some((f: any) => f.kind === "pdf" && f.pdf.pages === 1), `the PDF comes with the reply: ${r.reply.slice(0, 300)}`);
    if (files.some((f: any) => f.kind === "pdf")) pdfSent = true;
    ok(!/email address|what('s| is) your email/i.test(r.reply), "'to me' is this chat, not a contact search");
  }, w);
  await check(t, FILE, 4, "'Is the PDF attached?' is answered truthfully: what the reply says matches what came with it", async (ev: any) => {
    const r = await w.say(CHAT, "Is the PDF attached?");
    ev.reply = r.reply;
    const files = await deliveredFiles(w, CHAT, r, "files-attached-q", ev);
    const says = { yes: /\b(yes|here it is|attached)\b/i.test(r.reply) && !/not attached|isn't attached|no (pdf|file|attachment)/i.test(r.reply), no: /not attached|isn't attached|no (pdf|file|attachment)|haven't (made|sent)/i.test(r.reply) };
    ok(says.yes || says.no, `a plain yes or no: ${r.reply.slice(0, 300)}`);
    // The truth is the conversation's, not this reply's alone: once an earlier turn delivered a PDF, "No, I haven't sent a PDF"
    // is false, and "yes, in my previous message" is true even with no file on this reply.
    const now = files.some((f: any) => f.kind === "pdf"), before = pdfSent, pointsBack = /previous|earlier|last message|above|already sent/i.test(r.reply);
    ok(says.yes === (now || before), `the answer (${says.yes ? "yes" : "no"}) matches the conversation (a PDF on this reply: ${now}; sent earlier: ${before}): ${r.reply.slice(0, 300)}`);
    if (says.yes && !now) ok(before && pointsBack, `a yes with no file on this reply points to the earlier message that carried it: ${r.reply.slice(0, 300)}`);
    ok(!/parse check/i.test(r.reply), "no parser verdict passed off as inspection");
  }, w);
});
