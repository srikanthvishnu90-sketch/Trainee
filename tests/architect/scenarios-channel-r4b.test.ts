// Channel delivery round 4 (2026-11-05), part 2: the seeded battery of scenarios-channel-r4-battery.ts (see
// scenarios-channel-r4.test.ts for the model and every invariant) over 5,000 more scenarios of:
//   - stop: the person says STOP (or START again) between runs while answers in parts, cards and updates are queued, with
//     provider faults on the way: nothing Trainee starts goes after the STOP, no answer to a message from before it;
//   - channels: a person on two channels, a channel unlinked mid-conversation (an answer bound to it moves to the other
//     channel, or fails with the reason when none is left), the home channel switched, WhatsApp's window opening again:
//     nothing to a chat that is no longer the person's, nothing twice, every part in order;
//   - quiet: quiet hours and the person's time zone changing while updates wait: nothing in quiet hours on their clock as it
//     was when the run looked, and everything goes after them.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/scenarios-channel-r4b.test.ts
import { battery } from "./scenarios-channel-r4-battery.ts";

Deno.test("channel delivery round 4 battery: STOP while parts are queued, two channels and switches, quiet hours and zone changes (5,000 scenarios)", async () => {
  await battery([["stop", 1700], ["channels", 1700], ["quiet", 1600]], "b");
});
