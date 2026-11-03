// MUSE-F-011 — the Buffer-free child realm for the career_tailor
// live-replay guard in tests/edge/career-tailor-realm.test.ts.
//
// Spawned as a FRESH Deno process per fixture so the staged career
// bundle (supabase/functions/_shared/router_core.career.js) is
// imported only AFTER globalThis.Buffer is removed — the Supabase
// Edge Runtime realm (Deno 2.1.4), which has no bare Buffer global.
// Local Deno (2.9.7) and Node both expose one, which is exactly how
// this defect stayed masked: every local realm had the global the
// production realm lacks. Module 148 read the bare global in ~30
// places; the first render on a tailor turn threw
// "ReferenceError: Buffer is not defined" and module 143's
// containment served the generic failure reply.
//
// Usage: deno run -A tests/edge/lib/career-replay-child.ts <fixture-id>
// Prints exactly one JSON verdict line:
//   { id, intent, contained, handler, artifactPdf, pdfBytes, reply }
// or { id, stage, error } when the realm or the turn itself failed.
// @ts-ignore: JSON fixture file, read dynamically per fixture id
import DB from "./fixtures/career-tailor-replays.json" with { type: "json" };

const fixtureId = Deno.args[0];
const root = new URL("../../../", import.meta.url);
const at = (p: string) => new URL(p, root).href;

function verdict(v: Record<string, unknown>) {
  console.log(JSON.stringify(v));
}

// 1. Remove/shadow the Buffer global BEFORE the bundle is imported,
//    and prove the realm is really Buffer-free.
(globalThis as any).Buffer = undefined;
try { delete (globalThis as any).Buffer; } catch { /* the assignment above already shadowed it */ }
if (typeof (globalThis as any).Buffer !== "undefined") {
  verdict({ id: fixtureId, stage: "shadow", error: "could not remove the Buffer global in this realm" });
  Deno.exit(2);
}

const fixture = (DB as any).fixtures.find((f: any) => f.id === fixtureId);
if (!fixture || fixture.kind !== "career_tailor") {
  verdict({ id: fixtureId, stage: "fixture", error: `no career_tailor fixture with id ${fixtureId}` });
  Deno.exit(2);
}
const world = fixture.world || {};

// 2. Build the world: the fixture persona (Alex Testcase) through the
//    bundle's own profile builder, minus the facts the live confirmed
//    profile never held (the resume text lists 9 skills; the persona
//    JSON carries a 10th, Rust — the confirmed profile is 15 facts).
const personaRaw = JSON.parse(await Deno.readTextFile(new URL(world.persona, root)));
const drop = new Set(world.drop_fact_names || []);
personaRaw.facts = (personaRaw.facts || []).filter((f: any) => !drop.has(f.name));

// 3. Import the deployed composition AFTER the shadow: the real
//    CareerHost composed from the real built bundle, exactly as
//    handler-career.ts composes it (same shape as
//    tests/edge/edge-pdf-renderer.test.ts).
// @ts-ignore: plain-JS shared module, composed as handler-career.ts composes it
const { CareerHost } = await import(at("supabase/functions/_shared/career_host.js"));
// @ts-ignore: the built career bundle — the deployed artifact's own module
const bundle = await import(at("supabase/functions/_shared/router_core.career.js"));
const { CareerAccess, CareerOnboarding, CareerRouter, CareerDoorstep, CareerReply, CareerContainment, CareerProfile } = bundle as any;

const clone = (v: any) => JSON.parse(JSON.stringify(v));
const host = (CareerHost as any).createCareerHost({
  CareerAccess, CareerOnboarding, CareerRouter, CareerDoorstep, CareerReply, CareerContainment,
});
const persona = (CareerProfile as any).profileFromData(personaRaw);
const stores: Record<string, unknown> = { profile: clone(persona) };
if (world.posting) stores.posting = clone(world.posting);
const snapshot = { v: 1, scope: { userId: world.user_id }, stores };
const ctx = host.createTurnCtx({
  userId: world.user_id,
  threadId: `thread-replay-${fixture.id}`,
  now: Date.parse(world.now),
  accountPersistence: true,
  snapshot,
  account: {},
  watchState: {},
});

let out: any = null;
try {
  // Context turns first, in the same thread (the flow-replay pattern):
  // for the pasted-posting entry the paste itself stages the posting
  // (142's quoted-block capture), and the fixture's own turn binds it.
  for (const t of fixture.context || []) host.runTurn(t, ctx);
  out = host.runTurn(fixture.text, ctx);
} catch (err) {
  verdict({ id: fixture.id, stage: "turn", error: String((err as Error) && (err as Error).message || err), name: (err as any) && (err as any).name || null });
  Deno.exit(0);
}
const pdf = out && out.result && out.result.artifact ? out.result.artifact.pdf : null;
verdict({
  id: fixture.id,
  intent: out ? (out.intent ?? null) : null,
  contained: out ? out.contained === true : null,
  handler: out ? (out.handler ?? null) : null,
  facts: (persona.facts || []).length,
  artifactPdf: !!pdf,
  pdfBytes: pdf ? (pdf.bytes ?? null) : null,
  reply: out ? (out.reply ?? null) : null,
});
