// WORD-VOMIT, the test world (eval only, never product code). The response world (tests/architect/helpers/response_world.ts:
// every migration on a throwaway Postgres 16, the real career handler over the PostgREST double, every other host refused and
// recorded) plus what a messy message needs to have something to act on:
//   postings   six fictional internships with Greenhouse job links (board "wv"), beside the response world's four.
//   person     "resume": "confirmed" seeds a confirmed resume file (tests/flow/resume-seed.ts) and a handful of confirmed
//              profile facts (school, major, graduation, skills, one job), all fictional; "none" has nothing on file.
//   offer      "offer": n prepares n applications for the first n wv postings (the same payload builder the apply tests use,
//              tests/architect/scenarios-apply-r3-battery.ts payloadOf), so the setup search ends with the one yes question
//              (D-MS-1) and a later "yeah do it" has a real batch to approve or not.
// Names, schools and contact details are fictional; links point at boards.greenhouse.io/wv, which the world never fetches.
import { openWorld, type World } from "../../tests/architect/helpers/response_world.ts";
import { confirmedResumeSql } from "../../tests/flow/resume-seed.ts";
import { payloadOf, RESUME_A } from "../../tests/architect/scenarios-apply-r3-battery.ts";

export const WV_POSTINGS = [
  { id: "greenhouse:wv:4101", company: "Bluestem Analytics", title: "Data Analyst Intern", loc: "Chicago, IL", d: "Summer 2027 internship. SQL, Python, Tableau dashboards for retail clients. Pay: $28 - $32 per hour." },
  { id: "greenhouse:wv:4102", company: "Harborlight Health", title: "Data Analytics Intern", loc: "Remote, US", d: "Remote internship. SQL and Excel reporting on patient-access data. Pay: $25 per hour." },
  { id: "greenhouse:wv:4103", company: "Copperline Logistics", title: "Business Analyst Intern", loc: "Chicago, IL", d: "Hybrid, three days onsite. Excel, SQL, process mapping." },
  { id: "greenhouse:wv:4104", company: "Meridian Robotics", title: "Software Engineering Intern", loc: "Austin, TX", d: "Summer 2027. Python and C++ for robot fleet tooling." },
  { id: "greenhouse:wv:4105", company: "Fernway Media", title: "Marketing Analyst Intern", loc: "New York, NY", d: "Campaign analytics, SQL, Looker." },
  { id: "greenhouse:wv:4106", company: "Quarry Lane Capital", title: "Finance Intern", loc: "Chicago, IL", d: "FP&A internship. Excel modeling, variance analysis." },
];
export const wvUrl = (id: string) => `https://boards.greenhouse.io/wv/jobs/${id.split(":")[2]}`;

// The fictional person's confirmed facts (what the brain may say about them; anything else would be invented, D-007).
export const FACTS = [
  ["education", "B.S. Statistics, Lakeshore State University, expected graduation May 2027"],
  ["experience", "Research Assistant, Lakeshore State Economics Lab (Sep 2025 to present): cleaned survey data in Python and R"],
  ["experience", "Cashier, Greenleaf Market (2023 to 2025)"],
  ["skill", "Python, SQL, Excel, Tableau"],
  ["location", "Lives in Chicago, IL"],
];

const lit = (v: string) => { const t = `q${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`; return `$${t}$${v}$${t}$`; };

export type CaseState = { resume: "confirmed" | "none"; offer?: number };

export async function openWordVomitWorld(people: number, opts: { model?: (req: Request) => Promise<Response> | Response } = {}): Promise<World & { personFor(s: CaseState): ReturnType<World["person"]> }> {
  const w = await openWorld(people, opts);
  const now = Date.now(), DAY = 86_400_000, iso = (ms: number) => new Date(ms).toISOString();
  for (const [i, p] of WV_POSTINGS.entries()) {
    await w.pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, posted_at, first_seen_at, last_seen_at)
      values (${lit(p.id)}, 'greenhouse', 'wv', ${lit(p.company)}, ${lit(p.title)}, ${lit(p.loc)}, ${lit(wvUrl(p.id))}, ${lit(p.d)}, '${iso(now - (i + 1) * DAY)}', '${iso(now - (i + 1) * DAY)}', '${iso(now)}')`);
  }
  let ver = 0;
  const personFor = async (s: CaseState) => {
    const p = await w.person({ resume: false });
    if (s.resume === "confirmed") {
      await w.pg.sql(`${confirmedResumeSql(p.id, RESUME_A)}
        insert into public.career_resume_devices (user_id, sha256, at) values ('${p.id}', encode(sha256(convert_to(${lit(RESUME_A)}, 'UTF8')), 'hex'), now());`);
      // The seeded file holds one fact; add the person's other confirmed facts to the same stored profile.
      const facts = FACTS.map(([kind, text], k) => ({ id: `wv-fact-${k}`, kind, status: "confirmed", needs_confirmation: false, confirmation_event_id: `seed-resume-${p.id.slice(-12)}`, text }));
      await w.pg.sql(`update public.agent_flow_state set state = jsonb_set(state, '{career,stores,profile,facts}', (state->'career'->'stores'->'profile'->'facts') || ${lit(JSON.stringify(facts))}::jsonb) where user_id = '${p.id}'`);
    }
    if (s.offer) {
      const sha = (await w.pg.sql(`select encode(sha256(convert_to(${lit(RESUME_A)}, 'UTF8')), 'hex')`)).trim();
      for (const post of WV_POSTINGS.slice(0, s.offer)) {
        // deno-lint-ignore no-explicit-any
        const payload: any = payloadOf({ spec: { company: post.company }, jobId: post.id, url: wvUrl(post.id) } as any, { expiresIn: 3600_000, stamp: "current", fields: [], quarantine: "current" } as any, ++ver, { epoch: 0, version: 0, authority: 0 }, Date.now(), p.id, sha);
        await w.pg.sql(`insert into public.career_apply_prepared (user_id, job_id, company, url, payload, payload_hash, card_lines, state)
          select '${p.id}', ${lit(post.id)}, ${lit(post.company)}, ${lit(wvUrl(post.id))}, x.p, public.career_apply_payload_hash(x.p), array[${lit(post.company)}]::text[], 'ready' from (select ${lit(JSON.stringify(payload))}::jsonb as p) x`);
      }
    }
    return p;
  };
  return { ...w, personFor };
}
