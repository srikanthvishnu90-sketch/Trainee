// Instinct: brand-new users doing real tasks end to end, on every channel, judged only by state.
//   deno run -A --no-check --import-map=tests/instinct/import-map.json tests/instinct/main.ts [options]
// Usually through tests/instinct/run.sh, which builds the tree (trunk plus a set of branches) and the environment.
//
// Options:
//   --feature apply|network|scale|all     which scenarios (default all)
//   --channels web,telegram,whatsapp,imessage
//   --apply-n 60          postings in the web mass-apply market ("apply to all of them")
//   --channel-n 6         postings in each texting channel's market
//   --emails 30           how many people the networking person asks to email
//   --scale-users 50 --scale-items 20 --scale-concurrency 8
//   --groups a,b          only these scenario groups (gold, variants, noresume, adversarial; connect, find, email, replies,
//                         calls, followup, quota; apply-scale, outreach-scale). Default: every group.
//   --out <dir>           where scorecard.json and scorecard.md go (default ./instinct-out)
//   --strict              exit 1 when any step is not PASS (default: exit 0 once a scorecard is written; 2 if the harness broke)
// deno-lint-ignore-file no-explicit-any
import { makeWorld } from "./world.ts";
import { Scorecard } from "./judge.ts";
import { workers } from "./ticks.ts";
import { type Channel, CHANNELS, everyone } from "./people.ts";
import { applyScenarios } from "./scenarios/apply.ts";
import { networkScenarios } from "./scenarios/network.ts";
import { scaleScenarios } from "./scenarios/scale.ts";

const args = Deno.args;
const opt = (name: string, d: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const flag = (name: string) => args.includes(`--${name}`);
const feature = opt("feature", "all");
const channels = opt("channels", CHANNELS.join(",")).split(",").map((s) => s.trim()).filter(Boolean) as Channel[];
const cfg = {
  applyN: Number(opt("apply-n", "60")), channelN: Number(opt("channel-n", "6")), emails: Number(opt("emails", "30")),
  scaleUsers: Number(opt("scale-users", "50")), scaleItems: Number(opt("scale-items", "20")), scaleConcurrency: Number(opt("scale-concurrency", "8")),
  channels,
  // --groups gold,variants,noresume,adversarial,connect,find,email,replies,calls,followup,quota,apply-scale,outreach-scale
  groups: new Set(opt("groups", "").split(",").map((x) => x.trim()).filter(Boolean)),
};
const out = opt("out", "instinct-out");

const card = new Scorecard();
card.meta.tree = Deno.env.get("INSTINCT_TREE_LABEL") ?? "(this checkout)";
card.meta.branches = Deno.env.get("INSTINCT_BRANCHES") ?? "trunk only";
card.meta.config = cfg;
let exit = 0;
const world = await makeWorld({ postings: [] });
card.meta.postgres_provision_ms = world.provisionMs;
const ws = workers(world);
const t0 = performance.now();
try {
  if (feature === "apply" || feature === "all") await applyScenarios(world, ws, card, cfg);
  if (feature === "network" || feature === "all") await networkScenarios(world, ws, card, cfg);
  if (feature === "scale" || feature === "all") await scaleScenarios(world, ws, card, cfg);
} catch (e) {
  console.error("INSTINCT HARNESS ERROR:", e instanceof Error ? e.stack : String(e));
  card.meta.harness_error = e instanceof Error ? e.message : String(e);
  exit = 2;
} finally {
  card.meta.wall_ms = Math.round(performance.now() - t0);
  card.meta.unexpected_hosts = world.unexpected.slice(0, 50);
  card.meta.functions_missing = [...world.missingFns];
  card.meta.function_calls = world.fnCalls.length;
  card.meta.engine_runs = ws.engineRuns;
  card.meta.fake_requests = Object.fromEntries(Object.entries(world.fakes).map(([k, f]) => [k, f.log.length]));
  await Deno.mkdir(out, { recursive: true });
  await Deno.writeTextFile(`${out}/scorecard.json`, JSON.stringify(card, null, 2));
  await Deno.writeTextFile(`${out}/scorecard.md`, card.markdown());
  // What each person said and read, in order (the evidence behind every reply check).
  await Deno.writeTextFile(`${out}/transcripts.md`, everyone.map((p) => [`## ${p.channel} ${p.contact} (${p.userId ?? "no account"})`, "",
    ...p.turns.flatMap((t) => [`> ${t.said.split("\n").join("\n> ")}`, "", t.texts.length ? t.texts.join("\n\n---\n\n") : "(nothing read)", ""])].join("\n")).join("\n\n"));
  console.log("\n" + card.markdown());
  await world.stop().catch(() => {});
}
if (world.unexpected.length) { console.error(`a scenario reached a host that is not faked: ${world.unexpected.slice(0, 5).join(", ")}`); }
const notPass = card.cards.flatMap((c) => c.steps).filter((s) => s.status !== "PASS").length;
console.log(`INSTINCT: ${card.cards.flatMap((c) => c.steps).length} steps, ${notPass} not passing. Scorecard: ${out}/scorecard.md`);
if (exit === 0 && flag("strict") && (notPass > 0 || world.unexpected.length)) exit = 1;
Deno.exit(exit);
