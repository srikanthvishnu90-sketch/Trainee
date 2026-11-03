// NO LIMITS (owner, 2026-10-27) on #222's review: the thread keeps only a convenience copy of an imported export
// (MIRROR_MAX rows); the email drafter must still reach every saved person. Someone at row 1,500 of a 2,000-row export,
// absent from the thread's copy, is found by name and by firm from the saved people (career_people). Synthetic only.
import nodeAssert from "node:assert/strict";
import { networkingTurn } from "../../supabase/functions/_shared/career_networking.ts";
import { memoryOutreachStore } from "../../supabase/functions/_shared/career_outreach.ts";
import type { PeopleStore, PersonRec } from "../../supabase/functions/_shared/career_people.ts";

const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
const U = "u-1", T = "t-1", NOW = Date.parse("2026-10-28T12:00:00Z");
const word = (i: number) => { let w = ""; for (let n = i; n > 0; n = Math.floor((n - 1) / 26)) w = String.fromCharCode(97 + ((n - 1) % 26)) + w; return w[0].toUpperCase() + w.slice(1); };
const rec = (i: number): PersonRec => ({ id: i, source: "linkedin_export", name: i === 1500 ? "Zoe Quinlan" : `Pat ${word(i)}son`, email: `p${i}@acme.example`, company: "Acme", company_key: "acme",
  position: i === 1500 ? "Recruiter" : "Engineer", school: "", connected_on: null, last_seen_at: null, source_ref: `Connections.csv, row ${i}`, source_url: null, retrieved_at: "" });
const saved = Array.from({ length: 2000 }, (_, i) => rec(i + 1));
const calls: string[] = [];
const store = new Proxy({
  async named(_u: string, n: string) { calls.push(`named:${n}`); return saved.filter((p) => p.name!.toLowerCase().startsWith(n.toLowerCase())).slice(0, 200); },
  async atCompany(_u: string, k: string) { calls.push(`at:${k}`); return k === "acme" ? saved.slice(1400, 1600) : []; },
}, { get: (t: any, k) => t[k] ?? (async () => { throw new Error(`not used: ${String(k)}`); }) }) as unknown as PeopleStore;
// The thread's copy: the first 1,000 rows only.
const copy = saved.slice(0, 1000).map((p, i) => ({ file: "Connections.csv", row: i + 1, name: p.name, email: p.email, firm: "Acme", firm_raw: "Acme", company: "Acme", title: "Engineer", school: "", connected_on: null }));
const mx = async () => ({ status: "ok" as const, hosts: ["mx.acme.example"] });

Deno.test("DRAFTER/1 a saved person beyond the thread's copy is drafted to, found by name at the firm", async () => {
  const state: Record<string, unknown> = { contacts: copy, profile: { facts: [{ id: "f1", text: "BS Statistics", confirmed: true }] } };
  const r = await networkingTurn({ message: "email Zoe Quinlan at Acme about the data role", userId: U, threadId: T, now: NOW, state, store: memoryOutreachStore(), model: null, mx,
    people: { store, gmail: null, fetch } });
  eq(r?.status, "drafting_off", r?.reply);
  nodeAssert.match(r!.reply, /Zoe Quinlan.*<p1500@acme\.example>/);
  nodeAssert.ok(calls.some((c) => c.startsWith("named:") || c.startsWith("at:")), "the saved people were read");
});

Deno.test("DRAFTER/2 without the saved people (no store) the same ask finds no one: the copy alone is not the source of truth", async () => {
  const state: Record<string, unknown> = { contacts: copy, profile: { facts: [{ id: "f1", text: "BS Statistics", confirmed: true }] } };
  const r = await networkingTurn({ message: "email Zoe Quinlan at Acme about the data role", userId: U, threadId: T, now: NOW, state, store: memoryOutreachStore(), model: null, mx });
  eq(r?.status, "not_in_contacts", r?.reply);
});
