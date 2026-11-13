// D-072 follow-up (independent review of PR #798, "files reachable"). Four findings, each held here. $0: no model, no network.
//   FO-1  AN OPT-OUT IS NOT A FILE ASK: "don't send me the weekly brief anymore", "no more weekly brief", "skip the weekly summary",
//         "mute weekly brief", "weekly digest off" were read as "make the Weekly brief", so the turn was held to open_record_file and
//         the person got a brief link in place of the pause. familyAskOf is null for a negated, stop, pause, skip, mute, unsubscribe,
//         "no more" or "never" ask, and the staged route no longer gives file_family_ask.
//   FO-2  A NEW THING TO MAKE IS NOT A FILE ASK: "make me a search plan for PM roles in NYC", "build a search plan", "draft a
//         counter plan" are the planning turn's, not an open of the File on record.
//   FO-3  THE INTERVIEW TIME IN THE REPLY IS THE PAGE'S: holds carries the time in the person's zone with the zone named (never the
//         stored UTC instant), and the deployed maker passes the person's zone as the File server does.
//   FO-4  NO ORPHAN FILE: a view that can't be summarised makes no File row.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/files-ask-optout-d072.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
import { clockOf, familyAskOf, type FamilyMakeDeps, holdsOf, makeFamilyFile } from "../../supabase/functions/_shared/file_family_make.ts";
import { recordsFamilies } from "../../supabase/functions/_shared/file_family_actions.ts";
import { interviewHubFile } from "../../supabase/functions/_shared/file_family_apply.ts";
import { FULL, NOW } from "./files-records-fixtures.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
// deno-lint-ignore no-explicit-any
const C = core as any, host = (CareerHost as any).createCareerHost({ CareerAccess: C.CareerAccess, CareerOnboarding: C.CareerOnboarding, CareerRouter: C.CareerRouter, CareerDoorstep: C.CareerDoorstep, CareerReply: C.CareerReply, CareerContainment: C.CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-fo", threadId: "t-fo", now: NOW, accountPersistence: true, snapshot: null, account: { epoch: 0, version: 0, paused: false } });
const STAGED = { get: (k: string) => ({ CAREER_BRAIN: "staged" } as Record<string, string>)[k] };
const reasonOf = (message: string) => { const e = console.error; console.error = () => {}; try { return stagedDecision({ env: STAGED, message, ctx: fresh(), host, structured: false }).reason; } finally { console.error = e; } };

const OPT_OUTS = ["don't send me the weekly brief anymore", "no more weekly brief", "skip the weekly summary", "mute weekly brief", "I never want to see the weekly digest again",
  "weekly digest off", "do not send the weekly brief", "dont send me my weekly digest", "stop sending me the weekly report", "unsubscribe me from the weekly digest",
  "pause the weekly brief page", "turn off my weekly summary", "I no longer want the weekly brief", "opt out of the weekly digest", "please stop the weekly brief link",
  "snooze my weekly brief", "cancel the weekly digest", "I don’t want the weekly brief file", "never send me my career brief again", "no more interview hub links"];
const CREATES = ["make me a search plan for PM roles in NYC", "build a search plan", "draft a counter plan", "create a search plan for data roles", "write me a negotiation plan",
  "plan my search plan for consulting", "put together a search plan for me", "write a career brief for me", "can you come up with a counteroffer plan", "generate a search plan page"];
const STILL_ASKS: [string, string][] = [["send me my weekly brief", "F-14"], ["my weekly brief", "F-14"], ["where's my weekly summary", "F-14"], ["show me my search plan", "F-04"],
  ["show me the search plan page", "F-04"], ["show me my negotiation plan", "F-14n"], ["open the negotiation file", "F-14n"], ["pull up my interview hub", "F-13"], ["show me my career brief", "F-01"]];

Deno.test("FO-1 AN OPT-OUT IS NOT A FILE ASK: negated, stop, pause, skip, mute, unsubscribe, 'no more' and 'never' asks are left to the settings path", () => {
  for (const m of OPT_OUTS) eq(familyAskOf(m), null, m);
  for (const m of OPT_OUTS) ok(reasonOf(m) !== "file_family_ask", `${m}: routed as a File ask`);
  // The asks to see a File still are.
  for (const [m, f] of STILL_ASKS) { eq(familyAskOf(m), f, m); eq(reasonOf(m), "file_family_ask", m); }
});

Deno.test("FO-2 A NEW THING TO MAKE IS NOT A FILE ASK: make, build, draft, create, write and plan asks are not held to opening the File on record", () => {
  for (const m of CREATES) { eq(familyAskOf(m), null, m); ok(reasonOf(m) !== "file_family_ask", `${m}: routed as a File ask`); }
});

Deno.test("FO-3 THE INTERVIEW TIME IN THE REPLY IS THE PAGE'S: in the person's zone, with the zone named, never the stored UTC instant", async () => {
  const at = "2026-11-12T19:00:00Z";
  ok(/2:00 PM EST/.test(clockOf(at, "America/New_York")) && /11:00 AM PST/.test(clockOf(at, "America/Los_Angeles")) && /1:00 PM CST/.test(clockOf(at, null)) && /1:00 PM CST/.test(clockOf(at, "Not/AZone")));
  eq(clockOf(null, "America/New_York"), "time not on record");
  // The maker, over the same records family the File server serves, with the person's zone passed the way the page passes it.
  for (const [zone, hour] of [["America/Los_Angeles", "11:00 AM PST"], ["America/New_York", "2:00 PM EST"], [null, "2:00 PM EST"]] as const) {
    let made = 0;
    const d: FamilyMakeDeps = { files: { createFamily: () => { made++; return Promise.resolve({ ok: true as const, url: "https://trainee.example/file?t=x", id: "f1" }); } } as unknown as FamilyMakeDeps["files"],
      records: recordsFamilies({ read: (_u, _f, o) => Promise.resolve({ ...FULL, tz: o.tz }), digest: { async setEnabled() {} } as never, now: () => NOW - 86400_000, timeZone: () => Promise.resolve(zone) }),
      refs: { latestDoc: () => Promise.resolve(null), latestDraft: () => Promise.resolve(null) } };
    const r = await makeFamilyFile(d, "u-fo", "interview_hub");
    ok(r.ok, JSON.stringify(r));
    if (!r.ok) continue;
    const when = r.holds.find((h) => h.startsWith("When: ")) ?? "";
    ok(when.includes(hour), `${zone}: ${when}`);
    ok(!/T19:00|19:00|\dZ\b/.test(r.holds.join("\n")), `${zone}: no raw UTC instant in holds: ${when}`);
    eq(made, 1);
    // The same hour the page's hero shows.
    const loaded = await d.records["F-13"]!.load("u-fo", { id: "", data: { family: "F-13" } });
    // deno-lint-ignore no-explicit-any
    const title = String(interviewHubFile((loaded as any).view).hero?.title ?? "");
    ok(title.includes(hour), `${zone}: the page shows ${title}`);
  }
  ok(/When: Thu Nov 12, 2:00 PM EST/.test(holdsOf("F-13", { company: "Evercore", stage: "First round", at, tz: "America/New_York", booked: true, medium: "Video", person: { name: "Dana Park" } }).join("\n")));
  const src = Deno.readTextFileSync(new URL("../../supabase/functions/_shared/file_family_make_supabase.ts", import.meta.url));
  ok(/recordsFamilies\(\{ read: supabaseRecords\(admin\), digest: supabaseDigestWriter\(admin\), now, timeZone: supabaseTimeZone\(admin\) \}\)/.test(src), "the deployed maker passes the person's zone, as trainee-file/deps.ts does");
});

Deno.test("FO-4 NO ORPHAN FILE: a view that can't be summarised makes no File row and says it was not made", async () => {
  let made = 0;
  const d: FamilyMakeDeps = { files: { createFamily: () => { made++; return Promise.resolve({ ok: true as const, url: "https://trainee.example/file?t=x", id: "f1" }); } } as unknown as FamilyMakeDeps["files"],
    records: { "F-01": { load: () => Promise.resolve({ view: { constraints: 5 }, asOf: null }) } }, refs: { latestDoc: () => Promise.resolve(null), latestDraft: () => Promise.resolve(null) } };
  const r = await makeFamilyFile(d, "u-fo", "career_brief");
  eq(r.ok, false);
  ok(!r.ok && r.reason === "unreadable" && /^not made: /.test(r.error), JSON.stringify(r));
  eq(made, 0, "no File row was made");
});
