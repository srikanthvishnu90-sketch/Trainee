// R10 fix 9 (spec E.10 9; C.1-C.18, C.24, C.25, D; E.8 63-80): one coherent visual system for the fifteen File families.
// INTERFACE (architect, 2026-11-09): supabase/functions/_shared/file_family_specimens.ts exports FILE_FAMILIES, one entry per
// family F-01 ... F-15 plus "F-14n", the negotiation variant (spec C.3-C.18):
//   { id: "F-01", name: "Career brief", kind: <a KIND_IDS kind>, specimen: <data that validateKind accepts, trusted>,
//     page(ctx?): <the main state's page, rendered at a fixed clock in America/Chicago> } Each page is also diffed against its target's
// structure (TARGETS below) and its screenshot is reported beside the owner's target pages.
// Each specimen is created through the real file service on Postgres and opened through the real trainee-file handler, signed
// in from Telegram, then rendered in Chromium at 390 x 844 (deviceScaleFactor 2, light and dark) and checked against the shared
// anatomy (C.1): a back control, a serif title, a one-line subtitle stating the privacy or effect boundary, no sideways
// scroll, every button at least 44 px tall, and the plain-text twin carrying the title. A family that does not render fails.
// EXPECTED TO FAIL ON TRUNK (WO-E). Run: CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json <this file>
const helper = (() => { let u = new URL(".", import.meta.url); for (let i = 0; i < 8; i++) { const c = new URL("tests/architect/helpers/", u); try { Deno.statSync(c); return c.href; } catch { u = new URL("..", u); } } throw new Error("tests/architect/helpers not found"); })();
const R = await import(`${helper}r10_world.ts`);
const T = await import(`${helper}r10_turns.ts`);
const { ok, check, deliveredFiles, internalHits, repeated, renderPhone } = R;
const FILE = "r10-fix-09-file-families.test.ts", CHAT = 7_910_901;
const FAMILIES = ["Career brief", "Profile facts", "Path comparison", "Search plan", "Roles shortlist", "Role workspace", "Materials studio", "Answer library",
  "Application review", "Batch", "Pipeline", "People and messages", "Interview and event hub", "Plan and weekly brief", "Offer comparison"];
