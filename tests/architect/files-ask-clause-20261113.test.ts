// Review of PR #803 (D-072 follow-up), then of PR #805: familyAskOf holds the turn to opening the File, so it FAILS CLOSED. It is an
// allowlist of whole-message shapes (file_family_ask.ts); any other word anywhere is null. $0: no model, no network.
//   FC-1  THE TEN REGRESSIONS of #803: the five whose whole message is a see-shape (a closed tail, or a closed "can't reach it"
//         clause) are File asks again; the five with a free second clause ("so I can prepare", "for the design role") are null.
//   FC-2  A SEE-ASK WITH ANOTHER CLAUSE: a File ask only when that clause is on the closed "can't reach it" list; else null.
//   FC-3  AN OPT-OUT WORDED WITH A SEE-VERB ELSEWHERE is null, and so is a new thing to make.
//   FC-4  "MAKE ME MY WEEKLY BRIEF": make and build are not see verbs: null (the brain still has the tool, unforced).
//   FC-5  GENUINELY MIXED messages are null.
//   The full corpus is tests/architect/files-ask-failclosed-20261113.test.ts.
//   deno test -A --no-check tests/architect/files-ask-clause-20261113.test.ts
import assertNode from "node:assert/strict";
import { familyAskOf } from "../../supabase/functions/_shared/file_family_ask.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const each = (rows: [string, string | null][]) => { for (const [m, f] of rows) eq(familyAskOf(m), f, m); };

Deno.test("FC-1 THE TEN REGRESSIONS of #803: a File ask when the whole message is a see-shape, null with a free second clause", () => each([
  ["Where's my weekly brief? I can't find the link", "F-14"],
  ["can't open my career brief, send me the link", "F-01"],
  ["send me the weekly brief link, the old one doesn't work", "F-14"],
  ["show me my weekly brief by end of day", "F-14"],
  ["show me my offers page, don't summarize", null],
  ["show me my negotiation plan again, the link won't load", "F-14n"],
  ["show me my interview hub so I can prepare", null],
  ["show me my career brief before I make a decision", null],
  ["show me my search plan so I can start applying", null],
  ["show me my materials page for the design role", null],
]));

Deno.test("FC-2 A SEE-ASK with another clause is a File ask only when the clause is a closed can't-reach-it statement", () => each([
  ["don't forget to send me my weekly brief", null],
  ["I didn't get my weekly brief, send it again", "F-14"],
  ["I can't find my interview hub", "F-13"],
  ["make sure to send me my weekly brief", null],
  ["show me my career brief, not the weekly one", null],
  ["send me my weekly brief so I can plan my week", null],
  ["open my interview hub, I need to practice", null],
  ["show me my resume versions", "F-07"],
  ["I stopped by to see my offer comparison", null],
  ["pull up my answer library before I start the next application", null],
  ["show me my interviews page so I can prepare", null],
  ["my search plan link doesn't open", "F-04"],
  ["show me my weekly brief, don't summarize it", null],
]));

Deno.test("FC-3 AN OPT-OUT worded with a see-verb elsewhere stays an opt-out, and a new thing to make stays the planning turn's", () => each([
  ["stop sending the weekly brief, I'll open it myself", null],
  ["don't show me the weekly brief again", null],
  ["I don't want the weekly brief anymore, where do I turn it off", null],
  ["the weekly brief is too much, stop sending it", null],
  ["show me how to turn off the weekly brief", null],
  ["send me the link to unsubscribe from the weekly digest", null],
  ["I've seen my weekly brief, no more of those please", null],
  ["my weekly brief, please stop", null],
  ["the weekly brief page needs to stop", null],
  ["weekly brief emails off", null],
  ["I opened the weekly brief link and I don't want it", null],
  ["can you not send me the weekly brief", null],
  ["I can't stop getting the weekly brief, send help", null],
  ["give me a way to mute the weekly summary", null],
  ["open my settings and cancel the weekly report", null],
  ["send me my weekly brief and then stop sending it", null],
  ["resume my weekly brief", null],
  ["show me my search plan and draft a new one", null],
  ["open my career brief and write me a new version", null],
  ["help me prepare my negotiation plan", null],
  ["start a search plan for me, show me when done", null],
]));

Deno.test("FC-4 MAKE ME MY WEEKLY BRIEF: make and build are not see verbs, so nothing is held to the tool", () => each([
  ["make me my weekly brief", null],
  ["build my career brief", null],
  ["make me my search plan", null],
  ["make me a weekly brief for my manager", null],
  ["make me my weekly brief for consulting", null],
]));

Deno.test("FC-5 GENUINELY MIXED messages are null", () => each([
  ["don't send me the weekly brief every week, just show it to me now", null],
  ["stop. show me my weekly brief", null],
  ["I don't see my weekly brief anywhere", null],
  ["after I change jobs show me my career brief", null],
  ["show me my weekly brief and turn it off after", null],
]));
