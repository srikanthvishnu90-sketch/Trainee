// Release-verification loops (docs/architect/VERIFICATION-15.md, items 8 to 13): each loop runs a battery through the real
// handler and prints ONE line a person or CI log search can read:
//
//   LOOP item=8 name=discovery cases=23 shown=41 invented=0 dead=0 ... bar="invented+dead == 0" result=PASS
//
// and, when LOOP_OUT names a directory, writes the same numbers and every case's transcript to <dir>/loop-<item>.json so a
// PR body can quote the run. Nothing here decides a pass: each loop asserts its own bar.
export interface LoopCase { id: string; asked: string; reply: string; intent: string | null; faults: string[] }
export interface LoopResult { item: number; name: string; file?: string; numbers: Record<string, number | string>; bar: string; pass: boolean; cases: LoopCase[] }

export async function reportLoop(r: LoopResult) {
  const nums = Object.entries(r.numbers).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`LOOP item=${r.item} name=${r.name} ${nums} bar="${r.bar}" result=${r.pass ? "PASS" : "FAIL"}`);
  for (const c of r.cases.filter((c) => c.faults.length)) console.log(`LOOP-FAULT item=${r.item} case=${c.id} ${c.faults.join("; ")}`);
  const dir = Deno.env.get("LOOP_OUT");
  if (dir) {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/loop-${r.file ?? r.item}.json`, JSON.stringify(r, null, 2));
  }
}