// VISUAL CONFORMANCE (owner ruling 2026-11-09: the visual library is the target). Each family's structure as spec C.3-C.18
// states it, extracted once from the spec text into data here (reviewable, deterministic): the header title and its boundary
// subtitle, the section labels in order, and the action names. Labels that are specimen content (a company, an id, a date)
// are left out. pages: the owner's target pages, docs/architect/specs/app-layer-visuals/p-NN.png, put beside each screenshot.
const TARGETS: Record<string, { spec: string; pages: number[]; header: string[] | null; sections: string[]; actions: string[] }> = {
  "F-01": {"spec": "C.3", "pages": [43, 44, 45], "header": ["Career brief", "Private File - only you"], "sections": ["WHAT YOU'RE AIMING FOR", "OPEN QUESTIONS - ONLY WHAT BLOCKS GOOD WORK", "FIRST ACTIONS"], "actions": ["Start search", "Edit goals", "Add materials", "Answer"]},
  "F-02": {"spec": "C.4", "pages": [46, 47], "header": ["Profile facts", "Private - never sent without approval"], "sections": ["CONFIRMED FACTS - SAMPLE", "INFERRED PREFERENCES - NOT ATTESTATIONS", "SENSITIVE FIELDS"], "actions": ["Export profile", "Stop reusing a fact"]},
  "F-03": {"spec": "C.5", "pages": [48, 49, 50], "header": ["Path comparison", "Decision File - no applications made"], "sections": [], "actions": ["Find example roles for A", "Build transition plan", "Change priorities"]},
  "F-04": {"spec": "C.6", "pages": [51, 52, 53], "header": ["Search plan", "Plan v1 - searching is not applying"], "sections": ["HARD CONSTRAINTS - CANNOT BE OVERRIDDEN BY FIT SCORE", "PREFERENCES - INFLUENCE RANKING, NEVER GATE"], "actions": ["Approve search scope", "Tighten search", "Explore adjacent roles"]},
  "F-05": {"spec": "C.7", "pages": [54, 55, 56, 57], "header": ["Roles File", "Private workspace - batch B-01"], "sections": ["TARGETS - COMPANIES, NO VERIFIED OPENING"], "actions": ["Prepare application", "Review fit", "Prepare selected roles"]},
  "F-06": {"spec": "C.8", "pages": [58, 59, 60], "header": null, "sections": ["ROLE WORKSPACE", "FIT AND ELIGIBILITY", "MATERIALS FOR THIS ROLE"], "actions": ["Review application", "View posting", "Exclude role"]},
  "F-07": {"spec": "C.9", "pages": [61, 62, 63], "header": ["Materials", "Resume - for R-07 - nothing sent"], "sections": ["MATERIALS STUDIO"], "actions": ["Compare changes", "Download"]},
  "F-08": {"spec": "C.10", "pages": [64, 65, 66], "header": ["Answer library", "Exact outgoing answers - inspectable"], "sections": ["FACTUAL - REUSED WITH SOURCE", "ROLE-SPECIFIC - DRAFTED FROM EVIDENCE", "SCOPED REUSE", "SENSITIVE - ALWAYS YOURS"], "actions": ["Use once", "Never reuse"]},
  "F-09": {"spec": "C.11", "pages": [67, 68], "header": null, "sections": ["FINAL REVIEW - APPROVAL COVERS EXACTLY THIS", "THE PACKAGE", "CONDITIONS - IN PLAIN WORDS"], "actions": ["Approve submission", "Edit materials", "Cancel"]},
  "F-10": {"spec": "C.12", "pages": [69, 70, 71], "header": null, "sections": [], "actions": []},
  "F-11": {"spec": "C.13", "pages": [72, 73], "header": ["Pipeline", "Your search history - no spreadsheet"], "sections": ["NEEDS A DECISION", "WAITING ON EMPLOYERS - SILENCE IS NOT REJECTION", "EMPLOYER STAGES - SEPARATE FROM SUBMISSION"], "actions": ["Review interview options", "Correct a status", "Export"]},
  "F-12": {"spec": "C.14", "pages": [74, 75], "header": ["Message review", "Referral request - not sent"], "sections": ["EXACT WORDS - SENT AS YOU, FROM YOUR ACCOUNT"], "actions": ["Approve send", "Edit wording", "Change recipient"]},
  "F-13": {"spec": "C.15", "pages": [76, 77, 78], "header": ["Interview hub", "Example Grid Co - stage 2 of 3"], "sections": ["CONFIRMED LOGISTICS", "WHO YOU'RE MEETING", "PREPARATION - THIS ROLE, THIS STAGE"], "actions": ["Open prep brief", "Propose new time", "Draft follow-up"]},
  "F-14": {"spec": "C.16", "pages": [79, 80, 81], "header": null, "sections": ["WHAT ACTUALLY CHANGED", "DECISIONS ONLY YOU CAN MAKE", "BLOCKERS, STATED PLAINLY"], "actions": ["Adjust plan", "Pause search"]},
  "F-14n": {"spec": "C.17", "pages": [84, 85, 86], "header": null, "sections": ["YOUR POSITION - CONFIRMED WITH YOU", "TERM HISTORY - VERSIONS KEPT SEPARATE", "THE ASK - DRAFTED, AWAITING YOUR APPROVAL"], "actions": ["Review the counter draft", "Adjust priorities", "Prepare decision"]},
  "F-15": {"spec": "C.18", "pages": [82, 83], "header": ["Offer comparison", "Decision support - nothing accepted"], "sections": [], "actions": ["Negotiate", "Mark preference"]}
};
const BOUNDARY = /private|only you|nothing (is |was )?(sent|submitted|accepted|applied)|not applying|decision support|review(ed)? before|until you approve/i;
const PROBE = `(() => {
  const h1 = document.querySelector("h1"), all = [...document.querySelectorAll("a,button,[role=button],input[type=submit]")];
  const back = all.find((e) => /back/i.test((e.getAttribute("aria-label") || "") + " " + (e.textContent || "")));
  const small = [...document.querySelectorAll("button,[role=button],input[type=submit]")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 44; }).map((e) => (e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 30));
  const font = h1 ? getComputedStyle(h1).fontFamily : "";
  return { h1: h1 ? h1.textContent.trim() : null, back: !!back, small, serif: /serif/i.test(font) && !/sans-serif/i.test(font.split(",")[0]), head: document.body.innerText.slice(0, 500) };
})()`;
R.suite(FILE, [9], [CHAT], async (t: Deno.TestContext, w: any) => {
  const person = await w.observedPerson(CHAT);
  const kinds = await import(`${helper}../../../supabase/functions/_shared/file_kinds.ts`);
  const specimens = await import(`${helper}../../../supabase/functions/_shared/file_family_specimens.ts`).catch((e) => ({ FILE_FAMILIES: null, error: String(e?.message ?? e).slice(0, 200) }));
  const { createFileService, supabaseFileKindStore } = await import(`${helper}../../../supabase/functions/_shared/file_service.ts`);
  const svc = createFileService({ store: supabaseFileKindStore(w.admin), env: Deno.env, now: Date.now });
  const fam: any[] = Array.isArray(specimens.FILE_FAMILIES) ? specimens.FILE_FAMILIES : [];
  await check(t, FILE, 9, "the fifteen File families are registered (F-01 ... F-15, spec C.3-C.18)", async (ev: any) => {
    ev.reply = `FILE_FAMILIES (file_family_specimens.ts): ${fam.map((f: any) => `${f.id} ${f.name}`).join("; ") || `(not exported${(specimens as any).error ? `: ${(specimens as any).error}` : ""})`}; KIND_IDS: ${kinds.KIND_IDS.join(", ")}`;
    ok(fam.length === 16, `fifteen families plus F-14n, one per spec family (${fam.length}): ${FAMILIES.join(", ")}`);
    ok(fam.some((f: any) => f.id === "F-14n"), "F-14n (the negotiation variant) is registered");
    for (let i = 1; i <= 15; i++) ok(fam.some((f: any) => f.id === `F-${String(i).padStart(2, "0")}`), `F-${String(i).padStart(2, "0")} is registered`);
  }, w);
  // The fifteen families, then the F-14 negotiation variant (spec C.17, Screen 16), registered as id "F-14-negotiation".
  for (let i = 0; i < 16; i++) {
    const id = i < 15 ? `F-${String(i + 1).padStart(2, "0")}` : "F-14n";
    if (i === 15) FAMILIES.push("Negotiation plan (F-14 variant)");
    await check(t, FILE, 9, `${id} ${FAMILIES[i]}: opens on a phone with the shared anatomy (390 px, light and dark)`, async (ev: any) => {
      ev.target = TARGETS[id].pages.map((n) => `docs/architect/specs/app-layer-visuals/p-${n}.png`).join(" ");
      const f = fam.find((x: any) => x.id === id);
      ok(f, `${id} is registered (target ${ev.target})`);
      // page(): the family's own render of its main state at a fixed clock (America/Chicago); it must be a page, and it is what
      // the File service serves for the specimen.
      ok(typeof f.page === "function", `${id}: page() is exported`);
      const own = await f.page();
      ok(typeof own === "string" && /<h1/i.test(own), `${id}: page() renders a page with a title`);
      const made = await svc.create(person, f.kind, f.specimen, { trusted: true });
      ok(made.ok, `${id}: the specimen is accepted: ${made.error}`);
      ok(made.url, `${id}: a File link was made`);
      const got = await w.open(made.url, CHAT);
      ok(got.status === 200 && got.html, `${id}: the File opens (HTTP ${got.status})`);
      const gaps: string[] = [];
      for (const scheme of ["light", "dark"] as const) {
        const r = await R.renderOpened(got, `f9-${id}`, PROBE, { scheme });
        ev.screenshots.push(r.screenshot);
        if (r.scrollWidth > r.innerWidth) gaps.push(`${scheme}: sideways scroll (${r.scrollWidth} > ${r.innerWidth})`);
        if (!r.probe.h1) gaps.push(`${scheme}: no title`);
        if (!r.probe.back) gaps.push(`${scheme}: no back control in the header`);
        if (!r.probe.serif) gaps.push(`${scheme}: the title is not in the serif display face`);
        if (!BOUNDARY.test(r.probe.head)) gaps.push(`${scheme}: no subtitle stating the privacy or effect boundary`);
        if (r.probe.small.length) gaps.push(`${scheme}: buttons under 44 px: ${r.probe.small.join(", ")}`);
      }
      // The structural diff against the target: header, sections present and in the same order, action names.
      const target = TARGETS[id];
      const text = got.html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]+>/g, " ").replace(/&#39;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").toLowerCase();
      if (target.header) for (const h of target.header) if (!text.includes(h.toLowerCase())) gaps.push(`header: "${h}" missing`);
      let at = -1;
      for (const sec of target.sections) {
        const i = text.indexOf(sec.toLowerCase());
        if (i < 0) gaps.push(`section: "${sec}" missing`);
        else if (i < at) gaps.push(`order: "${sec}" comes before the section the target puts ahead of it`);
        else at = i;
      }
      const buttons = [...got.html.matchAll(/<(button|a)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase());
      for (const a of target.actions) if (!buttons.some((b) => b.includes(a.toLowerCase()))) gaps.push(`action: "${a}" has no button or link`);
      ok(gaps.length === 0, `${id} against ${target.spec} (target ${ev.target}): ${gaps.join(" | ")}`);
      ev.reply = got.html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 600);
    }, w);
  }
});
