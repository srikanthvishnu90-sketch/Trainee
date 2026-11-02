// WHOLE JOURNEYS, ROUND 2: one slice of the seeded journeys (each journeys-r2-*.test.ts file runs one), groups of people
// interleaved in their own database. JR2_PER_SLICE journeys per slice (default below), JR2_GROUP people per database,
// JR2_ONLY=<journey index>[,<index>...] replays those journeys alone.
import assertNode from "node:assert/strict";
import { pgBinDir } from "../flow/pg.ts";
import { CI, startWorld, tokenOf, uidOf } from "./scenarios/journeys-r2-world.ts";
import { journey, rng, Runner, type RunStats } from "./scenarios/journeys-r2-run.ts";

export const SEED = 20261102;
export function runSlice(name: string, index: number) {
  const PER = Number(Deno.env.get("JR2_PER_SLICE") || 50); // CI: 8 slices x 50 (about 2.5 min each); the full round (2,000) is JR2_PER_SLICE=250
  const GROUP = Number(Deno.env.get("JR2_GROUP") || 6);
  const ONLY = Deno.env.get("JR2_ONLY");
  Deno.test({
    name: `whole journeys round 2, slice ${name}: ${PER} seeded journeys through the real handlers on Postgres, every invariant after every step`,
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
      if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
      const started = Date.now();
      const first = index * PER;
      const all = ONLY ? ONLY.split(",").map(Number) : Array.from({ length: PER }, (_, k) => first + k);
      const tokens: Record<string, string> = {};
      for (const j of all) tokens[tokenOf(j)] = uidOf(j);
      const w = await startWorld({ tokens });
      const total: RunStats = { journeys: 0, steps: 0, turns: 0, findings: [], byAction: {}, deleted: 0, confirmed: 0, applied: 0, emailed: 0, approvedApps: 0, approvedEmails: 0 };
      try {
        for (let g = 0; g < all.length; g += GROUP) {
          const ids = all.slice(g, g + GROUP);
          const runner = new Runner(w, SEED);
          w.people.length = 0;
          const group = [];
          for (const [slot, j] of ids.entries()) {
            const jj = journey(SEED, j);
            group.push({ j, p: await w.addPerson(j, slot), steps: jj.steps, plan: jj.plan });
          }
          await runner.run(group, rng(SEED + g));
          const s = runner.stats;
          total.journeys += s.journeys; total.steps += s.steps; total.turns += s.turns; total.deleted += s.deleted; total.applied += s.applied; total.emailed += s.emailed;
          total.approvedApps += s.approvedApps; total.approvedEmails += s.approvedEmails;
          total.findings.push(...s.findings);
          for (const [k, v] of Object.entries(s.byAction)) total.byAction[k] = (total.byAction[k] ?? 0) + v;
        }
      } finally {
        await w.stop();
      }
      const byKey = new Map<string, typeof total.findings>();
      for (const f of total.findings) {
        const key = `${f.inv} ${f.action}: ${f.why.replace(/[0-9a-f]{12,}|\d{2,}/g, "#").slice(0, 110)}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key)!.push(f);
      }
      const lines = [...byKey.entries()].sort((a, b) => b[1].length - a[1].length).flatMap(([k, xs]) => [`  ${xs.length}x ${k}`,
        ...xs.slice(0, 2).map((x) => `      journey ${x.journey} step ${x.step}: ${x.why.slice(0, 500)}\n        ${x.trail.join("\n        ")}`)]);
      console.log(`[journeys-r2 ${name}] ${total.journeys} journeys, ${total.steps} steps, ${total.turns} turns, ${total.deleted} deleted, ${total.applied} queued to apply, ${total.approvedApps} applications approved, ${total.approvedEmails} emails approved, ${total.emailed} emails sent, ${new Set(total.findings.map((f) => f.journey)).size} journeys with findings, ${Math.round((Date.now() - started) / 1000)} s`);
      console.log(`[journeys-r2 ${name}] steps: ${JSON.stringify(total.byAction)}`);
      assertNode.deepStrictEqual(lines, [], `\n${lines.slice(0, 60).join("\n")}`);
    },
  });
}
