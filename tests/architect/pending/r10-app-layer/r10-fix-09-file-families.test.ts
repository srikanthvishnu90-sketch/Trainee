// R10 fix 9 (spec E.10 9; C.1-C.18, C.24, C.25, D; E.8 63-80): one coherent visual system for the fifteen File families.
// ASSUMED INTERFACE (the architect names it here; WO-E may rename it with the architect's yes): supabase/functions/_shared/
// file_kinds.ts exports FILE_FAMILIES, one entry per family F-01 ... F-15 (spec C.3-C.18):
//   { id: "F-01", name: "Career brief", kind: <a KIND_IDS kind>, specimen: <data that validateKind accepts, trusted> }
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
  const { createFileService, supabaseFileKindStore } = await import(`${helper}../../../supabase/functions/_shared/file_service.ts`);
  const svc = createFileService({ store: supabaseFileKindStore(w.admin), env: Deno.env, now: Date.now });
  const fam: any[] = Array.isArray(kinds.FILE_FAMILIES) ? kinds.FILE_FAMILIES : [];
  await check(t, FILE, 9, "the fifteen File families are registered (F-01 ... F-15, spec C.3-C.18)", async (ev: any) => {
    ev.reply = `FILE_FAMILIES: ${fam.map((f: any) => `${f.id} ${f.name}`).join("; ") || "(not exported)"}; KIND_IDS: ${kinds.KIND_IDS.join(", ")}`;
    ok(fam.length === 15, `fifteen families, one per spec family (${fam.length}): ${FAMILIES.join(", ")}`);
    for (let i = 1; i <= 15; i++) ok(fam.some((f: any) => f.id === `F-${String(i).padStart(2, "0")}`), `F-${String(i).padStart(2, "0")} is registered`);
  }, w);
  for (let i = 0; i < 15; i++) {
    const id = `F-${String(i + 1).padStart(2, "0")}`;
    await check(t, FILE, 9, `${id} ${FAMILIES[i]}: opens on a phone with the shared anatomy (390 px, light and dark)`, async (ev: any) => {
      const f = fam.find((x: any) => x.id === id);
      ok(f, `${id} is registered`);
      const made = await svc.create(person, f.kind, f.specimen, { trusted: true });
      ok(made.ok, `${id}: the specimen is accepted: ${made.error}`);
      ok(made.url, `${id}: a File link was made`);
      const got = await w.open(made.url, CHAT);
      ok(got.status === 200 && got.html, `${id}: the File opens (HTTP ${got.status})`);
      for (const scheme of ["light", "dark"] as const) {
        const r = await R.renderOpened(got, `f9-${id}`, PROBE, { scheme });
        ev.screenshots.push(r.screenshot);
        ok(r.scrollWidth <= r.innerWidth, `${id} ${scheme}: no sideways scroll (${r.scrollWidth} > ${r.innerWidth})`);
        ok(r.probe.h1, `${id} ${scheme}: a title`);
        ok(r.probe.back, `${id} ${scheme}: a back control in the header`);
        ok(r.probe.serif, `${id} ${scheme}: the title is set in the serif display face`);
        ok(BOUNDARY.test(r.probe.head), `${id} ${scheme}: the subtitle states the privacy or effect boundary: ${r.probe.head.slice(0, 200)}`);
        ok(r.probe.small.length === 0, `${id} ${scheme}: buttons under 44 px: ${r.probe.small.join(", ")}`);
      }
      ev.reply = got.html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 600);
    }, w);
  }
});
