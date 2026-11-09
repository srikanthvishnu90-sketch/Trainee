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
  let pdfText = "";
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
    ok(/\?/.test(r.reply) && /PDF|resume/i.test(r.reply), `a short question naming the concrete choices: ${r.reply.slice(0, 300)}`);
    ok(r.docs.length === 0, "nothing sent while the referent is unsettled");
    ok((await w.sql(`select count(*) from public.career_apply_wanted where user_id = '${person}'`)) === "0" && (await w.sql(`select count(*) from public.career_outreach_drafts where user_id = '${person}'`)) === "0", "no application or message started");
  }, w);
  await check(t, FILE, 4, "'The PDF to me.' delivers the PDF itself, and does not ask for an email address", async (ev: any) => {
    const r = await w.say(CHAT, "The PDF to me.");
    ev.reply = r.reply;
    const files = await deliveredFiles(w, CHAT, r, "files-to-me", ev);
    ok(files.some((f: any) => f.kind === "pdf" && f.pdf.pages === 1), `the PDF comes with the reply: ${r.reply.slice(0, 300)}`);
    ok(!/email address|what('s| is) your email/i.test(r.reply), "'to me' is this chat, not a contact search");
  }, w);
  await check(t, FILE, 4, "no reply says 'attached' or names a format that did not come with it", async (ev: any) => {
    for (const words of ["What files do I have?", "Is the PDF attached?"]) {
      const r = await w.say(CHAT, words);
      ev.reply += `${words} -> ${r.reply}\n`;
      if (/\battached\b/i.test(r.reply) && !/not attached|isn't attached/i.test(r.reply)) ok(r.docs.length >= 1, `"attached" with no attachment: ${r.reply.slice(0, 300)}`);
      ok(!/parse check/i.test(r.reply), "no parser verdict passed off as inspection");
    }
  }, w);
});
