// WO-121/6: the capture lane is polite and bounded. At most 4 reads in flight per host; a 429 stops that host for the rest
// of the tick (others go on) and is recorded rate_limited with its Retry-After; every claimed row ends captured or unread;
// no model is reached. PENDING; DRAFT (2026-11-06): not run; no reference implementation proved it.
import assertNode from "node:assert/strict";
import { runFormLane } from "../../supabase/functions/career-form-schema/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const NOW = Date.UTC(2026, 10, 7, 12);
const GH = JSON.stringify({ questions: [{ label: "Email", required: true, fields: [{ name: "email", type: "input_text", values: [] }] }] });
const LEVER = `<form><div class="application-label">Full name</div><input name="name" required><div class="application-label">Email</div><input name="email" required><input type="file" name="resume"></form>`;

Deno.test("WO-121/6 1,000 todo rows over three hosts: <= 4 in flight per host; one host's 429 stops only that host; every row ends", async () => {
  const todo = Array.from({ length: 1000 }, (_, i) => {
    const kind = i % 3;
    if (kind === 0) return { job_id: `greenhouse:b${i}:${i}`, provider: "greenhouse", board: `b${i}`, ats_id: String(i), url: `https://job-boards.greenhouse.io/b${i}/jobs/${i}`, first_seen_at: new Date(NOW - i * 1000).toISOString() };
    if (kind === 1) { const id = `0130d854-9bae-48d4-8ef0-${String(i).padStart(12, "0")}`; return { job_id: `lever:b${i}:${id}`, provider: "lever", board: `b${i}`, ats_id: id, url: `https://jobs.lever.co/b${i}/${id}`, first_seen_at: new Date(NOW - i * 1000).toISOString() }; }
    return { job_id: `smartrecruiters:b${i}:${i}`, provider: "smartrecruiters", board: `b${i}`, ats_id: String(i), url: `https://jobs.smartrecruiters.com/B${i}/${i}`, first_seen_at: new Date(NOW - i * 1000).toISOString() };
  });
  const inFlight = new Map<string, number>(), peak = new Map<string, number>();
  let leverCalls = 0, smartCalls = 0;
  const fetch = async (u: string | URL | Request) => {
    const host = new URL(String(u)).hostname;
    if (/smartrecruiters/.test(host)) smartCalls++;
    inFlight.set(host, (inFlight.get(host) ?? 0) + 1);
    peak.set(host, Math.max(peak.get(host) ?? 0, inFlight.get(host)!));
    await new Promise((r) => setTimeout(r, 1));
    inFlight.set(host, inFlight.get(host)! - 1);
    if (host === "jobs.lever.co") { leverCalls++; if (leverCalls === 20) return new Response("", { status: 429, headers: { "retry-after": "120" } }); return new Response(LEVER, { status: 200 }); }
    return new Response(GH, { status: 200 });
  };
  const written: any[] = [];
  const out = await runFormLane({
    todo: async () => todo, put: async (rows: any[]) => { written.push(...rows); return rows.length; },
    fetch: fetch as any, now: () => NOW, perHost: 4, gapMs: 0, ashbyGraphql: false, deadlineMs: 60_000,
  });
  for (const [h, n] of peak) assert(n <= 4, `${h}: peak ${n} in flight`);
  eq(smartCalls, 0, "SmartRecruiters is recorded needs_partner_key without a request");
  assert(leverCalls <= 20 + 3, `Lever stopped for the tick after its 429 (calls ${leverCalls}, at most the 3 already in flight)`);
  const lever = written.filter((r) => r.provider === "lever");
  assert(lever.some((r) => r.state === "unread" && r.unread === "rate_limited"), "the 429 is recorded");
  eq(written.filter((r) => r.provider === "greenhouse" && r.state === "captured").length, todo.filter((t) => t.provider === "greenhouse").length, "Greenhouse went on");
  for (const r of written) assert(r.state === "captured" || r.state === "unread", `${r.job_id}: ${r.state}`);
  eq(out.model_calls, 0);
  // Lever rows not read this tick are left for the next one (not written as unread), so a stop is never a verdict.
  assert(written.length + out.left_for_next_tick === todo.length, "every row is written or left for the next tick");
});
