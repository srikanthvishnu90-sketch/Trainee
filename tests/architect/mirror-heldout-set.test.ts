// MIRROR HELD-OUT (P2, docs/architect/specs/MIRROR-RULINGS.md), the set itself (architect, 2026-11-11). $0, no database, no
// model. Pins: the committed files are a fresh deterministic build; the held-out file is the sealed one (README.md's sha256)
// and a changed copy is refused; 1,000 conversations in the ruling families, about 3,000 turns, split dev 5% / held-out 95% per family (owner, 2026-11-11), every family and ruling with dev turns; every
// turn and setup turn is live-safe (evals/mirror/safety.ts); every turn carries an expectation from the rulings, and every
// ruling G1 to G14 is exercised. Distinctness (evals/mirror/distinct.ts over the whole set, about 4 minutes) is run by
// `deno run -A evals/mirror/heldout/generate.ts --check`; the build itself redraws any conversation within 0.4 Jaccard or
// 0.75 edit ratio of one already accepted, below distinct.ts's own 0.5 and 0.8.
//   deno test -A --no-check tests/architect/mirror-heldout-set.test.ts
import assertNode from "node:assert/strict";
import { unsafeReasons } from "../../evals/mirror/safety.ts";
import { build, type Conversation, DEV_PATH, devCounts, FAMILIES, HELDOUT_PATH, jsonl, loadSplit, sealInReadme, sha256 } from "../../evals/mirror/heldout/generate.ts";
import { RULINGS } from "../../evals/mirror/heldout/expect.ts";

const read = (p: string) => Deno.readTextFileSync(p);
const parse = (t: string): Conversation[] => t.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

Deno.test("HO-1 the committed set is a fresh build, and the held-out file is the sealed one", async () => {
  const { dev, heldout } = await build();
  assertNode.equal(read(DEV_PATH), jsonl(dev), "dev.jsonl is not a fresh build of generate.ts");
  assertNode.equal(read(HELDOUT_PATH), jsonl(heldout), "heldout.jsonl is not a fresh build of generate.ts");
  assertNode.equal(await sealInReadme(), await sha256(read(HELDOUT_PATH)), "README.md's seal is not heldout.jsonl's sha256");
});

Deno.test("HO-2 a changed held-out file is refused", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const p = `${dir}/heldout.jsonl`;
    await Deno.writeTextFile(p, read(HELDOUT_PATH).replace("HO-", "HX-"));
    await assertNode.rejects(() => loadSplit(p), /not the sealed held-out set/);
    assertNode.ok((await loadSplit(HELDOUT_PATH)).length > 0);
  } finally { await Deno.remove(dir, { recursive: true }); }
});

Deno.test("HO-3 1,000 conversations in the ruling families, split 5/95, every turn live-safe and expected", () => {
  const dev = parse(read(DEV_PATH)), ho = parse(read(HELDOUT_PATH)), all = [...dev, ...ho];
  assertNode.equal(all.length, 1000);
  const turns = all.flatMap((c) => c.turns);
  assertNode.ok(turns.length >= 2800 && turns.length <= 3200, `${turns.length} turns`);
  assertNode.equal(new Set(all.map((c) => c.id)).size, 1000);
  assertNode.equal(dev.length, 50, "dev is 5% of the set");
  const quota = devCounts();
  for (const [fam, n] of Object.entries(FAMILIES)) {
    assertNode.equal(all.filter((c) => c.family === fam).length, n, fam);
    assertNode.equal(dev.filter((c) => c.family === fam).length, quota[fam], `${fam} dev share`);
    assertNode.ok(quota[fam] >= 2, `${fam} has fewer than 2 dev conversations`);
  }
  const devTurns = dev.flatMap((c) => c.turns);
  for (const g of RULINGS) assertNode.ok(devTurns.some((t) => t.expect.rulings.includes(g)), `${g} has no dev turn`);
  assertNode.ok(dev.every((c) => c.split === "dev") && ho.every((c) => c.split === "heldout"));
  for (const c of all) {
    for (const t of [...c.turns.map((x) => x.prompt), ...c.setup.turns]) {
      assertNode.deepEqual(unsafeReasons({ prompt: t, setup: { turns: [], state: {} }, stop_before_action: false }), [], `${c.id}: ${t}`);
    }
    for (const t of c.turns) {
      assertNode.ok(t.expect.rulings.includes("G1") && t.expect.process.nothing_sent, `${t.id} has no G1 expectation`);
      if (t.expect.rulings.includes("G8")) assertNode.ok(t.expect.process.must_not_offer.length > 0, `${t.id}: a hypothetical with no record writers withheld`);
      if (t.expect.rulings.includes("G6")) assertNode.ok(t.expect.honesty.boundary_line && t.expect.process.nothing_queued, `${t.id}: a boundary with no boundary line`);
      if (t.expect.rulings.includes("G11")) assertNode.ok(t.expect.process.artifact, `${t.id}: a file ask with no artifact`);
    }
  }
  for (const g of RULINGS) assertNode.ok(turns.filter((t) => t.expect.rulings.includes(g)).length >= 50, `${g} is exercised by fewer than 50 turns`);
});
